/**
 * The state engine (stage 4-3, `.claude/rules/records.md`): the only way a
 * record's server-sourced values (state, assignee, due…) change. It does
 * exactly five things (ontology §17.7, 案 B) and nothing else:
 *
 *   1. may the action start from the current state?
 *   2. may this actor do it (the type's `who`)?
 *   3. write the new state AND its ledger entry together (one transaction,
 *      optimistic concurrency on the record's version)
 *   4. tell whom the action names (the push channel: kind + version only)
 *   5. on a milestone, append a line to the record file's 「経緯」 (the
 *      server's own commit, through the push checker)
 *
 * No expressions, computed values, cascades, timers or outside sends: an
 * action's arguments are copied into the fields they name, `hand_to` copies
 * one person into `next_actor`, and that is all the engine computes.
 *
 * The ledger is append-only: an undo is a new entry reversing an earlier
 * one. Every entry carries before/after values of each field it changed, so
 * any version of a record can be replayed (shared/core/record-ledger.ts).
 */
import { FULL_ACCESS_ROLES, findPrivateScope } from '../../shared/core/permissions'
import { isSameOrAncestorPath, normalizeRepoPath } from '../../shared/core/paths'
import type { ActionDef, FieldKind, TypeDefinition } from '../../shared/core/record-types'
import {
  replayRecordState, type DecisionMaterial, type LedgerAttachment, type LedgerChange, type LedgerDecision, type LedgerEntry,
  type LedgerValue, type ReplayedState,
} from '../../shared/core/record-ledger'
import { fileLinkPath, newRecordId, RECORD_ID_RE } from '../../shared/core/records'
import type { RecordSummary } from '../../shared/types/records'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RecordFileRepo, RecordFileWriter } from '../ports/record-files'
import type { RecordLinkRow, RecordRepository, RecordRow } from '../ports/records'
import type { Transactions } from '../ports/transactions'
import { logError } from '../lib/error-log'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'
import { recordReader, type RecordReader } from './record-access'
import { currentTypes } from './record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED, recordSummaries } from './records'

export interface RecordEngineDeps {
  companyData: CompanyDataSource
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
  files: RecordFileWriter
  /** Department folders the member manages (`dept_manager` in `who`). */
  managedFolders: (companyId: string, userId: string) => string[]
  isMember: (companyId: string, userId: string) => boolean
  /** Tell these members their 「あなたの番」 may have changed (push channel; kind + version only). */
  notify: (companyId: string, userIds: string[]) => void
}

/**
 * Who is acting, decided by the route from the credential (records.md "Who
 * is acting"): the member's session → human; a record token → their AI. A
 * body field saying otherwise is ignored.
 */
export interface ActorInput {
  kind: 'human' | 'ai'
  /** For an AI: which one (the agent the token was issued for). */
  source?: string
}

const NOTE_MAX = 2000
const TEXT_MAX = 500
const LONG_TEXT_MAX = 5000

const conflict = (error: string, code: string, extra: Record<string, unknown> = {}) => refuse('conflict', error, { code, ...extra })
const bad = (error: string, code = 'BAD_REQUEST') => refuse('bad-request', error, { code })

/** A value for a field of `kind`, or an error text. */
function checkValue(kind: FieldKind, value: unknown, options: string[] | undefined, isMember: (id: string) => boolean): LedgerValue | { error: string } {
  if (value === null) return null
  switch (kind) {
    case 'text':
    case 'long_text': {
      const max = kind === 'text' ? TEXT_MAX : LONG_TEXT_MAX
      return typeof value === 'string' && value.length <= max ? value.normalize('NFC') : { error: `${max} 文字までの文字で入れてください` }
    }
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? value : { error: '数で入れてください' }
    case 'boolean': return typeof value === 'boolean' ? value : { error: 'true か false で入れてください' }
    case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : { error: 'YYYY-MM-DD の日付で入れてください' }
    case 'datetime': return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : { error: '日時で入れてください' }
    case 'choice': return typeof value === 'string' && (options ?? []).includes(value) ? value : { error: `${(options ?? []).join(' / ')} のどれかです` }
    case 'person': return typeof value === 'string' && value.length <= 200 && isMember(value) ? value : { error: 'この会社のメンバーの id で入れてください' }
    case 'record': return typeof value === 'string' && RECORD_ID_RE.test(value) ? value : { error: '記録の id で入れてください' }
  }
}

/** May `member` (acting as `actor`) do an action whose `who` is this, on a record with these values? */
export function mayAct(who: string[], member: Member, actor: ActorInput, values: Record<string, LedgerValue>, managesPlace: boolean): boolean {
  if (actor.kind === 'ai' && !who.includes('ai')) return false
  const people = who.filter(w => w !== 'ai')
  // `ai` alone: any member's AI may do it.
  if (people.length === 0) return actor.kind === 'ai'
  return people.some(w =>
    w === 'anyone' ||
    (w === 'admin' && FULL_ACCESS_ROLES.has(member.role)) ||
    (w === 'dept_manager' && managesPlace) ||
    values[w] === member.userId)
}

function parseMaterials(raw: unknown): DecisionMaterial[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 20) return 'materials: up to 20'
  const out: DecisionMaterial[] = []
  for (const m of raw as Array<Record<string, unknown>>) {
    if (m?.kind === 'file' && typeof m.path === 'string' && typeof m.commit === 'string' && /^[0-9a-f]{40,64}$/.test(m.commit) && fileLinkPath(m.path)) {
      out.push({ kind: 'file', path: fileLinkPath(m.path) as string, commit: m.commit })
    } else if (m?.kind === 'record' && typeof m.id === 'string' && RECORD_ID_RE.test(m.id) && Number.isInteger(m.version) && (m.version as number) >= 1) {
      out.push({ kind: 'record', id: m.id, version: m.version as number })
    } else return 'materials: { kind: file, path, commit } or { kind: record, id, version }'
  }
  return out
}

const REF_RE = /^[a-z][a-z0-9_]{0,39}-[0-9a-z]{6,32}@[1-9]\d{0,9}$/

export function createRecordEngine(deps: RecordEngineDeps) {
  const { companyData, transactions, clock } = deps

  function open(member: Member): { records: RecordRepository; reader: RecordReader } | null {
    const handle = companyData.forCompany(member.companyId)
    if (!handle.records.settings().enabled) return null
    return { records: handle.records, reader: recordReader(member, handle.scopes.listWithRules()) }
  }

  /** The repository and repository-relative path of a record's file. */
  function fileOf(member: Member, row: RecordRow): { repo: RecordFileRepo; path: string } | null {
    if (row.path === null) return null
    const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
    const priv = findPrivateScope(scopes, row.path)
    if (priv && priv.repoId) return { repo: { kind: 'scope', repoId: priv.repoId }, path: row.path.slice(priv.path.length + 1) }
    return { repo: { kind: 'company' }, path: row.path }
  }

  function stateOf(records: RecordRepository, row: RecordRow, def: TypeDefinition) {
    const s = records.states([row.id])[0]
    let fields: Record<string, LedgerValue> = {}
    try { fields = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { fields = {} }
    return { version: s?.version ?? 0, state: s ? s.state : def.initial, fields }
  }

  function historyLine(member: Member, row: RecordRow, label: string, actor: ActorInput, note: string, at: string) {
    const file = fileOf(member, row)
    if (!file) return
    // Facts by the machine, a few words by a person: no names in files (13.10) — the member's id.
    const line = `${at.slice(0, 10)} ${label}（${member.userId}${actor.kind === 'ai' ? '・AI 経由' : ''}）${note ? `：${note.slice(0, 200)}` : ''}`
    deps.files.appendHistoryLine(member.companyId, file.repo, file.path, line)
      .catch(err => logError('records', 'Writing the history line failed', err, { company: member.companyId }))
  }

  function tell(member: Member, userIds: Array<LedgerValue | undefined>) {
    const to = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && u !== member.userId))]
    if (to.length > 0) {
      try { deps.notify(member.companyId, to) } catch { /* the 60 s check catches up */ }
    }
  }

  const summaryOf = (records: RecordRepository, id: string) => recordSummaries(records, records.byIds([id])).get(id) as RecordSummary

  return {
    /**
     * A record that lives on the server (types with storage `server` or
     * `either`; a file-backed record is created by writing its file).
     */
    create(member: Member, actor: ActorInput, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (typeof b.type !== 'string') return bad('type is required')
      const def = currentTypes(records).get(b.type)?.definition
      if (!def) return bad('Unknown type', 'TYPE_UNKNOWN')
      if (def.storage === 'file') return bad('Records of this type are files: create the file', 'FILE_RECORD')
      if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > 200) return bad('title: 1–200 characters')
      if (b.summary !== undefined && (typeof b.summary !== 'string' || b.summary.length > 300)) return bad('summary: up to 300 characters')
      let folder: string | null = null
      if (b.folder !== undefined && b.folder !== null) {
        const f = typeof b.folder === 'string' ? normalizeRepoPath(b.folder) : null
        if (!f) return bad('folder must be a company path')
        const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
        // Server-only records outside private folders for now (their links and reads assume a public place).
        if (findPrivateScope(scopes, f)) return bad('A server-only record cannot be placed in a private folder yet', 'PRIVATE_PLACE')
        if (!reader.record({ id: '', type: def.name, scopeId: null, path: null, folder: f })) return refuse('forbidden', 'You cannot read that folder')
        folder = f
      }
      const isMember = (id: string) => deps.isMember(member.companyId, id)
      const fields: Record<string, LedgerValue> = {}
      const rawFields = (b.fields ?? {}) as Record<string, unknown>
      if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) return bad('fields must be an object')
      for (const [name, value] of Object.entries(rawFields)) {
        const f = def.fields[name]
        if (!f || f.source !== 'server') return bad(`${name} is not a server field of ${def.name}`)
        const v = checkValue(f.kind, value, f.options, isMember)
        if (v !== null && typeof v === 'object') return bad(`${name}: ${v.error}`, 'BAD_VALUE')
        fields[name] = v
      }
      if (def.implements.includes('request')) {
        fields.requested_by ??= member.userId
        fields.next_actor ??= fields.assignee ?? null
      }
      const links: RecordLinkRow[] = []
      const rawLinks = (b.links ?? {}) as Record<string, unknown>
      if (typeof rawLinks !== 'object' || rawLinks === null || Array.isArray(rawLinks)) return bad('links must be an object')
      const id = newRecordId(def.name, deps.ids.newToken().slice(0, 16))
      for (const [name, value] of Object.entries(rawLinks)) {
        const l = def.links[name]
        if (!l) return bad(`${name} is not a link of ${def.name}`)
        const targets = Array.isArray(value) ? value : [value]
        if (targets.length > 50) return bad('At most 50 targets per link')
        for (const t of targets) {
          if (l.target === 'file') {
            const p = typeof t === 'string' ? fileLinkPath(t) : null
            if (!p) return bad(`${name}: a company path`)
            links.push({ sourceId: id, name, position: links.length, targetId: null, targetPath: p })
          } else {
            if (typeof t !== 'string' || !RECORD_ID_RE.test(t)) return bad(`${name}: a record id`)
            links.push({ sourceId: id, name, position: links.length, targetId: t, targetPath: null })
          }
        }
      }
      const at = clock.now()
      const changes: LedgerChange[] = [
        { field: 'state', before: null, after: def.initial },
        ...Object.entries(fields).filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
      ]
      const entry: LedgerEntry = {
        recordId: id, version: 1, action: 'create', fromState: null, toState: def.initial, actorId: member.userId, actorKind: actor.kind,
        actorSource: actor.source ?? null, at, note: '', changes, attachments: [], decision: null, isDecision: false,
        typeVersion: def.version, reversesVersion: null,
      }
      transactions.run(() => {
        records.upsert({
          id, type: def.name, typeVersion: def.version, scopeId: null, path: null, folder,
          title: b.title as string, summary: typeof b.summary === 'string' ? b.summary : '', createdAt: at, updatedAt: at, removedAt: null,
        })
        records.replaceLinks(id, links)
        if (!records.writeState({ recordId: id, state: def.initial, fields: JSON.stringify(fields), version: 1, updatedAt: at }, 0)) throw new Error('record id taken')
        records.appendLedger(entry)
      })
      tell(member, [fields.next_actor, fields.assignee])
      return ok({ record: summaryOf(records, id), entry })
    },

    /** Run an action of the record's type. */
    async act(member: Member, actor: ActorInput, recordId: string, actionName: string, body: unknown): Promise<Outcome<{ record: RecordSummary; entry: LedgerEntry }>> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      const action: ActionDef | undefined = Object.prototype.hasOwnProperty.call(def.actions, actionName) ? def.actions[actionName] : undefined
      if (!action) return refuse('not-found', 'この操作はありません', { code: 'ACTION_NOT_FOUND' })

      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)

      const current = stateOf(records, row, def)
      // Duty 1: from the current state?
      if (action.from && (current.state === null || !action.from.includes(current.state))) {
        return conflict('いまの状態ではこの操作はできません', 'ACTION_NOT_ALLOWED_IN_STATE', { state: current.state })
      }
      // Duty 2: who?
      const place = row.path ?? row.folder ?? ''
      const managesPlace = action.who.includes('dept_manager') && deps.managedFolders(member.companyId, member.userId).some(f => isSameOrAncestorPath(f, place))
      if (!mayAct(action.who, member, actor, current.fields, managesPlace)) {
        return refuse('forbidden', actor.kind === 'ai' && !action.who.includes('ai')
          ? 'この操作は AI からはできません。本人が画面から行ってください'
          : 'この操作をする権限がありません', { code: 'NOT_ALLOWED' })
      }
      if (action.note === 'required' && note.trim() === '') return bad('この操作にはひとことのメモが要ります', 'NOTE_REQUIRED')

      const isMember = (id: string) => deps.isMember(member.companyId, id)
      const rawArgs = (b.args ?? {}) as Record<string, unknown>
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return bad('args must be an object')
      for (const k of Object.keys(rawArgs)) if (!(k in action.args)) return bad(`Unknown argument ${k}`)
      const args: Record<string, LedgerValue> = {}
      for (const [name, kind] of Object.entries(action.args)) {
        if (rawArgs[name] === undefined || rawArgs[name] === null) return bad(`${name} is required`, 'ARG_REQUIRED')
        const v = checkValue(kind, rawArgs[name], def.fields[name]?.options, isMember)
        if (v !== null && typeof v === 'object') return bad(`${name}: ${v.error}`, 'BAD_VALUE')
        args[name] = v
      }

      // Attached files (0.18-1): the versions handed over, checked to exist.
      const attachments: LedgerAttachment[] = []
      if (b.attachments !== undefined) {
        if (!Array.isArray(b.attachments) || b.attachments.length > 20) return bad('attachments: up to 20')
        if (action.attach.length === 0) return bad('This action attaches no files')
        const linked = records.linksFrom([row.id]).filter(l => l.targetPath !== null && action.attach.includes(l.name))
        for (const a of b.attachments as Array<Record<string, unknown>>) {
          const link = linked.find(l => l.name === a?.link && l.targetPath === (typeof a?.path === 'string' ? fileLinkPath(a.path) : null))
          if (!link || typeof a.commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(a.commit)) return bad('attachments: { link, path, commit } of files this record links', 'BAD_ATTACHMENT')
          const path = link.targetPath as string
          if (!reader.file(path)) return bad('attachments: { link, path, commit } of files this record links', 'BAD_ATTACHMENT')
          const scopes = companyData.forCompany(member.companyId).scopes.listWithRules()
          const priv = findPrivateScope(scopes, path)
          const repo: RecordFileRepo = priv?.repoId ? { kind: 'scope', repoId: priv.repoId } : { kind: 'company' }
          const inRepo = priv?.repoId ? path.slice(priv.path.length + 1) : path
          if (!await deps.files.fileAtCommit(member.companyId, repo, inRepo, a.commit)) {
            return conflict('添えたファイルの版がサーバーにありません。同期してからもう一度お試しください', 'ATTACHMENT_NOT_SYNCED')
          }
          attachments.push({ link: link.name, path, commit: a.commit })
        }
      }

      // Decision fields (§13.2 案 Y): only on actions marked as decisions.
      let decision: LedgerDecision | null = null
      if (b.decision !== undefined && b.decision !== null) {
        if (!action.decision) return bad('This action is not a decision')
        const d = b.decision as Record<string, unknown>
        const materials = parseMaterials(d.materials)
        if (typeof materials === 'string') return bad(materials)
        for (const m of materials) {
          if (m.kind === 'record') {
            const r = records.byIds([m.id]).find(x => reader.record(x))
            const v = r ? (records.states([r.id])[0]?.version ?? 0) : 0
            if (!r || m.version > v) return bad('materials: a record you can read, at a version it has had', 'BAD_MATERIAL')
          } else if (!reader.file(m.path)) return bad('materials: a file you can read', 'BAD_MATERIAL')
        }
        const precedents = d.precedents === undefined ? [] : d.precedents
        if (!Array.isArray(precedents) || precedents.length > 20 || !precedents.every(p => typeof p === 'string' && REF_RE.test(p))) return bad('precedents: up to 20 `<record id>@<version>`')
        if (d.supersedes !== undefined && d.supersedes !== null && (typeof d.supersedes !== 'string' || !REF_RE.test(d.supersedes))) return bad('supersedes: `<record id>@<version>`')
        if (d.policyVersion !== undefined && d.policyVersion !== null && (typeof d.policyVersion !== 'string' || d.policyVersion.length > 100)) return bad('policyVersion: up to 100 characters')
        decision = {
          reason: note, materials, policyVersion: (d.policyVersion as string | undefined) ?? null,
          precedents: precedents as string[], supersedes: (d.supersedes as string | undefined) ?? null,
        }
      }

      // The new values: the target state, the arguments copied into their fields, hand_to into next_actor.
      const nextFields: Record<string, LedgerValue> = { ...current.fields, ...args }
      if (action.handTo && def.implements.includes('request')) nextFields.next_actor = nextFields[action.handTo] ?? null
      const nextState = action.to ?? current.state
      const changes: LedgerChange[] = []
      if (nextState !== current.state) changes.push({ field: 'state', before: current.state, after: nextState })
      for (const [field, after] of Object.entries(nextFields)) {
        const before = current.fields[field] ?? null
        if (before !== after) changes.push({ field, before, after })
      }
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: actionName, fromState: current.state, toState: nextState,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note, changes, attachments,
        decision, isDecision: action.decision, typeVersion: row.typeVersion, reversesVersion: null,
      }
      // Duty 3: state and ledger together, only if nobody changed the record since `expectedVersion`.
      const expected = b.expectedVersion as number
      if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(nextFields), version: entry.version, updatedAt: at }, expected)) return false
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')

      // Duty 4: tell whom the action names (and whose turn it now is).
      tell(member, [...action.notify.map(n => nextFields[n]), nextFields.next_actor])
      // Duty 5: the milestone line.
      if (action.historyLine) historyLine(member, row, action.label, actor, note, at)
      return ok({ record: summaryOf(records, row.id), entry })
    },

    /** Reverse an earlier entry (a new entry; nothing is rewritten). Its actor or an owner/admin. */
    undo(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null) return bad('The body must be an object')
      if (!Number.isInteger(b.version) || !Number.isInteger(b.expectedVersion)) return bad('version and expectedVersion are required')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
      const ledger = records.ledger(row.id)
      const target = ledger.find(e => e.version === b.version)
      if (!target) return refuse('not-found', 'その変更はありません', { code: 'ENTRY_NOT_FOUND' })
      if (target.action === 'create' || target.action === 'undo') return bad('This change cannot be undone', 'NOT_UNDOABLE')
      if (target.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role)) return refuse('forbidden', '自分の変更か、管理者だけが取り消せます', { code: 'NOT_ALLOWED' })
      const latest = ledger.length > 0 ? ledger[ledger.length - 1].version : 0
      if (b.expectedVersion !== latest) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: latest })
      const now = replayRecordState(ledger, latest)
      const valueOf = (field: string) => (field === 'state' ? now.state : now.fields[field] ?? null)
      if (target.changes.some(c => valueOf(c.field) !== c.after)) {
        return conflict('そのあとにも変更があるため、この変更だけを取り消せません', 'CHANGED_SINCE')
      }
      const changes = target.changes.map(c => ({ field: c.field, before: c.after, after: c.before }))
      const nextFields = { ...now.fields }
      let nextState = now.state
      for (const c of changes) {
        if (c.field === 'state') nextState = typeof c.after === 'string' ? c.after : null
        else nextFields[c.field] = c.after
      }
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: latest + 1, action: 'undo', fromState: now.state, toState: nextState, actorId: member.userId,
        actorKind: actor.kind, actorSource: actor.source ?? null, at, note, changes, attachments: [], decision: null, isDecision: false,
        typeVersion: row.typeVersion, reversesVersion: target.version,
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(nextFields), version: entry.version, updatedAt: at }, latest)) return false
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')
      tell(member, [nextFields.next_actor])
      return ok({ record: summaryOf(records, row.id), entry })
    },

    history(member: Member, recordId: string): Outcome<{ entries: LedgerEntry[] }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = RECORD_ID_RE.test(recordId) ? opened.records.byIds([recordId]).find(r => opened.reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      return ok({ entries: opened.records.ledger(row.id) })
    },

    /** The record's server values as they were at `version` (§13.11). */
    atVersion(member: Member, recordId: string, version: string): Outcome<ReplayedState> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const row = RECORD_ID_RE.test(recordId) ? opened.records.byIds([recordId]).find(r => opened.reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      const n = /^\d{1,10}$/.test(version) ? Number(version) : NaN
      const ledger = opened.records.ledger(row.id)
      const latest = ledger.length > 0 ? ledger[ledger.length - 1].version : 0
      if (!Number.isInteger(n) || n < 1 || n > latest) return refuse('not-found', 'その版はありません', { code: 'VERSION_NOT_FOUND' })
      return ok(replayRecordState(ledger, n))
    },
  }
}

export type RecordEngine = ReturnType<typeof createRecordEngine>


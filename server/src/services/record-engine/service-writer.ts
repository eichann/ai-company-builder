import { SERVICE_MADE_TYPES, SERVICE_OWNED_TYPES, SERVICE_RECEIPT_TYPES, SERVICE_TRANSITIONS, serviceTransitionAllowed } from '../../../shared/core/core-types'
import { findPrivateScope } from '../../../shared/core/permissions'
import { normalizeRepoPath } from '../../../shared/core/paths'
import type { TypeDefinition } from '../../../shared/core/record-types'
import type { LedgerChange, LedgerEntry, LedgerValue, LedgerVia } from '../../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordAccessRow, RecordLinkRow } from '../../ports/records'
import { recordReader } from '../record-access'
import { currentTypes } from '../record-index'
import { recordSummaries } from '../records'
import { interfaceLinkMisses } from './links'
import { MEMBERS_MAX, meetingMembers, withNamedPeople } from './members'
import { ASSIGNEE_CANNOT_READ } from './refusals'
import type { RecordChange, RecordEngineDeps } from './types'
import { checkValue } from './values'

/** Who a core service acts for (the ledger's actor): a person, their AI, or an outside system. */
export interface ServiceActor {
  id: string
  kind: 'human' | 'ai' | 'external'
  /** The agent for an AI, the plugin / service for an outside system. */
  source: string | null
  conversationId?: string | null
  proposedBy?: 'ai' | null
  /** The absent member a delegate stood in for (「代わりに（本来は X）」); the calling service decides it. */
  onBehalfOf?: string | null
  /** The AI's execution run (S10b), from its token. */
  runId?: string | null
  /** A person's call through a plugin's screen (the bridge, plan 4b B6): kept on a created record's first entry. */
  via?: LedgerVia | null
}

/** A new record of a service-owned type (`SERVICE_OWNED_TYPES`). */
export interface ServiceCreateInput {
  type: string
  /** A chosen id (e.g. derived from an idempotency key); default: a new one. */
  id?: string
  title: string
  summary?: string
  /** The record's readers' folder (null = everyone); never a private folder. Service records are server only. */
  folder?: string | null
  /** Server fields, checked by the type's kinds; every person named must be able to read the record. */
  fields?: Record<string, LedgerValue>
  /** Link name → record ids. */
  links?: Record<string, string[]>
  actor: ServiceActor
  note?: string
  /**
   * Owner-only (「持ち主だけ」): the one member who may read it — the inbox's
   * record of someone's own mail (inbox.md). Not with `folder`; every person
   * named must be that member (no one else can read it).
   */
  personalOwner?: string
  /**
   * Members-only (「この人たちだけ」, records.md "Members-only records"): the members who may read
   * it (each a member of the company, at most 200). Not with `folder` / `personalOwner`; every
   * person named must be listed. A record linked to a members-only meeting is members-only by
   * itself (its list and the people named) — then a `folder` is refused (`bad-place`).
   */
  members?: readonly string[]
  /**
   * Start in this state instead of the type's initial one: only a state the
   * initial one may move to along `SERVICE_TRANSITIONS` (as if created, then
   * moved) — the inbox's 確認待ち / 部署の番 / やることにしなかった.
   */
  state?: string
  /** Tell nobody (signal the app only): a record made in the AI's turn waits for the AI, not a person. */
  quiet?: boolean
  /** Also tell these members (besides the assignee and next actor): a meeting's attendees (minutes.md). */
  notify?: readonly string[]
}

/** A state change (checked against `SERVICE_TRANSITIONS`) and/or field change of a service-owned record. */
export interface ServiceTransitionInput {
  recordId: string
  /** The ledger's action name (`approve`, `send`, `start_reading`…). */
  action: string
  /** The version the caller decided on: compare-and-set, nothing written when it moved. */
  expectedVersion: number
  /** The new state; null = the state stays (fields only). */
  to: string | null
  fields?: Record<string, LedgerValue>
  /**
   * Links to replace: link name → record ids ([] removes). Kept in the ledger
   * as `links.<name>` before / after (the meeting's まとまり, chosen by a person).
   */
  links?: Record<string, string[]>
  actor: ServiceActor
  note?: string
  /** Keep the entry as a decision with this reason (approving, sending back). */
  decisionReason?: string
  /** Also tell these members (besides the assignee and next actor). */
  notify?: string[]
  /** Tell nobody (signal the app only). */
  quiet?: boolean
  /**
   * Add these members to a members-only record's list (records.md "Members-only records": a
   * meeting's attendees the calendar added later). Kept in the ledger as `place.members` before /
   * after; refused (`bad-place`) on a record that is not members-only or with a non-member.
   */
  addMembers?: readonly string[]
}

export type ServiceWriteFailure =
  | 'records-off' | 'type-unknown' | 'not-service-owned' | 'bad-value' | 'bad-place' | 'assignee-cannot-read'
  | 'exists' | 'not-found' | 'stale' | 'transition-not-allowed'

export type ServiceWriteFailed = { ok: false; reason: ServiceWriteFailure; detail?: string }
export type ServiceWriteResult = { ok: true; record: RecordSummary; entry: LedgerEntry } | ServiceWriteFailed

const fail = (reason: ServiceWriteFailure, detail?: string): ServiceWriteFailed => ({ ok: false, reason, ...(detail ? { detail } : {}) })

/** Where a record is read (a service's input), as another record's place. */
export type ServicePlace = { folder: string | null } | { personalOwner: string } | { members: readonly string[] }

/**
 * The place of `row`, for a record a service makes from it (a reply placed like its 連絡, a
 * draft like its meeting): owner-only stays its owner's, members-only its members', else its
 * folder. The one copy — copying `folder` alone would place what came from a members-only
 * record company-wide (records.md "Members-only records").
 */
export function placeOfRow(row: Pick<RecordAccessRow, 'folder' | 'personalOwner' | 'members'>): ServicePlace {
  if (row.personalOwner !== null) return { personalOwner: row.personalOwner }
  if (row.members !== null) return { members: row.members }
  return { folder: row.folder }
}

/**
 * The engine's entry for the core services of milestone 4 (minutes intake,
 * approvals, outbound mail, decisions; records.md "Service writer"). Like
 * `createExternalRecordWriter`, composition.ts hands it to those services
 * only — no route, screen or AI reaches it. It creates records of
 * `SERVICE_OWNED_TYPES` (with values, links and a folder or a committed file
 * path) and changes their state along `SERVICE_TRANSITIONS`, with the
 * engine's duties: values checked by kind, every person named able to read
 * the record (`ASSIGNEE_CANNOT_READ`), state + ledger in one transaction with
 * a compare-and-set on the version, the actor the caller names, and the
 * members it names told (kind + version only). Whether that actor may do it
 * (an approver approving, the author sending) is the calling service's rule.
 */
export function createServiceRecordWriter(deps: Pick<RecordEngineDeps, 'companyData' | 'transactions' | 'clock' | 'ids' | 'isMember' | 'roleOf' | 'notify' | 'recordChanged'>) {
  const { companyData } = deps

  /** Every person value can read a record at `place` (a private folder's name is never said). */
  function readersOk(companyId: string, place: RecordAccessRow, values: Record<string, LedgerValue>, def: TypeDefinition): boolean {
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    return Object.entries(values).every(([name, v]) => {
      if (def.fields[name]?.kind !== 'person' || typeof v !== 'string') return true
      const role = deps.roleOf(companyId, v)
      return role !== null && recordReader({ companyId, userId: v, role }, scopes).record(place)
    })
  }

  function checkFields(companyId: string, def: TypeDefinition, raw: Record<string, LedgerValue> | undefined): { values: Record<string, LedgerValue> } | ServiceWriteFailed {
    const values: Record<string, LedgerValue> = {}
    for (const [name, value] of Object.entries(raw ?? {})) {
      const f = Object.prototype.hasOwnProperty.call(def.fields, name) ? def.fields[name] : undefined
      if (!f || f.source !== 'server') return fail('bad-value', `${name} is not a server field of ${def.name}`)
      const v = checkValue(f.kind, value, f.options, id => deps.isMember(companyId, id))
      if (v !== null && typeof v === 'object') return fail('bad-value', `${name}: ${v.error}`)
      values[name] = v
    }
    return { values }
  }

  function tell(companyId: string, actorId: string, userIds: Array<LedgerValue | undefined>, change: RecordChange, quiet = false) {
    // Every reader hears that it changed (the app refetches); quiet: that signal only, no notice.
    try { deps.recordChanged?.(companyId, change.entry.recordId) } catch { /* the app's own check catches up */ }
    if (quiet) return
    const to = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && u !== actorId))]
    if (to.length > 0) { try { deps.notify(companyId, to, change) } catch { /* the app's own check catches up */ } }
  }

  /** Everything `create` checks, without writing: the prepared rows, or why not. */
  function prepare(companyId: string, input: ServiceCreateInput) {
    const records = companyData.forCompany(companyId).records
    if (!records.settings().enabled) return fail('records-off')
    if (!SERVICE_OWNED_TYPES.includes(input.type) && !SERVICE_RECEIPT_TYPES.includes(input.type) && !SERVICE_MADE_TYPES.includes(input.type)) return fail('not-service-owned')
    const def = currentTypes(records).get(input.type)?.definition
    if (!def) return fail('type-unknown')
    const title = input.title.normalize('NFC').trim()
    if (title === '' || title.length > 200) return fail('bad-value', 'title: 1–200 characters')
    const summary = (input.summary ?? '').normalize('NFC').slice(0, 300)
    const scopes = companyData.forCompany(companyId).scopes.listWithRules()
    if (def.storage === 'file') return fail('bad-place', 'records of this type are files')
    let folder: string | null = null
    if (input.folder !== undefined && input.folder !== null) {
      folder = normalizeRepoPath(input.folder)
      if (folder === null || findPrivateScope(scopes, folder)) return fail('bad-place')
    }
    const personalOwner = input.personalOwner ?? null
    if (personalOwner !== null && (folder !== null || !deps.isMember(companyId, personalOwner))) return fail('bad-place')
    let members: string[] | null = null
    if (input.members !== undefined) {
      members = [...new Set(input.members)]
      if (folder !== null || personalOwner !== null || members.length > MEMBERS_MAX || !members.every(m => deps.isMember(companyId, m))) return fail('bad-place')
    }
    const state = input.state ?? def.initial
    if (input.state !== undefined && input.state !== def.initial && (!def.states.includes(input.state) || !serviceTransitionAllowed(def.name, def.initial, input.state))) {
      return fail('transition-not-allowed')
    }
    const checked = checkFields(companyId, def, input.fields)
    if (!('values' in checked)) return checked
    const values = checked.values
    if (def.implements.includes('request')) {
      if (input.actor.kind !== 'external') values.requested_by ??= input.actor.id
      values.next_actor ??= values.assignee ?? null
    }
    const id = input.id ?? newRecordId(def.name, deps.ids.newToken().slice(0, 16))
    if (!RECORD_ID_RE.test(id) || !id.startsWith(`${def.name}-`)) return fail('bad-value', 'id')
    const links: RecordLinkRow[] = []
    for (const [name, targets] of Object.entries(input.links ?? {})) {
      const l = Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
      if (!l || l.target === 'file') return fail('bad-value', `${name} is not a record link of ${def.name}`)
      for (const t of targets) {
        if (!RECORD_ID_RE.test(t)) return fail('bad-value', `${name}: a record id`)
        links.push({ sourceId: id, name, position: links.length, targetId: t, targetPath: null })
      }
      if (interfaceLinkMisses(records, l, targets).length > 0) return fail('bad-value', `${name}: records implementing ${l.target}`)
    }
    // Made from a members-only meeting: members-only too (its list and the people named here),
    // never placed in a folder — a service passing one is refused (fails closed).
    const inherited = members === null && personalOwner === null ? meetingMembers(records, links) : null
    if (inherited !== null) {
      if (folder !== null) return fail('bad-place')
      members = withNamedPeople(inherited, def, values)
    }
    // Owner-only / members-only only when the calling service says whose (the inbox) or a meeting's list is inherited.
    const place: RecordAccessRow = { id, type: def.name, scopeId: null, path: null, folder, personalOwner, members }
    if (!readersOk(companyId, place, values, def)) return fail('assignee-cannot-read', ASSIGNEE_CANNOT_READ)
    const existing = records.find(id)
    if (existing && (existing.type !== def.name || records.states([id]).length > 0)) return fail('exists')
    return { ok: true as const, records, def, id, title, summary, folder, personalOwner, members, state, values, links }
  }

  return {
    /** Would `create` accept this now? (A caller with outside work to do first asks, so nothing is left half-made.) */
    check(companyId: string, input: ServiceCreateInput): ServiceWriteFailed | null {
      const p = prepare(companyId, input)
      return p.ok ? null : p
    },

    create(companyId: string, input: ServiceCreateInput): ServiceWriteResult {
      const p = prepare(companyId, input)
      if (!p.ok) return p
      const { records, def, id, values, links, state } = p
      const at = deps.clock.now()
      const entry: LedgerEntry = {
        recordId: id, version: 1, action: 'create', fromState: null, toState: state, actorId: input.actor.id, actorKind: input.actor.kind,
        actorSource: input.actor.source, at, note: input.note ?? '',
        changes: [
          { field: 'state', before: null, after: state },
          ...Object.entries(values).filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
        ],
        attachments: [], decision: null, isDecision: false, typeVersion: def.version, reversesVersion: null,
        proposedBy: input.actor.kind === 'human' && input.actor.proposedBy === 'ai' ? 'ai' : null, conversationId: input.actor.conversationId ?? null,
        runId: input.actor.kind === 'ai' ? input.actor.runId ?? null : null,
        ...(input.actor.kind === 'human' && input.actor.via ? { via: { plugin: input.actor.via.plugin, version: input.actor.via.version } } : {}),
      }
      const existing = records.find(id)
      let written = false
      try {
        written = deps.transactions.run(() => {
          records.upsert({
            id, type: def.name, typeVersion: existing?.typeVersion ?? def.version, scopeId: null, path: null, folder: p.folder, personalOwner: p.personalOwner,
            members: p.members, title: p.title, summary: p.summary, createdAt: existing?.createdAt ?? at, updatedAt: at, removedAt: null,
          })
          if (p.members !== null) records.addMembers(id, p.members, input.actor.id, at)
          records.replaceLinks(id, links)
          if (!records.writeState({ recordId: id, state, fields: JSON.stringify(values), version: 1, updatedAt: at }, 0)) throw new Error('exists')
          records.appendLedger(entry)
          return true
        })
      } catch {
        written = false
      }
      if (!written) return fail('exists')
      tell(companyId, input.actor.id, [values.assignee, values.next_actor, ...(input.notify ?? [])], { type: def.name, entry, fields: values }, input.quiet)
      return { ok: true, record: recordSummaries(records, records.byIds([id])).get(id) as RecordSummary, entry }
    },

    transition(companyId: string, input: ServiceTransitionInput): ServiceWriteResult {
      const records = companyData.forCompany(companyId).records
      if (!records.settings().enabled) return fail('records-off')
      const row = RECORD_ID_RE.test(input.recordId) ? records.byIds([input.recordId])[0] : undefined
      if (!row || row.removedAt !== null) return fail('not-found')
      // Another type (task) only along its listed state changes: the server clock's move (core-types.ts WAIT_OVER).
      if (!SERVICE_OWNED_TYPES.includes(row.type) && (input.to === null || !Object.prototype.hasOwnProperty.call(SERVICE_TRANSITIONS, row.type))) return fail('not-service-owned')
      const def = currentTypes(records).get(row.type)?.definition
      if (!def) return fail('type-unknown')
      const s = records.states([row.id])[0]
      let now: Record<string, LedgerValue> = {}
      try { now = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { now = {} }
      const version = s?.version ?? 0
      const state = s ? s.state : def.initial
      if (input.expectedVersion !== version) return fail('stale')
      const nextState = input.to ?? state
      if (nextState !== state && (nextState === null || !serviceTransitionAllowed(row.type, state, nextState))) return fail('transition-not-allowed')
      const checked = checkFields(companyId, def, input.fields)
      if (!('values' in checked)) return checked
      const set = checked.values
      if (!readersOk(companyId, row, set, def)) return fail('assignee-cannot-read', ASSIGNEE_CANNOT_READ)
      const next = { ...now, ...set }
      const changes: LedgerChange[] = []
      if (nextState !== state) changes.push({ field: 'state', before: state, after: nextState })
      for (const [field, after] of Object.entries(set)) {
        const before = now[field] ?? null
        if (before !== after) changes.push({ field, before, after })
      }
      const currentLinks = records.linksFrom([row.id])
      const newLinks: RecordLinkRow[] = []
      for (const [name, targets] of Object.entries(input.links ?? {})) {
        const l = Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
        if (!l || l.target === 'file') return fail('bad-value', `${name} is not a record link of ${def.name}`)
        if (l.cardinality === 'one' && targets.length > 1) return fail('bad-value', `${name}: one record`)
        for (const t of targets) {
          if (!RECORD_ID_RE.test(t)) return fail('bad-value', `${name}: a record id`)
          newLinks.push({ sourceId: row.id, name, position: 0, targetId: t, targetPath: null })
        }
        if (interfaceLinkMisses(records, l, targets).length > 0) return fail('bad-value', `${name}: records implementing ${l.target}`)
        const before = currentLinks.filter(x => x.name === name).map(x => x.targetId).join(',') || null
        const after = targets.join(',') || null
        if (before !== after) changes.push({ field: `links.${name}`, before, after })
      }
      // New members of a members-only record's list (only such a record, only members of the company).
      const adding = input.addMembers ? [...new Set(input.addMembers)] : []
      if (input.addMembers && (row.members === null || adding.length > MEMBERS_MAX || !adding.every(m => deps.isMember(companyId, m)))) return fail('bad-place')
      const joined = row.members !== null ? adding.filter(m => !row.members?.includes(m)) : []
      if (joined.length > 0) {
        changes.push({ field: 'place.members', before: (row.members ?? []).join(','), after: [...(row.members ?? []), ...joined].join(',') })
      }
      const replacedLinks = input.links
        ? [...currentLinks.filter(x => !(x.name in (input.links as Record<string, string[]>))), ...newLinks].map((x, i) => ({ ...x, position: i }))
        : null
      const at = deps.clock.now()
      const isDecision = input.decisionReason !== undefined
      const entry: LedgerEntry = {
        recordId: row.id, version: version + 1, action: input.action, fromState: state, toState: nextState,
        actorId: input.actor.id, actorKind: input.actor.kind, actorSource: input.actor.source, at, note: input.note ?? '', changes, attachments: [],
        decision: isDecision ? { reason: input.decisionReason as string, materials: [], policyVersion: null, precedents: [], supersedes: null } : null,
        isDecision, typeVersion: row.typeVersion, reversesVersion: null,
        proposedBy: input.actor.kind === 'human' && input.actor.proposedBy === 'ai' ? 'ai' : null, conversationId: input.actor.conversationId ?? null,
        ...(input.actor.onBehalfOf ? { onBehalfOf: input.actor.onBehalfOf } : {}),
        runId: input.actor.kind === 'ai' ? input.actor.runId ?? null : null,
      }
      const written = deps.transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(next), version: entry.version, updatedAt: at }, version)) return false
        if (replacedLinks) records.replaceLinks(row.id, replacedLinks)
        if (joined.length > 0) records.addMembers(row.id, joined, input.actor.id, at)
        records.appendLedger(entry)
        return true
      })
      if (!written) return fail('stale')
      tell(companyId, input.actor.id, [next.assignee, next.next_actor, ...(input.notify ?? [])], { type: row.type, entry, fields: next }, input.quiet)
      return { ok: true, record: recordSummaries(records, [row]).get(row.id) as RecordSummary, entry }
    },

    /**
     * A received message's title, only while it is still `expected` (compare-and-set): the inbox's
     * placeholder 「（件名なし）」 replaced by the owner's AI's short title (inbox.md). Only a
     * service's receipt type (`interaction`); the version and the ledger stay (a title is no field).
     */
    retitle(companyId: string, recordId: string, expected: string, title: string): boolean {
      const records = companyData.forCompany(companyId).records
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId])[0] : undefined
      if (!row || row.removedAt !== null || !SERVICE_RECEIPT_TYPES.includes(row.type) || row.title !== expected) return false
      const next = title.normalize('NFC').trim().slice(0, 200)
      if (next === '') return false
      deps.transactions.run(() => records.upsert({ ...row, title: next, updatedAt: deps.clock.now() }))
      try { deps.recordChanged?.(companyId, row.id) } catch { /* the app's own check catches up */ }
      return true
    },
  }
}

export type ServiceRecordWriter = ReturnType<typeof createServiceRecordWriter>

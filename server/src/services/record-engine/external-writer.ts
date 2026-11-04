import type { ExternalReceipt, LedgerChange, LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import { newRecordId, RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordLinkRow } from '../../ports/records'
import { currentTypes } from '../record-index'
import { interfaceLinkMisses } from './links'
import type { RecordEngineDeps } from './types'
import { checkValue } from './values'

/** What a connector plugin brings in or wrote out for one record (P5 / P6). */
export interface ExternalRecordInput {
  /** The record, or null to create one (server only: imported records never become files, §8-3). */
  recordId: string | null
  type: string
  /** Its readers' folder (the mapping's visible_to_folder); on create only. */
  folder: string | null
  /** The outside title, when the mapping reads one. */
  title: string | null
  /** Server fields as the outside system has them now (only those the mapping reads). */
  fields: Record<string, LedgerValue>
  /** Links filled from the outside system's associations: link name → record ids (replaced). */
  links: Record<string, string[]>
  /** The ledger's action: `<plugin>.import` for an observed change, the operation for a write. */
  action: string
  /** The plugin's id (the ledger's actor source for an observed change). */
  source: string
  receipt: ExternalReceipt
  note?: string
  /**
   * P6 writes: the version the write was decided on. A different version
   * now → nothing written (`stale`).
   */
  expectedVersion?: number
  /** P6: the member (and kind) on whose behalf the plugin wrote; default: the outside system. */
  actor?: { id: string; kind: 'human' | 'ai'; source: string | null; conversationId: string | null; proposedBy?: 'ai' | null; runId?: string | null }
  /** P6: the operation is a decision (`decision: true`): the note is its reason, kept in the entry. */
  decision?: boolean
  /**
   * Milestone 4: write the entry even when no field changes (a meeting logged
   * on a deal in the outside system: the record's ledger notes it, with its receipt).
   */
  entryWithoutChanges?: boolean
}

export type ExternalRecordResult =
  | { ok: true; recordId: string; version: number; created: boolean; changed: boolean; entry: LedgerEntry | null; problems: string[] }
  | { ok: false; reason: 'records-off' | 'type-unknown' | 'stale' | 'not-found' }

/**
 * The engine's one entry for results of an exchange with an outside system
 * (milestone 3, records.md "Outside systems"). Only the connector plugin's
 * services get it (composition.ts); no route, screen or AI reaches it. Same
 * duties as the engine — state and ledger in one transaction with a
 * compare-and-set on the version, tell whom the record names — and nothing
 * else: it sends nothing outside, computes nothing, writes no file.
 */
export function createExternalRecordWriter(deps: Pick<RecordEngineDeps, 'companyData' | 'transactions' | 'clock' | 'ids' | 'isMember' | 'notify' | 'recordChanged'>) {
  return {
    apply(companyId: string, input: ExternalRecordInput): ExternalRecordResult {
      const records = deps.companyData.forCompany(companyId).records
      if (!records.settings().enabled) return { ok: false, reason: 'records-off' }
      const def = currentTypes(records).get(input.type)?.definition
      if (!def) return { ok: false, reason: 'type-unknown' }
      const problems: string[] = []
      const fields: Record<string, LedgerValue> = {}
      for (const [name, value] of Object.entries(input.fields)) {
        const f = def.fields[name]
        if (!f || f.source !== 'server') { problems.push(`欄「${name}」は型にありません`); continue }
        const v = checkValue(f.kind, value, f.options, id => deps.isMember(companyId, id))
        if (v !== null && typeof v === 'object') { problems.push(`欄「${name}」: ${v.error}`); continue }
        fields[name] = v
      }
      const at = deps.clock.now()
      const actor = input.actor ?? { id: input.source, kind: 'external' as const, source: input.source, conversationId: null }
      const linkRows = (id: string): RecordLinkRow[] => Object.entries(input.links).flatMap(([name, targets]) => {
        const valid = targets.filter(t => RECORD_ID_RE.test(t))
        // An interface link (`interface: bundle`) keeps only records implementing it, as every other writer.
        const link = Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
        const misses = link ? interfaceLinkMisses(records, link, valid) : []
        return valid.filter(t => !misses.includes(t)).map((t, i) => ({ sourceId: id, name, position: i, targetId: t, targetPath: null }))
      })
      const tellAbout = (values: Record<string, LedgerValue>, entry: LedgerEntry) => {
        try { deps.recordChanged?.(companyId, entry.recordId) } catch { /* the app's own check catches up */ }
        const to = [...new Set([values.assignee, values.next_actor].filter((u): u is string => typeof u === 'string'))]
        if (to.length > 0) { try { deps.notify(companyId, to, { type: def.name, entry, fields: values }) } catch { /* the app's own check catches up */ } }
      }
      const title = input.title === null ? null : input.title.normalize('NFC').slice(0, 200)

      if (input.recordId === null) {
        const id = newRecordId(def.name, deps.ids.newToken().slice(0, 16))
        const changes: LedgerChange[] = [
          { field: 'state', before: null, after: def.initial },
          ...Object.entries(fields).filter(([, v]) => v !== null).map(([field, after]) => ({ field, before: null, after })),
        ]
        const entry: LedgerEntry = {
          recordId: id, version: 1, action: 'create', fromState: null, toState: def.initial, actorId: actor.id, actorKind: actor.kind,
          actorSource: actor.source, at, note: input.note ?? '', changes, attachments: [],
          decision: input.decision ? { reason: input.note ?? '', materials: [], policyVersion: null, precedents: [], supersedes: null } : null, isDecision: input.decision === true,
          typeVersion: def.version, reversesVersion: null, proposedBy: null, conversationId: actor.conversationId, receipt: input.receipt,
          runId: 'runId' in actor && actor.kind === 'ai' ? actor.runId ?? null : null,
        }
        deps.transactions.run(() => {
          records.upsert({
            id, type: def.name, typeVersion: def.version, scopeId: null, path: null, folder: input.folder, personalOwner: null,
            title: title || def.label, summary: '', createdAt: at, updatedAt: at, removedAt: null,
          })
          records.replaceLinks(id, linkRows(id))
          if (!records.writeState({ recordId: id, state: def.initial, fields: JSON.stringify(fields), version: 1, updatedAt: at }, 0)) throw new Error('record id taken')
          records.appendLedger(entry)
        })
        tellAbout(fields, entry)
        return { ok: true, recordId: id, version: 1, created: true, changed: true, entry, problems }
      }

      const row = records.byIds([input.recordId])[0]
      if (!row || row.removedAt !== null) return { ok: false, reason: 'not-found' }
      const s = records.states([row.id])[0]
      let now: Record<string, LedgerValue> = {}
      try { now = s ? JSON.parse(s.fields) as Record<string, LedgerValue> : {} } catch { now = {} }
      const version = s?.version ?? 0
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) return { ok: false, reason: 'stale' }
      const changes: LedgerChange[] = []
      for (const [field, after] of Object.entries(fields)) {
        const before = now[field] ?? null
        if (before !== after) changes.push({ field, before, after })
      }
      const titleChanged = title !== null && title !== row.title
      const wanted = linkRows(row.id)
      const linksChanged = Object.keys(input.links).length > 0
        && JSON.stringify(records.linksFrom([row.id]).filter(l => l.name in input.links).map(l => [l.name, l.targetId]))
          !== JSON.stringify(wanted.map(l => [l.name, l.targetId]))
      const sideEffects = () => {
        if (titleChanged) records.upsert({ ...row, title: title as string, updatedAt: at })
        if (linksChanged) records.replaceLinks(row.id, [...records.linksFrom([row.id]).filter(l => !(l.name in input.links)), ...wanted])
      }
      if (changes.length === 0 && !input.entryWithoutChanges) {
        if (titleChanged || linksChanged) deps.transactions.run(sideEffects)
        return { ok: true, recordId: row.id, version, created: false, changed: false, entry: null, problems }
      }
      const next = { ...now, ...fields }
      const state = s?.state ?? def.initial
      const entry: LedgerEntry = {
        recordId: row.id, version: version + 1, action: input.action, fromState: state, toState: state,
        actorId: actor.id, actorKind: actor.kind, actorSource: actor.source, at, note: input.note ?? '', changes, attachments: [],
        decision: input.decision ? { reason: input.note ?? '', materials: [], policyVersion: null, precedents: [], supersedes: null } : null,
        isDecision: input.decision === true, typeVersion: row.typeVersion, reversesVersion: null,
          proposedBy: 'proposedBy' in actor && actor.kind === 'human' && actor.proposedBy === 'ai' ? 'ai' : null, conversationId: actor.conversationId, receipt: input.receipt,
          runId: 'runId' in actor && actor.kind === 'ai' ? actor.runId ?? null : null,
      }
      const written = deps.transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state, fields: JSON.stringify(next), version: entry.version, updatedAt: at }, version)) return false
        records.appendLedger(entry)
        sideEffects()
        return true
      })
      if (!written) return { ok: false, reason: 'stale' }
      tellAbout(next, entry)
      return { ok: true, recordId: row.id, version: entry.version, created: false, changed: true, entry, problems }
    },
  }
}

export type ExternalRecordWriter = ReturnType<typeof createExternalRecordWriter>

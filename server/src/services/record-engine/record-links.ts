/**
 * Linking one record to another after it was made, or removing that link (records.md "Linking
 * records later", owner decision 2026-11-02 「つなぐ・外す・新しく作るの動線」): the same shape as
 * linking files (./file-links.ts) for record links.
 */
import { INTERFACES } from '../../../shared/core/record-types'
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { linkAllowed } from '../record-access'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { linkLedgerValue, MAX_LINK_TARGETS, withLinkTargets } from './links'
import { bad, conflict, serviceStateOnly, STATE_CHANGED_BY_SERVICE } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

/** A link that says where the record came from (`origin: true`): history, never changed by hand. */
export const LINK_IS_ORIGIN = { error: 'このつながりは、この記録がどこから来たかを表すので外せません', code: 'LINK_IS_ORIGIN' } as const

export function recordLinking(ctx: EngineContext) {
  const { transactions, clock, open, stateOf, summaryOf, changed } = ctx
  return {
    /**
     * Link a record to this one (`link`), or remove that link (`unlink`). Any record link of the
     * type but an origin one (`LinkDef.origin`, 400 `LINK_IS_ORIGIN`). The caller reads the
     * record; when linking, the target too — of the link's type or implementing its interface,
     * and one the record may reach (`linkAllowed`): another type, an unreadable record, another
     * company's and a missing id get one answer, 400 `BAD_LINK`. Removing a target that is not
     * linked — or that the caller cannot see — is 404 `LINK_NOT_FOUND`. A `one` link is replaced.
     * The member's AI only on types that let the AI act at all. A ledger entry `link_record` /
     * `unlink_record` with `links.<name>` before / after, so it can be undone (取り消す). Only the
     * link changes: the other record stays as it is. Nobody is told.
     */
    recordLink(member: Member, actor: ActorInput, recordId: string, op: 'link' | 'unlink', body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry | null; changed: boolean }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      if (serviceStateOnly(row.type)) return refuse('forbidden', STATE_CHANGED_BY_SERVICE.error, { code: STATE_CHANGED_BY_SERVICE.code })
      const types = currentTypes(records)
      const def = types.get(row.type)?.definition
      if (!def) return conflict('この記録の型の定義がありません', 'TYPE_UNKNOWN')
      if (actor.kind === 'ai' && !Object.values(def.actions).some(a => a.who.includes('ai'))) {
        return refuse('forbidden', 'この記録のつながりは AI からは変えられません。本人が画面から行ってください', { code: 'NOT_ALLOWED' })
      }
      // A file record's links are its text (the next index of the file would overwrite them).
      if (row.path !== null) return bad('この記録のつながりはファイルに書かれています。ファイルを直してください', 'FILE_RECORD')

      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('The body must be an object')
      const name = b.link
      const l = typeof name === 'string' && Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
      if (typeof name !== 'string' || !l || l.target === 'file') {
        const names = Object.entries(def.links).filter(([, x]) => x.target !== 'file' && !x.origin).map(([n]) => n)
        return bad(`link: one of ${names.join(', ')}`, 'BAD_LINK')
      }
      if (l.origin) return bad(LINK_IS_ORIGIN.error, LINK_IS_ORIGIN.code)
      const target = b.target
      if (typeof target !== 'string' || !RECORD_ID_RE.test(target)) return bad('target: a record id', 'BAD_LINK')
      if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) return bad('expectedVersion: the version you saw', 'VERSION_REQUIRED')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)

      const allLinks = records.linksFrom([row.id])
      const mine = allLinks.filter(x => x.name === name)
      const before = mine.map(x => x.targetId).filter((t): t is string => t !== null)
      let after: string[]
      if (op === 'link') {
        const t = records.byIds([target]).find(r => r.removedAt === null)
        const fits = !!t && (l.targetIsInterface ? types.get(t.type)?.definition.implements.includes(l.target) === true : t.type === l.target)
        if (!t || !fits || !reader.record(t) || !linkAllowed(row, t)) {
          // One answer for another type, an unreadable record, another company's and a missing id.
          const label = l.targetIsInterface ? (INTERFACES[l.target]?.label ?? l.target) : (types.get(l.target)?.definition.label ?? l.target)
          return refuse('bad-request', `つながり「${l.label}」には、あなたが見られる「${label}」の記録だけをつなげます`, { code: 'BAD_LINK', link: name })
        }
        if (before.includes(target)) return ok({ record: summaryOf(records, row.id), entry: null, changed: false })
        after = l.cardinality === 'one' ? [target] : [...before, target]
        if (after.length > MAX_LINK_TARGETS) return bad(`At most ${MAX_LINK_TARGETS} records per link`, 'TOO_MANY_LINKS')
      } else {
        // A target the caller cannot see is answered like one that is not linked (nothing about it leaks).
        const seen = records.byIds([target]).some(r => reader.record(r) && linkAllowed(row, r))
        if (!before.includes(target) || !seen) return refuse('not-found', 'この記録はこのつながりにありません', { code: 'LINK_NOT_FOUND' })
        after = before.filter(t => t !== target)
      }

      const current = stateOf(records, row, def)
      const expected = b.expectedVersion as number
      if (expected !== current.version) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: current.version })
      const nextLinks = withLinkTargets(row.id, allLinks, name, l.target, after)
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: current.version + 1, action: op === 'link' ? 'link_record' : 'unlink_record', fromState: current.state, toState: current.state,
        actorId: member.userId, actorKind: actor.kind, actorSource: actor.source ?? null, at, note,
        changes: [{ field: `links.${name}`, before: linkLedgerValue(l.target, mine), after: linkLedgerValue(l.target, nextLinks.filter(x => x.name === name)) }],
        attachments: [], decision: null, isDecision: false, typeVersion: row.typeVersion, reversesVersion: null, ...provenance(actor),
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: current.state, fields: JSON.stringify(current.fields), version: entry.version, updatedAt: at }, expected)) return false
        records.replaceLinks(row.id, nextLinks)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')
      changed(member.companyId, row.id)
      return ok({ record: summaryOf(records, row.id), entry, changed: true })
    },
  }
}

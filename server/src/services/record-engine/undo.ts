/** Reversing an earlier ledger entry with a new one (records.md "The state engine"). */
import { undoableByAssignee } from '../../../shared/core/core-types'
import { FULL_ACCESS_ROLES } from '../../../shared/core/permissions'
import { replayRecordState, type LedgerEntry, type LedgerValue } from '../../../shared/core/record-ledger'
import { RECORD_ID_RE } from '../../../shared/core/records'
import type { RecordSummary } from '../../../shared/types/records'
import type { RecordLinkRow } from '../../ports/records'
import type { Member } from '../access'
import { ok, refuse, type Outcome } from '../outcome'
import { currentTypes } from '../record-index'
import { RECORD_NOT_FOUND, RECORDS_DISABLED } from '../records'
import type { EngineContext } from './context'
import { isPlaceOrLinkChange, linkLedgerValue, linkTargetsOf, withLinkTargets } from './links'
import { bad, conflict, serviceStateOnly, STATE_CHANGED_BY_SERVICE } from './refusals'
import type { ActorInput } from './types'
import { NOTE_MAX, provenance } from './values'

export function undoing(ctx: EngineContext) {
  const { transactions, clock, open, tell, summaryOf } = ctx
  return {
    /** Reverse an earlier entry (a new entry; nothing is rewritten). Its actor or an owner/admin. */
    undo(member: Member, actor: ActorInput, recordId: string, body: unknown): Outcome<{ record: RecordSummary; entry: LedgerEntry }> {
      const opened = open(member)
      if (!opened) return refuse('not-found', RECORDS_DISABLED.error, { code: RECORDS_DISABLED.code })
      const { records, reader } = opened
      const row = RECORD_ID_RE.test(recordId) ? records.byIds([recordId]).find(r => reader.record(r)) : undefined
      if (!row) return refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
      // An undo would reopen a used approval or a sent message: never through here.
      if (serviceStateOnly(row.type)) return refuse('forbidden', STATE_CHANGED_BY_SERVICE.error, { code: STATE_CHANGED_BY_SERVICE.code })
      const b = body as Record<string, unknown> | null
      if (typeof b !== 'object' || b === null) return bad('The body must be an object')
      if (!Number.isInteger(b.version) || !Number.isInteger(b.expectedVersion)) return bad('version and expectedVersion are required')
      const note = b.note === undefined ? '' : b.note
      if (typeof note !== 'string' || note.length > NOTE_MAX) return bad(`note: up to ${NOTE_MAX} characters`)
      const ledger = records.ledger(row.id)
      const target = ledger.find(e => e.version === b.version)
      if (!target) return refuse('not-found', 'その変更はありません', { code: 'ENTRY_NOT_FOUND' })
      // Sharing an owner-only record is not taken back: the folder's readers may already have seen it.
      if (target.action === 'create' || target.action === 'undo' || target.changes.some(c => c.field.startsWith('place.'))) {
        return bad('This change cannot be undone', 'NOT_UNDOABLE')
      }
      const latest = ledger.length > 0 ? ledger[ledger.length - 1].version : 0
      const now = replayRecordState(ledger, latest)
      // The system's own entries its assignee may take back (UNDO_BY_ASSIGNEE: the inbox closing a mail
      // that left the mailbox inbox, or taking it out there — each told with ［元に戻す］).
      const assigneeMay = undoableByAssignee(row.type, target, now.fields.assignee, member.userId)
      if (target.actorId !== member.userId && !FULL_ACCESS_ROLES.has(member.role) && !assigneeMay) return refuse('forbidden', '自分の変更か、管理者だけが取り消せます', { code: 'NOT_ALLOWED' })
      if (b.expectedVersion !== latest) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT', { version: latest })
      // `links.<name>` changes (a file linked, the meeting's まとまり) are compared with and restored to
      // the link rows themselves: a rename the indexer followed changed them without an entry.
      const def = currentTypes(records).get(row.type)?.definition
      const currentLinks = records.linksFrom([row.id])
      const linkOf = (field: string) => {
        const name = field.slice('links.'.length)
        const l = def && Object.prototype.hasOwnProperty.call(def.links, name) ? def.links[name] : undefined
        return l ? { name, target: l.target } : null
      }
      const valueOf = (field: string): LedgerValue | undefined => {
        if (field === 'state') return now.state
        if (!field.startsWith('links.')) return now.fields[field] ?? null
        const l = linkOf(field)
        return l ? linkLedgerValue(l.target, currentLinks.filter(x => x.name === l.name)) : undefined
      }
      if (target.changes.some(c => valueOf(c.field) !== c.after)) {
        return conflict('そのあとにも変更があるため、この変更だけを取り消せません', 'CHANGED_SINCE')
      }
      const changes = target.changes.map(c => ({ field: c.field, before: c.after, after: c.before }))
      const nextFields = Object.fromEntries(Object.entries(now.fields).filter(([k]) => !isPlaceOrLinkChange(k)))
      let nextState = now.state
      let nextLinks: RecordLinkRow[] | null = null
      for (const c of changes) {
        if (c.field === 'state') nextState = typeof c.after === 'string' ? c.after : null
        else if (c.field.startsWith('links.')) {
          const l = linkOf(c.field) as { name: string; target: string }
          const targets = linkTargetsOf(l.target, c.after)
          if (targets === null) return conflict('そのあとにも変更があるため、この変更だけを取り消せません', 'CHANGED_SINCE')
          // A file brought back is the one who took it off's (only its maker could see it to take it off).
          nextLinks = withLinkTargets(row.id, nextLinks ?? currentLinks, l.name, l.target, targets, target.actorId)
        } else nextFields[c.field] = c.after
      }
      const at = clock.now()
      const entry: LedgerEntry = {
        recordId: row.id, version: latest + 1, action: 'undo', fromState: now.state, toState: nextState, actorId: member.userId,
        actorKind: actor.kind, actorSource: actor.source ?? null, at, note, changes, attachments: [], decision: null, isDecision: false,
        typeVersion: row.typeVersion, reversesVersion: target.version, ...provenance(actor),
      }
      const written = transactions.run(() => {
        if (!records.writeState({ recordId: row.id, state: nextState, fields: JSON.stringify(nextFields), version: entry.version, updatedAt: at }, latest)) return false
        if (nextLinks) records.replaceLinks(row.id, nextLinks)
        records.appendLedger(entry)
        return true
      })
      if (!written) return conflict('ほかの人が先に変えました。最新の状態を見てからもう一度お試しください', 'VERSION_CONFLICT')
      tell(member, [nextFields.next_actor], { type: row.type, entry, fields: nextFields })
      // The services' follow-up of an undo (the inbox puts a mail back in the mailbox inbox).
      try { ctx.deps.afterAct?.(member.companyId, { type: row.type, entry, fields: nextFields }) } catch { /* the undo stands */ }
      return ok({ record: summaryOf(records, row.id), entry })
    },
  }
}

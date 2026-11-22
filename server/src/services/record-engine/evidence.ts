/**
 * What an action's evidence may name, and what a reader of the ledger is shown of it (records.md
 * "Evidence: decision materials and attached versions"). Evidence is a decision's `materials`, its
 * `precedents` / `supersedes` and an action's attached versions (`attachments`): the ledger keeps
 * them as written, and 経緯 (`history`, the AI's `records_history`) hands them to every reader of the
 * record — so they follow the link rule (`linkAllowed`, "never into a private folder from outside
 * it"; private-folders.md decision B):
 *
 * - on write (`act.ts`): a company file only when the actor reads it and the record may link to it,
 *   a record (material, precedent, supersedes) only when the actor reads it and the record may reach
 *   it — one answer for each kind, naming no place;
 * - on read: each entry is filtered by **the reader's current** access (what was stored is never
 *   changed): a company file they cannot read now (a private folder they are not in — also one made
 *   private after the entry, or an entry written before this rule), a record they cannot read, and
 *   someone else's `.personal/` path (records.md "Links into .personal/") are left out, as
 *   `scrubLedger` leaves out links — nothing stands in for them, so the answer cannot tell a hidden
 *   one from none. A reader of the folder keeps seeing it (the trail stays whole for those allowed).
 *   A Drive file is kept: its id, revision and fingerprint are every reader's by owner decision
 *   (records.md "Drive and PC file links"), and it carries no company path.
 */
import { findPrivateScope, type ScopeWithRules } from '../../../shared/core/permissions'
import type { LedgerEntry } from '../../../shared/core/record-ledger'
import { isOwnOnlyLinkTarget } from '../../../shared/core/records'
import type { RecordRepository } from '../../ports/records'
import { linkAllowed, type RecordReader } from '../record-access'

export interface EvidenceCheck {
  file(path: string): boolean
  record(id: string): boolean
}

/** What `reader` may name as evidence of `source` when writing: read by them, and reachable from the record (`linkAllowed`). */
export function evidenceToWrite(reader: RecordReader, scopes: ScopeWithRules[], records: RecordRepository, source: { scopeId: string | null }): EvidenceCheck {
  return {
    file: path => reader.file(path) && linkAllowed(source, { scopeId: findPrivateScope(scopes, path)?.id ?? null }),
    record(id) {
      const row = records.byIds([id])[0]
      return row !== undefined && reader.record(row) && linkAllowed(source, row)
    },
  }
}

/** What `reader` is shown of evidence already in the ledger: what they read now (no other condition). */
export function evidenceToShow(reader: RecordReader, records: RecordRepository): EvidenceCheck {
  const seen = new Map<string, boolean>()
  return {
    file: path => reader.file(path),
    record(id) {
      let shown = seen.get(id)
      if (shown === undefined) {
        const row = records.byIds([id])[0]
        shown = row !== undefined && reader.record(row)
        seen.set(id, shown)
      }
      return shown
    },
  }
}

/** The record id of a `<record id>@<version>` reference (precedents, supersedes). */
export const refId = (ref: string) => ref.slice(0, ref.lastIndexOf('@'))

/** The entries' evidence as `viewerId` may see it; an entry with nothing hidden is returned as it was. */
export function scrubEvidence<E extends LedgerEntry>(entries: readonly E[], viewerId: string, check: EvidenceCheck): E[] {
  return entries.map(e => {
    // Someone else's `.personal/` path is theirs alone, whatever the rules say.
    const fileShown = (path: string) => (!isOwnOnlyLinkTarget(path) || e.actorId === viewerId) && check.file(path)
    const attachments = e.attachments.filter(a => !('path' in a) || fileShown(a.path))
    const d = e.decision
    const decision = d === null ? null : {
      ...d,
      materials: d.materials.filter(m => (m.kind === 'file' ? fileShown(m.path) : m.kind === 'record' ? check.record(m.id) : true)),
      precedents: d.precedents.filter(p => check.record(refId(p))),
      supersedes: d.supersedes !== null && check.record(refId(d.supersedes)) ? d.supersedes : null,
    }
    const same = attachments.length === e.attachments.length && (d === null || (decision !== null
      && decision.materials.length === d.materials.length && decision.precedents.length === d.precedents.length && decision.supersedes === d.supersedes))
    return same ? e : { ...e, attachments, decision }
  })
}

/**
 * A link into a `.personal/` folder, and a link to a file of a member's PC (`local:`), is its maker's
 * alone (records.md "Links into .personal/", "Drive and PC file links"): the ledger
 * keeps a file link's whole target list (`links.<name>`, a JSON array of targets), so 経緯 and a
 * replay leave out those targets someone else linked — and an entry that then says nothing (another
 * member's 「ファイルをつなぎました」 of such a file) is left out too. The same scrub keeps them out of
 * the entry a link change or an undo answers.
 */
import { fileLinkKind, isOwnOnlyLinkTarget, fileLinkShown, localLinkOwner } from '../../../shared/core/records'
import type { LedgerEntry, LedgerValue } from '../../../shared/core/record-ledger'
import type { RecordLinkRow } from '../../ports/records'

function paths(value: LedgerValue): string[] | null {
  if (typeof value !== 'string' || !value.startsWith('[')) return null
  try {
    const v: unknown = JSON.parse(value)
    return Array.isArray(v) && v.every(p => typeof p === 'string') ? v as string[] : null
  } catch {
    return null
  }
}

/** The `.personal/` paths `viewerId` may see in this record's ledger: the ones they linked. */
export function personalPathsSeen(viewerId: string, source: { personalOwner: string | null }, entries: readonly LedgerEntry[], links: readonly RecordLinkRow[]): Set<string> {
  const seen = new Set(links.filter(l => l.targetPath !== null && isOwnOnlyLinkTarget(l.targetPath) && fileLinkShown(viewerId, source, l)).map(l => l.targetPath as string))
  for (const e of entries) {
    for (const c of e.changes) {
      if (!c.field.startsWith('links.')) continue
      // A PC's file is seen by its owner alone, whoever's entry names it.
      for (const p of [...(paths(c.before) ?? []), ...(paths(c.after) ?? [])]) {
        if (fileLinkKind(p) === 'local' && localLinkOwner(p) === viewerId) seen.add(p)
      }
      if (e.actorId !== viewerId) continue
      const before = paths(c.before) ?? []
      for (const p of paths(c.after) ?? []) if (isOwnOnlyLinkTarget(p) && fileLinkKind(p) !== 'local' && !before.includes(p)) seen.add(p)
    }
  }
  return seen
}

/** A `links.*` value without the `.personal/` paths not in `seen` (null when none is left). */
export function scrubLinkValue(value: LedgerValue, seen: ReadonlySet<string>): LedgerValue {
  const list = paths(value)
  if (!list) return value
  const kept = list.filter(p => !isOwnOnlyLinkTarget(p) || seen.has(p))
  if (kept.length === list.length) return value
  return kept.length > 0 ? JSON.stringify(kept) : null
}

/** The entries as `viewerId` may see them. */
export function scrubLedger<E extends LedgerEntry>(entries: readonly E[], seen: ReadonlySet<string>): E[] {
  return entries.flatMap(e => {
    let touched = false
    const changes = e.changes.map(c => {
      if (!c.field.startsWith('links.')) return c
      const before = scrubLinkValue(c.before, seen)
      const after = scrubLinkValue(c.after, seen)
      if (before !== c.before || after !== c.after) touched = true
      return { ...c, before, after }
    })
    if (!touched) return [e]
    const left = changes.filter(c => !c.field.startsWith('links.') || c.before !== c.after)
    return left.length === 0 ? [] : [{ ...e, changes: left }]
  })
}

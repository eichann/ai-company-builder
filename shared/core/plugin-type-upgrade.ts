/**
 * A company's extension of a plugin type against a newer plugin version
 * (plan C2, fit ladder ④, `.claude/rules/plugins.md` "Fitting a company").
 *
 * A company extends a business plugin's type with its own
 * `.acb/types/<name>.md` (a higher version, additive). When the company
 * chooses (or turns on) a plugin version whose type is newer, storing that
 * type over the company's would drop the company's fields. Instead the
 * conflicts are reported and nothing is stored over the company's
 * definition; the company (div's FDE) updates its extension first.
 *
 * A conflict is: the company's version is no longer higher than the plugin's
 * new one, or the company's definition lacks / changes the meaning of
 * something the plugin's new definition has (a field, link, state, action,
 * shared type or the storage) — the same comparison the index applies to a
 * company's own type change (`compareTypeDefinitions`).
 */
import { compareTypeDefinitions, type TypeDefinition } from './record-types'

/** Sentences (Japanese, for the admin) naming each conflict; empty = the extension still holds. */
export function companyExtensionConflicts(company: TypeDefinition, incoming: TypeDefinition): string[] {
  const out: string[] = []
  const name = incoming.name
  if (incoming.version >= company.version) {
    out.push(`型「${name}」: 会社で広げた定義（版 ${company.version}）が、新しい版の型（版 ${incoming.version}）より新しくなくなります`)
  }
  // What the plugin's new definition has must still be in the company's, with the same meaning.
  for (const b of compareTypeDefinitions(incoming, company).breaking) {
    out.push(`型「${name}」: 会社で広げた定義が新しい版と合いません（新しい版に対して「${b}」ことになります）`)
  }
  return out
}

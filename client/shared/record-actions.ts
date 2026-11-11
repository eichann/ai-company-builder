/**
 * The record actions a screen may offer (`records.runAction`, commands.md):
 * generated from the type definition, one choice per action that can start
 * from the record's current state. Who may run it is the server's decision
 * (the engine's `who`); this only keeps impossible choices off the screen.
 * Pure (`client/shared`).
 */
import { isSystemOnly, linkWhoName, type TypeDefinition } from '../../shared/core/record-types'

export interface RecordActionChoice {
  action: string
  /** The Japanese label from the definition (「レビューを依頼する」). */
  title: string
  noteRequired: boolean
  /** Arguments the member must give (each sets the server field of the same name). */
  args: string[]
  /**
   * Person fields whose holder may also run it by saying whose OK it was
   * (`ok_from`; the task's assignee completing): the screen asks for `ok`.
   */
  okFrom: string[]
  /** Record links the member may set with it (`links`: a task's `set_bundle` → bundle). */
  links: string[]
}

export function recordActionChoices(def: TypeDefinition, state: string | null): RecordActionChoice[] {
  return Object.entries(def.actions)
    .filter(([, a]) => a.from === null || (state !== null && a.from.includes(state)))
    // `who: [system]`: only the server's own services run it — never offered to a person.
    .filter(([, a]) => !isSystemOnly(a.who))
    .map(([action, a]) => ({ action, title: a.label, noteRequired: a.note === 'required', args: Object.keys(a.args), okFrom: a.okFrom ?? [], links: a.links ?? [] }))
}

/**
 * Whether `who` (an action's, after `who_unless`: `actionWho`) names the member by what the app
 * knows: `anyone`, a person field of the record holding them, or `link:<name>` when the server
 * answered that link's record (so they read it). Roles (`admin`, `dept_manager`) and delegates are
 * not known to the app: they are never offered here, so a screen never offers what the server
 * would refuse (an admin may still be allowed by the server). The task card and the bundle card
 * both decide with this.
 */
export function personInWho(who: readonly string[], def: Pick<TypeDefinition, 'fields'>, fields: Readonly<Record<string, unknown>>, me: string, readsLink: (name: string) => boolean = () => false): boolean {
  return who.includes('anyone') || who.some(w => (def.fields[w]?.kind === 'person' && fields[w] === me) || (linkWhoName(w) !== null && readsLink(linkWhoName(w) as string)))
}

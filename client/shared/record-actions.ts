/**
 * The record actions a screen may offer (`records.runAction`, commands.md):
 * generated from the type definition, one choice per action that can start
 * from the record's current state. Who may run it is the server's decision
 * (the engine's `who`); this only keeps impossible choices off the screen.
 * Pure (`client/shared`).
 */
import type { TypeDefinition } from '../../shared/core/record-types'

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
    .map(([action, a]) => ({ action, title: a.label, noteRequired: a.note === 'required', args: Object.keys(a.args), okFrom: a.okFrom ?? [], links: a.links ?? [] }))
}

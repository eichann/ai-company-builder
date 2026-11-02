/**
 * Acceptance (引き受け, records.md "Acceptance"): where a create or an action
 * leaves a request whose assignee has not accepted it. The rule's shape is
 * `ACCEPTANCE` (shared/core/core-types.ts); whether a case is accepted by
 * itself is the company's setting, asked through `deps.autoAccepts`
 * (services/task-acceptance.ts). Changes `fields` in place (`accepted_by`,
 * `next_actor`) and returns the state the record ends in.
 */
import { acceptanceOf } from '../../../shared/core/core-types'
import type { LedgerValue } from '../../../shared/core/record-ledger'
import type { RecordRepository } from '../../ports/records'
import type { RecordEngineDeps } from './types'

export interface AcceptanceInput {
  companyId: string
  type: string
  /** The record's type version (records indexed under an older one never wait). */
  typeVersion: number
  /** Owner-only (「持ち主だけ」): only its owner is ever in it — accepted at once, never waits. */
  personal: boolean
  state: string | null
  /** The state before the action (null on a create). */
  fromState?: string | null
  fields: Record<string, LedgerValue>
  /** The action set a different assignee. */
  assigneeChanged: boolean
  /** The member acting (the person, or the person whose AI it is). */
  memberId: string
  actorKind: 'human' | 'ai'
  /** The absentee the member acts for in this action (their delegate), if any. */
  onBehalfOf: string | null
  /** The record ids of the record's origin link after the change (the meeting it is homework of). */
  originIds: string[]
  records: RecordRepository
}

const str = (v: LedgerValue | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function applyAcceptance(deps: Pick<RecordEngineDeps, 'autoAccepts'>, a: AcceptanceInput): string | null {
  const t = acceptanceOf(a.type)
  if (!t || a.typeVersion < t.since || a.state === null) return a.state
  const f = a.fields
  let state = a.state
  if (t.releases.includes(state)) {
    // 受けられない forgets the acceptance; someone new assigned there is asked like a new request.
    if (!a.assigneeChanged) {
      if ((f[t.acceptedBy] ?? null) !== null) f[t.acceptedBy] = null
      return state
    }
    state = t.into
  }
  const assignee = str(f[t.assignee])
  // 完了 straight from 引き受け待ち by the assignee (or their delegate): 「引き受けた」 is recorded with it.
  if (a.fromState === t.state && t.finishes.includes(state)) {
    if (assignee !== null && a.actorKind === 'human' && (a.memberId === assignee || a.onBehalfOf === assignee)) f[t.acceptedBy] = assignee
    return state
  }
  if (state !== t.state && !t.working.includes(state)) return state
  if (assignee === null) return state === t.state ? t.into : state
  const accepted = () => {
    f[t.acceptedBy] = assignee
    if (state === t.state || state === t.into) f.next_actor = assignee
    return state === t.state ? t.into : state
  }
  // Owner-only: only its owner is ever in it — accepted, whatever the settings.
  if (a.personal || str(f[t.acceptedBy]) === assignee) return accepted()
  // A person acting as the assignee (themselves, or their delegate during the absence) accepts by
  // doing so — 「引き受ける」 itself. Never the AI: it cannot accept for a person.
  if (a.actorKind === 'human' && (a.memberId === assignee || a.onBehalfOf === assignee)) return accepted()
  const asker = a.assigneeChanged ? a.memberId : (str(f[t.requester]) ?? a.memberId)
  if (asker === assignee) return accepted()
  const attended = () => {
    if (a.originIds.length === 0) return false
    return a.records.states(a.originIds).some(s => {
      try {
        const list = JSON.parse(String((JSON.parse(s.fields) as Record<string, LedgerValue>)[t.attendees] ?? '[]')) as unknown
        return Array.isArray(list) && list.includes(assignee)
      } catch { return false }
    })
  }
  // Without the setting (an engine built for a test of something else) every request is accepted as before.
  const auto = deps.autoAccepts
    ? deps.autoAccepts(a.companyId, { asker, assignee, byAi: a.actorKind === 'ai', assigneeAttendedOrigin: attended() })
    : true
  if (auto) return accepted()
  f.next_actor = assignee
  return t.state
}

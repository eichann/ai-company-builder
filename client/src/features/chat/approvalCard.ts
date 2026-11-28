// The approval card's words and decisions that need no React (approvals.md "The app", owner decision 2026-11-28 12番 案A):
// what the folded rows say, why the approve button cannot be pressed yet, and when a press finished the request.
import { APPROVE_HASH_NOTE, type ApprovalState, type ApprovalView } from '../../../../shared/types/approvals'

export type ApprovalPress = 'approve' | 'send-back' | 'withdraw' | 'same-as'

/** The state a press leaves the request in when it did what it meant (an approve can also answer `failed` or `stale`). */
const DONE_STATE: Record<ApprovalPress, ApprovalState> = { approve: 'approved', 'send-back': 'sent_back', withdraw: 'withdrawn', 'same-as': 'withdrawn' }

/** Whether the server's answer to a press finished the request (where the card is worked through a list: go on to the next one). */
export const pressFinished = (kind: ApprovalPress, state: ApprovalState): boolean => DONE_STATE[kind] === state

/** How many characters of the quote the folded row shows. */
export const QUOTE_PEEK_MAX = 24

/** The quote's first line for the folded row (「受講者を 40 名から…」): cut where it is long, and marked when more follows. */
export function quotePeek(quote: string, max = QUOTE_PEEK_MAX): string {
  const lines = quote.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  const first = Array.from(lines[0] ?? '')
  if (first.length > max) return `${first.slice(0, max).join('')}…`
  return lines.length > 1 ? `${first.join('')}…` : first.join('')
}

/** The folded basis row: the quote's first words when there is one, else how many materials; null = nothing to unfold. */
export function basisSummary(view: Pick<ApprovalView, 'basis' | 'materials'>): string | null {
  const quote = view.basis.quote?.trim() ? view.basis.quote : null
  const materials = view.materials.length
  if (quote) return `根拠：『${quotePeek(quote)}』${materials > 0 ? `（材料 ${materials}）` : ''}`
  return materials > 0 ? `根拠：材料 ${materials}` : null
}

/** The line beside the buttons: what the approver still has to do, else what pressing 「承認する」 checks. */
export function answerHint(o: { mustChoose: boolean; reasonEmpty: boolean }): string {
  if (o.mustChoose) return '先に「同じかどうか」を選ぶと承認できます'
  if (o.reasonEmpty) return '理由を書くと押せます'
  return APPROVE_HASH_NOTE
}

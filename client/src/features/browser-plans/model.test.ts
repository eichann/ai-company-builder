// What a 「ブラウザ操作」 plan's card says (model.ts; agent-browser.md "The card, the IPC and the request tool").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserFact } from '../../../../shared/core/browser-plans'
import type { BrowserExecutionView, BrowserPlanView } from '../../../../shared/types/browser-plans'
import { notReadyText, planContent, planStatus, runResultText } from './model'

const at = '2026-11-22T03:00:00.000Z'
const fact = (value: unknown): BrowserFact => ({ status: 'known', value, readAt: at, source: '/x' })
const unknown: BrowserFact = { status: 'unknown', readAt: at, source: '/x' }

function plan(over: Partial<BrowserPlanView> = {}, facts: Record<string, BrowserFact> = {}): BrowserPlanView {
  return {
    id: `bp_${'a'.repeat(32)}`, state: 'draft', closeReason: null, connector: { id: 'lstep', version: '0.6.0', label: 'Lステップ' }, operation: 'op',
    label: 'リマインダの段にテンプレートを足す', sharedNote: null, delivers: 'scheduled', account: '1', target: { reminder: '7', step: '8' },
    change: { template: '9' },
    facts: {
      names: fact({ reminder: '11月のリマインダ', step: '当日' }), state: fact({ templates: ['5'] }),
      templates: fact({ 5: { name: '当日のご案内', kind: 'text', body: '本日です' }, 9: { name: '持ち物', kind: 'text', body: '筆記用具' } }),
      schedule: fact({ timing: '当日 09:00' }), audience: unknown, ...facts,
    },
    explanation: null, createdAt: at, expiresAt: '2026-11-22T04:00:00.000Z', approvedAt: null, contentHash: `sha256:${'c'.repeat(64)}`, execution: null, ...over,
  }
}
const exec = (state: BrowserExecutionView['state'], confirmableAt: string | null = null): BrowserExecutionView =>
  ({ id: `bx_${'b'.repeat(32)}`, state, claimedAt: at, permittedAt: at, settledAt: null, confirmableAt, voidReason: null, confirmedBy: null })

test('an unread count is 「読み取れませんでした」, never 0; a known 0 stays 0', () => {
  assert.deepEqual(planContent(plan()).audience, { known: false })
  assert.deepEqual(planContent(plan({}, { audience: fact({ count: 0 }) })).audience, { known: true, count: 0 })
})

test('the card shows the templates by the facts the checker read, and the one to add from the plan', () => {
  const c = planContent(plan())
  assert.deepEqual(c.onStep.map(t => t.name), ['当日のご案内'])
  assert.equal(c.toAdd?.name, '持ち物')
  assert.equal(c.timing, '当日 09:00')
})

test('waiting for approval is the only state with ［任せる］; a result nobody knows tells what to check, never offers a resend, and confirms only once the time came', () => {
  const now = Date.parse(at)
  assert.equal(planStatus({ plan: plan(), runningHere: false }, now).awaiting, true)
  for (const s of ['claimed', 'permitted', 'succeeded', 'failed', 'void', 'unknown', 'confirmed_done', 'confirmed_not_done'] as const) {
    assert.equal(planStatus({ plan: plan({ state: 'claimed', execution: exec(s) }), runningHere: false }, now).awaiting, false, s)
  }
  const early = planStatus({ plan: plan({ state: 'claimed', execution: exec('unknown', '2026-11-22T03:00:35.000Z') }), runningHere: false }, now)
  assert.equal(early.line, '届いたか分かりません。')
  assert.match(early.check ?? '', /Lステップで「11月のリマインダ」の「当日」の段を開いて、テンプレート「持ち物」が足されているか/)
  assert.equal(early.canConfirm, false)
  assert.ok(early.confirmFrom)
  assert.equal(early.noResend, true)
  const later = planStatus({ plan: plan({ state: 'claimed', execution: exec('unknown', '2026-11-22T03:00:35.000Z') }), runningHere: false }, now + 35_000)
  assert.equal(later.canConfirm, true)
  // Permitted and not running here: it may have been sent, so it is never shown as stopped or offered again.
  const lost = planStatus({ plan: plan({ state: 'claimed', execution: exec('permitted') }), runningHere: false }, now)
  assert.equal(lost.tone, 'unknown')
  assert.equal(planStatus({ plan: plan({ state: 'claimed', execution: exec('failed') }), runningHere: false }, now).line, '送る前に止めました。この操作の送信は行っていません。')
})

test('plain words for why ［任せる］ is off and for what a press led to (a changed site is never "sent")', () => {
  assert.match(notReadyText('no-window', 'Lステップ') ?? '', /このパソコンではLステップの窓が開いていません/)
  assert.equal(runResultText({ outcome: 'stopped', reason: 'facts-changed' }), '承認のあとでサイトの中身が変わったので、送りませんでした。')
  assert.match(runResultText({ outcome: 'unknown', reason: 'no-answer' }), /届いたか分かりません.*もう一度は送りません/)
  assert.match(runResultText({ outcome: 'refused', reason: 'approve-refused', code: 'CONTENT_CHANGED' }), /開き直して/)
  for (const r of [runResultText({ outcome: 'failed', reason: 'permit-late' }), notReadyText('off', 'Lステップ') ?? '']) {
    for (const word of ['安全です', 'sha256', 'ハッシュ', 'トークン']) assert.equal(r.includes(word), false)
  }
})

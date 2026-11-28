// The approval card's words and decisions (owner decision 2026-11-28, 12番 案A): the folded basis row shows the quote's
// first words, the line beside the buttons says what is missing, and only a press that finished the request moves a list on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVE_HASH_NOTE } from '../../../../shared/types/approvals'
import { answerHint, basisSummary, pressFinished, quotePeek, QUOTE_PEEK_MAX } from './approvalCard'

test('the folded basis row shows the quote\'s first line, cut where it is long and marked when more follows', () => {
  assert.equal(quotePeek('受講者を 40 名から 60 名に増やしたい'), '受講者を 40 名から 60 名に増やしたい')
  assert.equal(quotePeek('受講者を増やしたい\n予算は来週決める'), '受講者を増やしたい…')
  assert.equal(quotePeek('\n  最初の行  \n'), '最初の行')
  const long = 'あ'.repeat(QUOTE_PEEK_MAX + 5)
  assert.equal(quotePeek(long), `${'あ'.repeat(QUOTE_PEEK_MAX)}…`)
  // Cut by characters, never in the middle of one (an emoji is two UTF-16 units).
  assert.equal(quotePeek('😀'.repeat(QUOTE_PEEK_MAX + 1)), `${'😀'.repeat(QUOTE_PEEK_MAX)}…`)
})

test('the basis row: the quote first, else the materials; nothing to unfold → null', () => {
  const material = { kind: 'meeting' as const, recordId: 'meeting-000001', title: '11/5 商談', version: null }
  const basis = (quote: string | null) => ({ meetingId: null, meetingTitle: null, quote })
  assert.equal(basisSummary({ basis: basis('受講者を 40 名から'), materials: [] }), '根拠：『受講者を 40 名から』')
  assert.equal(basisSummary({ basis: basis('受講者を 40 名から'), materials: [material, material] }), '根拠：『受講者を 40 名から』（材料 2）')
  assert.equal(basisSummary({ basis: basis(null), materials: [material] }), '根拠：材料 1')
  assert.equal(basisSummary({ basis: basis('  '), materials: [] }), null)
})

test('the line beside the buttons: choose first, then the reason, then what 「承認する」 checks', () => {
  assert.equal(answerHint({ mustChoose: true, reasonEmpty: true }), '先に「同じかどうか」を選ぶと承認できます')
  assert.equal(answerHint({ mustChoose: false, reasonEmpty: true }), '理由を書くと押せます')
  assert.equal(answerHint({ mustChoose: false, reasonEmpty: false }), APPROVE_HASH_NOTE)
})

test('a press finished the request only in the state it meant: a failed or stale write stays on the card', () => {
  assert.equal(pressFinished('approve', 'approved'), true)
  assert.equal(pressFinished('approve', 'failed'), false)
  assert.equal(pressFinished('approve', 'stale'), false)
  assert.equal(pressFinished('approve', 'pending'), false)
  assert.equal(pressFinished('send-back', 'sent_back'), true)
  assert.equal(pressFinished('withdraw', 'withdrawn'), true)
  assert.equal(pressFinished('same-as', 'withdrawn'), true)
  assert.equal(pressFinished('same-as', 'pending'), false)
})

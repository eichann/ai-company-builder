// 「わたしの書き方に合わせる」 on 「仕事の道具をつなぐ」 (writingStyle.ts). What it protects:
// - a correction the main process would drop (a name with an honorific, an address, money, an instruction) is refused
//   with words before anything is sent, never saved as an empty field the member did not ask for;
// - the check names only the tools the server answered, and says plainly when nothing can be read yet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WritingStyle } from '../../../../shared/core/writing-style'
import type { WritingStyleStatus } from '../../../shared/writing-style'
import { WRITING_DROPPED_TEXT, WRITING_NOT_READABLE_TEXT, withWritingText, writingCheckHint, writingCheckOffered, writingStatusLine } from './writingStyle'

const STYLE: WritingStyle = { greeting: 'お疲れさまです。', closing: 'よろしくお願いします。', sentenceLength: 'short', politeness: 'polite', phrases: ['承知しました'], emoji: 'none', notes: '' }
const status = (over: Partial<WritingStyleStatus> = {}): WritingStyleStatus => ({
  available: true, enabled: true, building: false, sources: [{ connectorId: 'mailco', label: 'メールの道具', readable: true }], styles: [], note: null, ...over,
})

test('a correction the rule would drop is refused with words, never sent half-empty', () => {
  for (const [field, typed] of [['greeting', '山田さん、お疲れさまです'], ['closing', '振込先は口座 123 へ'], ['phrases', '承知しました／a@b.example'], ['notes', 'https://example.com を見て']] as const) {
    assert.deepEqual(withWritingText(STYLE, field, typed), { problem: WRITING_DROPPED_TEXT }, `${field}: ${typed}`)
  }
  assert.deepEqual(withWritingText(STYLE, 'phrases', '承知しました／助かります、了解です'), { style: { ...STYLE, phrases: ['承知しました', '助かります', '了解です'] } })
  assert.deepEqual(withWritingText(STYLE, 'greeting', '  '), { style: { ...STYLE, greeting: '' } })
  assert.deepEqual(withWritingText(STYLE, 'closing', 'では！'), { style: { ...STYLE, closing: 'では！' } })
})

test('the check names the tools the server answered, and says when nothing can be read yet', () => {
  assert.match(writingCheckHint(status()), /^メールの道具で送ったメッセージの直近20件から/)
  assert.match(writingCheckHint(status()), /この PC だけに置き/)
  assert.equal(writingCheckOffered(status({ sources: [] })), false)
  assert.equal(writingCheckOffered(null), false)
  assert.equal(writingStatusLine(status({ available: false })), WRITING_NOT_READABLE_TEXT)
  assert.equal(writingStatusLine(status({ enabled: false, available: false })), null)
  assert.match(writingStatusLine(status({ building: true })) ?? '', /まとめています/)
})

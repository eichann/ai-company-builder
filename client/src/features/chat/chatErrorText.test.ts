// The chat's red error bar (chatErrorText.ts): a refusal from the chat server shows its own
// sentence, never the raw JSON with its code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorText } from './chatErrorText'

const generic = (error: string) => `エラーが発生しました: ${error}`

test('the emergency stop refusal shows only the sentence the server wrote', () => {
  const body = JSON.stringify({ error: '管理者が AI の利用を一時停止しています。', code: 'AI_STOPPED' })
  const text = chatErrorText(body, generic)
  assert.equal(text, '管理者が AI の利用を一時停止しています。')
  assert.doesNotMatch(text, /[{}"]|AI_STOPPED/)
})

test('a message that is not a refusal body keeps the generic prefix', () => {
  assert.equal(chatErrorText('network down', generic), 'エラーが発生しました: network down')
  assert.equal(chatErrorText('{not json', generic), 'エラーが発生しました: {not json')
  assert.equal(chatErrorText(JSON.stringify({ code: 'X' }), generic), `エラーが発生しました: ${JSON.stringify({ code: 'X' })}`)
  assert.equal(chatErrorText(JSON.stringify({ error: '  ' }), generic), `エラーが発生しました: ${JSON.stringify({ error: '  ' })}`)
})

// Tag suggestions (client/shared/tag-suggest.ts, electron/features/tasks/tag-suggest.ts,
// tasks-ui.md "Tag suggestions"). Guards: only the title and the tags in use are sent, through
// the company's key (the broker's token and relay), with the registry's Haiku model and no
// tools; the AI may only point at tags in use (a reading variant maps to the tag, an invented
// one is dropped); no key, the placeholder, the AI stopped, a failure or no answer in time fall
// back to the app's own matching without an error; nothing is sent with no tags in use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTagSuggester, TAG_SUGGEST_JOB, type TagSuggestCall } from '../electron/features/tasks/tag-suggest'
import { localTagSuggestions, parseTagSuggestions, TAG_SUGGEST_LIMITS, tagSuggestInput, tagSuggestMessage } from '../shared/tag-suggest'
import { COMPANY_KEY_MODELS } from '../shared/agents/registry'

const TOKEN = `acb_tok_${'a'.repeat(64)}`
const RELAY = 'https://acb.test/api/broker/anthropic'
const ENV = { ACB_ANTHROPIC_API_KEY: TOKEN, ACB_ANTHROPIC_BASE_URL: RELAY }
const IN_USE = ['営業', '見積', 'Design']
const quiet = { warn: () => {} }

test('the message carries only the title and the tags in use, within the limits', () => {
  const input = tagSuggestInput(`  ${'あ'.repeat(300)}  `, ['営業', '営業', '', 'x'.repeat(51), 3, ...Array.from({ length: 300 }, (_, i) => `t${i}`)])!
  assert.equal(input.title.length, TAG_SUGGEST_LIMITS.title)
  assert.equal(input.tags.length, TAG_SUGGEST_LIMITS.tags)
  assert.deepEqual(input.tags.slice(0, 2), ['営業', 't0'])
  assert.deepEqual(Object.keys(JSON.parse(tagSuggestMessage(input))), ['title', 'tags'])
  assert.equal(tagSuggestInput('   ', ['営業']), null)
})

test('the AI may only point at tags in use: a reading variant maps to the tag, an invented one is dropped', () => {
  assert.deepEqual(parseTagSuggestions('```json\n{"tags": ["営業", "新しいタグ", "ＤＥＳＩＧＮ", "営業", "見積"]}\n```', IN_USE), ['営業', 'Design', '見積'])
  assert.deepEqual(parseTagSuggestions('{"tags": ["a", "b", "営業", "見積", "Design", "x"]}', IN_USE).length, 3)
  assert.deepEqual(parseTagSuggestions('営業がいいと思います', IN_USE), [])
  assert.deepEqual(parseTagSuggestions('{"tags": "営業"}', IN_USE), [])
})

test('the app\'s own matching: tags in use whose spelling (width, case, kana) appears in the title', () => {
  assert.deepEqual(localTagSuggestions('ｴｲｷﾞｮｳ会議の見積を直す', ['エイギョウ', '見積', '経理']), ['エイギョウ', '見積'])
})

test('asked through the company\'s key with the registry\'s Haiku model; only the title and tags reach it', async () => {
  const calls: TagSuggestCall[] = []
  const envs: Array<{ companyId: string; conversationId: string }> = []
  const s = createTagSuggester({
    brokerEnv: async r => { envs.push(r); return ENV },
    generate: async call => { calls.push(call); return '{"tags": ["えいぎょう", "営業"]}' },
    log: quiet,
  })
  assert.deepEqual(await s.suggest('co1', 'えいぎょう資料を直す', IN_USE), { source: 'ai', tags: ['営業'] })
  assert.deepEqual(envs, [{ companyId: 'co1', conversationId: TAG_SUGGEST_JOB }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].token, TOKEN)
  assert.equal(calls[0].baseUrl, RELAY)
  assert.equal(calls[0].model, COMPANY_KEY_MODELS.tagSuggest)
  assert.deepEqual(JSON.parse(calls[0].message), { title: 'えいぎょう資料を直す', tags: IN_USE })
})

test('no key, the placeholder, the AI stopped, a failure or no answer in time: the app\'s own matching, no error', async () => {
  const sent: string[] = []
  const generate = async (call: TagSuggestCall) => { sent.push(call.token); return '{"tags": ["Design"]}' }
  const local = { source: 'local', tags: ['見積'] }
  for (const brokerEnv of [async () => ({}), async () => ({ ...ENV, ACB_ANTHROPIC_API_KEY: 'acb_tok_none' }), async () => ({ ...ENV, ACB_ANTHROPIC_API_KEY: 'sk-ant-real' })]) {
    assert.deepEqual(await createTagSuggester({ brokerEnv, generate, log: quiet }).suggest('co1', '見積を直す', IN_USE), local)
  }
  assert.deepEqual(await createTagSuggester({ brokerEnv: async () => ENV, generate, aiAllowed: () => false, log: quiet }).suggest('co1', '見積を直す', IN_USE), local)
  assert.deepEqual(sent, [])

  const failing = createTagSuggester({ brokerEnv: async () => ENV, generate: async () => { throw new Error('429') }, log: quiet })
  assert.deepEqual(await failing.suggest('co1', '見積を直す', IN_USE), local)
  const slow = createTagSuggester({
    brokerEnv: async () => ENV, timeoutMs: 20, log: quiet,
    generate: call => new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  })
  assert.deepEqual(await slow.suggest('co1', '見積を直す', IN_USE), local)
})

test('nothing is sent with no tags in use or a bad company id', async () => {
  let asked = 0
  const s = createTagSuggester({ brokerEnv: async () => { asked++; return ENV }, generate: async () => '{"tags": []}', log: quiet })
  assert.deepEqual(await s.suggest('co1', '見積を直す', []), { source: 'local', tags: [] })
  assert.deepEqual(await s.suggest('../co1', '見積を直す', IN_USE), { source: 'local', tags: [] })
  assert.equal(asked, 0)
})

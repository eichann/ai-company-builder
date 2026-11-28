/**
 * The operator's tool sets of 「ブラウザ操作」 (agent-browser.md "The operator's tool sets"). Guards:
 * - a compact answer becomes exactly today's action (a select's `set` a choice, any other a typing, `go` back a back),
 *   so the one parser and everything after it judge it — never a looser reading;
 * - the compact prompts are shorter and teach only the compact words, the ends and the rules are every set's;
 * - the operator is started with the chosen set's prompt only; an unknown stored value is today's set.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_OPERATOR_BROWSE_PROMPT, OPERATOR_ACTION_LINES, OPERATOR_SCREEN_LINES, parseBrowseAnswer, readBrowserPageSnapshot, type BrowserPageSnapshot,
} from '../shared/browser-browse'
import { BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT, parseWorkAnswer } from '../shared/browser-frame-writes'
import { browserOperatorArgs } from '../shared/browser-operator'
import {
  BROWSER_OPERATOR_TOOLSETS, browserOperatorToolset, browserToolsetPrompt, readToolsetAnswer, toolsetHistory, type BrowserOperatorToolset,
} from '../shared/browser-operator-toolsets'

const HOST = 'shop.example.test'
const page: BrowserPageSnapshot = readBrowserPageSnapshot(JSON.stringify({
  address: `https://${HOST}/a`, title: 't', text: 'x', truncated: false,
  elements: [
    { ref: 0, role: 'textbox', name: '名前', value: '', logLabel: '名前' },
    { ref: 1, role: 'select', name: '設定', options: ['A設定', 'B設定'], logLabel: '設定' },
    { ref: 2, role: 'password', name: 'パスワード' },
    { ref: 3, role: 'button', name: '登録', logLabel: '登録' },
  ],
}), HOST)!

const parse = (set: BrowserOperatorToolset, text: string) => {
  const read = readToolsetAnswer(set, text, page)
  return 'problem' in read ? read : parseBrowseAnswer(read.text, { snapshot: page, items: 2 })
}

test('a compact answer is read as exactly today\'s action, its memo keys kept', () => {
  const pairs: Array<[string, string]> = [
    ['{"do":"set","ref":0,"value":"冬の回","reason":"名前"}', '{"do":"type","ref":0,"text":"冬の回","reason":"名前"}'],
    ['{"do":"set","ref":1,"value":"B設定","notes":"n"}', '{"do":"select","ref":1,"option":"B設定","notes":"n"}'],
    ['{"do":"set","value":"今の欄"}', '{"do":"type","text":"今の欄"}'],
    ['{"do":"go","path":"back","unlisted":"u"}', '{"do":"back","unlisted":"u"}'],
    ['{"do":"go","path":"/b?c=1"}', '{"do":"go","path":"/b?c=1"}'],
    ['{"do":"click","ref":3}', '{"do":"click","ref":3}'],
    ['{"do":"wait","seconds":2}', '{"do":"wait","seconds":2}'],
    ['{"do":"done","result":"r","unread":[1]}', '{"do":"done","result":"r","unread":[1]}'],
  ]
  for (const [compact, current] of pairs) assert.deepEqual(parse('compact', compact), parse('current', current), compact)
})

test('the one parser judges a compact answer: a password field, a wrong role, an option not offered, a long text are refused as for today\'s words', () => {
  assert.deepEqual(parse('compact', '{"do":"set","ref":2,"value":"x"}'), { problem: 'ref' })
  assert.deepEqual(parse('compact', '{"do":"set","ref":3,"value":"x"}'), { problem: 'ref' })
  assert.deepEqual(parse('compact', '{"do":"set","ref":1,"value":"C設定"}'), { problem: 'option' })
  assert.deepEqual(parse('compact', `{"do":"set","ref":0,"value":"${'x'.repeat(201)}"}`), { problem: 'text' })
  assert.deepEqual(parse('compact', '{"do":"set","ref":0}'), { problem: 'keys' })
  // A key the reading would write is never overwritten: refused.
  assert.deepEqual(parse('compact', '{"do":"set","ref":1,"value":"B設定","option":"A設定"}'), { problem: 'keys' })
  assert.deepEqual(parse('compact', '{"do":"set","ref":0,"value":"a","text":"b"}'), { problem: 'keys' })
  assert.deepEqual(parse('compact', '{"do":"go","path":"back","x":1}'), { problem: 'keys' })
  assert.deepEqual(parse('compact', 'text {"do":"set","ref":0,"value":"a"}'), { problem: 'not-json' })
  // A `__proto__` key stays a plain key (never the object's prototype) and is refused as an extra key.
  assert.deepEqual(parse('compact', '{"do":"set","ref":0,"value":"a","__proto__":{"text":"b"}}'), { problem: 'keys' })
  assert.deepEqual(parse('compact', '{"do":"go","path":"back","__proto__":{"path":"/x"}}'), { problem: 'keys' })
})

test('each set knows only its own words', () => {
  for (const word of ['{"do":"type","ref":0,"text":"a"}', '{"do":"select","ref":1,"option":"A設定"}', '{"do":"back"}']) {
    assert.deepEqual(parse('compact', word), { problem: 'shape' }, word)
  }
  assert.deepEqual(parse('current', '{"do":"set","ref":0,"value":"a"}'), { problem: 'shape' })
  // A write run's answers go through the same reading (its ends untouched).
  const work = (set: BrowserOperatorToolset, text: string) => {
    const read = readToolsetAnswer(set, text, page)
    return 'problem' in read ? read : parseWorkAnswer(read.text, { snapshot: page, items: 0, phase: 'work', adhoc: false, domain: HOST })
  }
  assert.deepEqual(work('compact', '{"do":"set","ref":1,"value":"B設定"}'), work('current', '{"do":"select","ref":1,"option":"B設定"}'))
  assert.deepEqual(work('compact', '{"do":"type","ref":0,"text":"a"}'), { problem: 'shape' })
})

test('the history is shown in the set\'s words; the rest of each entry unchanged', () => {
  const history = [
    { do: 'type' as const, ref: 0, outcome: 'ok' as const, typed: 'value-cut' as const }, { do: 'select' as const, ref: 1, outcome: 'ok' as const },
    { do: 'back' as const, outcome: 'ok' as const }, { do: 'click' as const, ref: 3, outcome: 'refused' as const, why: 'moved' as const },
  ]
  assert.deepEqual(toolsetHistory('current', history), history)
  assert.deepEqual(toolsetHistory('compact', history), [
    { do: 'set', ref: 0, outcome: 'ok', typed: 'value-cut' }, { do: 'set', ref: 1, outcome: 'ok' }, { do: 'go', outcome: 'ok', path: 'back' },
    { do: 'click', ref: 3, outcome: 'refused', why: 'moved' },
  ])
})

test('the compact prompts are shorter, teach only the compact words, and keep every end and rule of today\'s', () => {
  assert.equal(browserToolsetPrompt('current', 'browse'), BROWSER_OPERATOR_BROWSE_PROMPT)
  assert.equal(browserToolsetPrompt('current', 'work-preview'), BROWSER_OPERATOR_WORK_PREVIEW_PROMPT)
  assert.equal(browserToolsetPrompt('current', 'work'), BROWSER_OPERATOR_WORK_PROMPT)
  for (const p of ['browse', 'work-preview', 'work'] as const) {
    const current = browserToolsetPrompt('current', p)
    const compact = browserToolsetPrompt('compact', p)
    assert.ok(compact.length < current.length, `${p}: ${compact.length} < ${current.length}`)
    assert.match(compact, /"do":"set"/)
    for (const word of ['"do":"type"', '"do":"select"', '"do":"back"', 'ref なしで type']) assert.ok(!compact.includes(word), `${p} ${word}`)
    // Only the action and screen lines differ: every other line is today's.
    const lines = (s: string) => s.split('\n')
    const own = new Set([...OPERATOR_ACTION_LINES, ...OPERATOR_SCREEN_LINES])
    const kept = lines(current).filter(l => !own.has(l))
    assert.deepEqual(lines(compact).filter(l => kept.includes(l)), kept, p)
  }
})

test('the operator starts with the chosen set\'s prompt and nothing else differs; an unknown setting is today\'s set', () => {
  for (const set of BROWSER_OPERATOR_TOOLSETS) {
    const args = browserOperatorArgs('m', 'work', set)
    assert.deepEqual(args.slice(0, -1), browserOperatorArgs('m', 'work').slice(0, -1))
    assert.equal(args.at(-1), browserToolsetPrompt(set, 'work'))
  }
  assert.equal(browserOperatorArgs('m', 'preview', 'compact').at(-1), browserOperatorArgs('m', 'preview').at(-1))
  for (const v of [undefined, null, 'COMPACT', 'mcp', 1, {}]) assert.equal(browserOperatorToolset(v), 'current')
  assert.equal(browserOperatorToolset('compact'), 'compact')
})

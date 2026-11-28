/**
 * The operator's tool sets of 「ブラウザ操作」 (agent-browser.md "The operator's tool sets"). Guards:
 * - every set's answer becomes exactly today's action, so the one parser and everything after it judge it — never a looser
 *   reading (a password field, a wrong role, an option not offered, a long text, another site are refused in every set);
 * - a set refuses the other sets' words and the official actions the app cannot do (keys, scroll, drag, hover…);
 * - a typing without an element (computer use's `type`, Playwright's `browser_type` without a target) goes only into a text
 *   field pressed just before (browser-browse.test.ts runs it through the loop);
 * - each set's prompts teach only its words and keep every end and rule of today's; the operator is started with the
 *   chosen set's prompt only; an unknown stored value is today's set;
 * - a refused answer is told back (and on the card) in the words of the set it was given in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_OPERATOR_BROWSE_PROMPT, OPERATOR_ACTION_LINES, OPERATOR_SCREEN_LINES, pageWithScreen, parseBrowseAnswer, readBrowserPageSnapshot,
  type BrowserBrowseHistoryEntry, type BrowserPageSnapshot,
} from '../shared/browser-browse'
import { BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT, parseWorkAnswer, workRetrySentence } from '../shared/browser-frame-writes'
import { browserOperatorArgs } from '../shared/browser-operator'
import {
  BROWSER_OPERATOR_TOOLSETS, browserOperatorToolset, browserToolsetPrompt, readToolsetAnswer, toolsetHistory, type BrowserOperatorToolset,
} from '../shared/browser-operator-toolsets'
import { BROWSER_ANSWER_PROBLEMS, BROWSER_ANSWER_PROBLEM_WORDS, answerProblemWords } from '../shared/browser-operator-trail'

const HOST = 'shop.example.test'
const page: BrowserPageSnapshot = pageWithScreen({
  ...readBrowserPageSnapshot(JSON.stringify({
    address: `https://${HOST}/a`, title: 't', text: 'x', truncated: false,
    elements: [
      { ref: 0, role: 'textbox', name: '名前', value: '', logLabel: '名前' },
      { ref: 1, role: 'select', name: '設定', options: ['A設定', 'B設定'], logLabel: '設定' },
      { ref: 2, role: 'password', name: 'パスワード' },
      { ref: 3, role: 'button', name: '登録', logLabel: '登録' },
    ],
  }), HOST)!,
  viewport: [1000, 600],
}, { mediaType: 'image/jpeg', data: new Uint8Array(10), width: 500, height: 300 })

/** The last press reached the name field (a typing without an element goes there). */
const PRESSED_FIELD: BrowserBrowseHistoryEntry[] = [{ do: 'click', ref: 0, outcome: 'ok', pressed: { role: 'textbox', name: { outside: '名前' } as never } }]

const parse = (set: BrowserOperatorToolset, text: string, history: readonly BrowserBrowseHistoryEntry[] = PRESSED_FIELD) => {
  const read = readToolsetAnswer(set, text, { page, history, host: HOST })
  return 'problem' in read ? read : parseBrowseAnswer(read.text, { snapshot: page, items: 2 })
}

/** Each set's way of saying today's actions (the same index = the same action). */
const SAID: Record<BrowserOperatorToolset, string[]> = {
  current: [
    '{"do":"click","ref":3,"reason":"登録"}', '{"do":"click","x":250,"y":150}', '{"do":"type","ref":0,"text":"冬の回"}', '{"do":"type","text":"冬の回","notes":"n"}',
    '{"do":"select","ref":1,"option":"B設定"}', '{"do":"go","path":"/b?c=1"}', '{"do":"back","unlisted":"u"}', '{"do":"wait","seconds":2}', '{"do":"done","result":"r","unread":[1]}',
  ],
  compact: [
    '{"do":"click","ref":3,"reason":"登録"}', '{"do":"click","x":250,"y":150}', '{"do":"set","ref":0,"value":"冬の回"}', '{"do":"set","value":"冬の回","notes":"n"}',
    '{"do":"set","ref":1,"value":"B設定"}', '{"do":"go","path":"/b?c=1"}', '{"do":"go","path":"back","unlisted":"u"}', '{"do":"wait","seconds":2}', '{"do":"done","result":"r","unread":[1]}',
  ],
  playwright: [
    '{"do":"browser_click","target":3,"element":"登録ボタン","reason":"登録"}', '{"do":"browser_mouse_click_xy","x":250,"y":150}',
    '{"do":"browser_type","target":"0","element":"名前","text":"冬の回"}', '{"do":"browser_type","text":"冬の回","notes":"n"}',
    '{"do":"browser_select_option","target":1,"values":["B設定"]}', `{"do":"browser_navigate","url":"https://${HOST}/b?c=1"}`,
    '{"do":"browser_navigate_back","unlisted":"u"}', '{"do":"browser_wait_for","time":2}', '{"do":"done","result":"r","unread":[1]}',
  ],
  openai: [
    '{"do":"click","ref":3,"reason":"登録"}', '{"type":"click","button":"left","x":250,"y":150}', null as never, '{"type":"type","text":"冬の回","notes":"n"}',
    '{"do":"select","ref":1,"option":"B設定"}', '{"do":"go","path":"/b?c=1"}', '{"do":"back","unlisted":"u"}', '{"type":"wait"}', '{"do":"done","result":"r","unread":[1]}',
  ],
  anthropic: [
    '{"do":"click","ref":3,"reason":"登録"}', '{"action":"left_click","coordinate":[250,150]}', null as never, '{"action":"type","text":"冬の回","notes":"n"}',
    '{"do":"select","ref":1,"option":"B設定"}', '{"do":"go","path":"/b?c=1"}', '{"do":"back","unlisted":"u"}', '{"action":"wait","duration":2}', '{"do":"done","result":"r","unread":[1]}',
  ],
}

test('every set\'s answer is read as exactly today\'s action, its memo keys kept (a computer-use set has no typing into a named field: it presses, then types)', () => {
  for (const set of BROWSER_OPERATOR_TOOLSETS) {
    SAID[set].forEach((answer, i) => {
      if (answer === null) return
      assert.deepEqual(parse(set, answer), parse('current', SAID.current[i]), `${set} ${answer}`)
      assert.ok('answer' in parse(set, answer), `${set} ${answer}`)
    })
  }
  // A Playwright-like address may also be a path of the site; an OpenAI-like wait is 2 seconds.
  assert.deepEqual(parse('playwright', '{"do":"browser_navigate","url":"/b"}'), parse('current', '{"do":"go","path":"/b"}'))
  assert.deepEqual(parse('openai', '{"type":"click","x":250,"y":150}'), parse('current', '{"do":"click","x":250,"y":150}'), 'button left by default')
})

test('the one parser judges every set\'s answer: a password field, a wrong role, an option not offered, a long text, another site are refused as for today\'s words', () => {
  const long = 'x'.repeat(201)
  const cases: Array<[BrowserOperatorToolset, string, string]> = [
    ['compact', '{"do":"set","ref":2,"value":"x"}', 'ref'], ['compact', '{"do":"set","ref":3,"value":"x"}', 'ref'],
    ['compact', '{"do":"set","ref":1,"value":"C設定"}', 'option'], ['compact', `{"do":"set","ref":0,"value":"${long}"}`, 'text'],
    ['compact', '{"do":"set","ref":0}', 'keys'], ['compact', '{"do":"set","ref":1,"value":"B設定","option":"A設定"}', 'keys'],
    ['compact', '{"do":"set","ref":0,"value":"a","text":"b"}', 'keys'], ['compact', '{"do":"go","path":"back","x":1}', 'keys'],
    ['compact', 'text {"do":"set","ref":0,"value":"a"}', 'not-json'],
    ['compact', '{"do":"set","ref":0,"value":"a","__proto__":{"text":"b"}}', 'keys'], ['compact', '{"do":"go","path":"back","__proto__":{"path":"/x"}}', 'keys'],
    ['playwright', '{"do":"browser_type","target":2,"text":"x"}', 'ref'], ['playwright', '{"do":"browser_type","target":3,"text":"x"}', 'ref'],
    ['playwright', '{"do":"browser_select_option","target":1,"values":["C設定"]}', 'option'],
    ['playwright', '{"do":"browser_select_option","target":1,"values":["A設定","B設定"]}', 'option'],
    ['playwright', '{"do":"browser_select_option","target":1,"values":"B設定"}', 'option'],
    ['playwright', `{"do":"browser_type","target":0,"text":"${long}"}`, 'text'],
    ['playwright', '{"do":"browser_navigate","url":"https://evil.example/x"}', 'path'], ['playwright', `{"do":"browser_navigate","url":"http://${HOST}/x"}`, 'path'],
    ['playwright', `{"do":"browser_navigate","url":"https://${HOST}:8443/x"}`, 'path'], ['playwright', `{"do":"browser_navigate","url":"https://u@${HOST}/x"}`, 'path'],
    ['playwright', `{"do":"browser_navigate","url":"https://${HOST}/x#y"}`, 'path'], ['playwright', '{"do":"browser_navigate","url":"//evil.example/x"}', 'path'],
    // An address the URL reader would rewrite is not taken (never a path the operator did not write).
    ['playwright', `{"do":"browser_navigate","url":"https://${HOST}/a/../b"}`, 'path'], ['playwright', `{"do":"browser_navigate","url":"https://${HOST}/a b"}`, 'path'],
    ['playwright', `{"do":"browser_navigate","url":"https://${HOST}\\\\a"}`, 'path'], ['playwright', `{"do":"browser_navigate","url":"https://${HOST.toUpperCase()}/a"}`, 'path'],
    ['playwright', '{"do":"browser_click","target":"e3"}', 'ref'], ['playwright', '{"do":"browser_click","ref":3}', 'keys'],
    ['playwright', '{"do":"browser_click","target":3,"__proto__":{"ref":0}}', 'keys'], ['playwright', '{"do":"browser_wait_for","time":30}', 'seconds'],
    ['playwright', '{"do":"browser_mouse_click_xy","x":600,"y":1}', 'point'],
    ['openai', '{"type":"click","button":"left","x":600,"y":1}', 'point'], ['openai', '{"type":"click","button":"right","x":1,"y":1}', 'point'],
    ['openai', `{"type":"type","text":"${long}"}`, 'text'], ['openai', '{"do":"select","ref":1,"option":"C設定"}', 'option'],
    ['openai', '{"do":"click","ref":2,"x":1,"y":1}', 'keys'], ['openai', '{"type":"click","x":1,"y":1,"__proto__":{"ref":3}}', 'keys'],
    ['anthropic', '{"action":"left_click","coordinate":[600,1]}', 'point'], ['anthropic', '{"action":"left_click","coordinate":"1,1"}', 'point'],
    ['anthropic', '{"action":"left_click","coordinate":[1.5,1]}', 'point'], ['anthropic', `{"action":"type","text":"${long}"}`, 'text'],
    ['anthropic', '{"action":"wait","duration":6}', 'seconds'], ['anthropic', '{"do":"go","path":"//evil.example/x"}', 'path'],
  ]
  for (const [set, answer, problem] of cases) assert.deepEqual(parse(set, answer), { problem }, `${set} ${answer}`)
})

test('each set knows only its own words: the other sets\' words and the official actions the app cannot do are unknown', () => {
  const others: Record<BrowserOperatorToolset, string[]> = {
    current: ['{"do":"set","ref":0,"value":"a"}', '{"do":"browser_click","target":3}', '{"type":"click","x":1,"y":1}', '{"action":"left_click","coordinate":[1,1]}'],
    compact: ['{"do":"type","ref":0,"text":"a"}', '{"do":"select","ref":1,"option":"A設定"}', '{"do":"back"}', '{"do":"browser_navigate_back"}'],
    playwright: [
      '{"do":"click","ref":3}', '{"do":"type","ref":0,"text":"a"}', '{"do":"set","ref":0,"value":"a"}', '{"do":"browser_press_key","key":"Enter"}',
      '{"do":"browser_hover","target":3}', '{"do":"browser_drag","startTarget":3,"endTarget":0}', '{"do":"browser_file_upload","paths":["/x"]}',
      '{"do":"browser_evaluate","function":"() => 1"}', '{"do":"browser_tabs","action":"new"}', '{"do":"browser_mouse_wheel","deltaX":0,"deltaY":100}',
    ],
    openai: [
      '{"do":"type","ref":0,"text":"a"}', '{"do":"wait","seconds":1}', '{"do":"set","ref":0,"value":"a"}', '{"action":"left_click","coordinate":[1,1]}',
      '{"type":"double_click","x":1,"y":1}', '{"type":"scroll","x":1,"y":1,"scroll_x":0,"scroll_y":3}', '{"type":"keypress","keys":["ENTER"]}',
      '{"type":"drag","path":[]}', '{"type":"move","x":1,"y":1}', '{"type":"screenshot"}', '{"text":"x"}',
    ],
    anthropic: [
      '{"do":"type","ref":0,"text":"a"}', '{"do":"wait","seconds":1}', '{"type":"click","x":1,"y":1}', '{"action":"right_click","coordinate":[1,1]}',
      '{"action":"double_click","coordinate":[1,1]}', '{"action":"triple_click","coordinate":[1,1]}', '{"action":"key","text":"Return"}',
      '{"action":"scroll","coordinate":[1,1],"scroll_direction":"down","scroll_amount":3}', '{"action":"mouse_move","coordinate":[1,1]}',
      '{"action":"left_click_drag","start_coordinate":[1,1],"coordinate":[2,2]}', '{"action":"hold_key","text":"shift","duration":1}',
      '{"action":"screenshot"}', '{"action":"zoom","region":[0,0,1,1]}', '{"action":"cursor_position"}',
    ],
  }
  for (const set of BROWSER_OPERATOR_TOOLSETS) for (const word of others[set]) assert.deepEqual(parse(set, word), { problem: 'shape' }, `${set} ${word}`)
  // Options of an official action the app does not do are extra keys: refused, never dropped.
  const extras: Array<[BrowserOperatorToolset, string]> = [
    ['playwright', '{"do":"browser_click","target":3,"doubleClick":true}'], ['playwright', '{"do":"browser_click","target":3,"button":"right"}'],
    ['playwright', '{"do":"browser_click","target":3,"modifiers":["Shift"]}'], ['playwright', '{"do":"browser_type","target":0,"text":"a","submit":true}'],
    ['playwright', '{"do":"browser_type","target":0,"text":"a","slowly":true}'], ['playwright', '{"do":"browser_wait_for","text":"完了"}'],
    ['playwright', '{"do":"browser_mouse_click_xy","x":1,"y":1,"clickCount":2}'],
    ['openai', '{"type":"click","button":"left","x":1,"y":1,"keys":["CTRL"]}'], ['openai', '{"type":"wait","ms":1000}'],
    ['anthropic', '{"action":"left_click","coordinate":[1,1],"text":"shift"}'],
  ]
  for (const [set, answer] of extras) assert.deepEqual(parse(set, answer), { problem: 'keys' }, `${set} ${answer}`)
  // A write run's answers go through the same reading (its ends untouched).
  const work = (set: BrowserOperatorToolset, text: string) => {
    const read = readToolsetAnswer(set, text, { page, history: PRESSED_FIELD, host: HOST })
    return 'problem' in read ? read : parseWorkAnswer(read.text, { snapshot: page, items: 0, phase: 'work', adhoc: false, domain: HOST })
  }
  for (const set of BROWSER_OPERATOR_TOOLSETS) {
    const i = SAID[set].findIndex((a, n) => a !== null && SAID.current[n].includes('"select"'))
    assert.deepEqual(work(set, SAID[set][i]), work('current', SAID.current[i]), set)
  }
  assert.deepEqual(work('compact', '{"do":"type","ref":0,"text":"a"}'), { problem: 'shape' })
})

test('a typing without an element goes only into the text field pressed just before; otherwise it is refused (`focus`), never guessed', () => {
  const answers: Array<[BrowserOperatorToolset, string]> = [
    ['playwright', '{"do":"browser_type","text":"a"}'], ['openai', '{"type":"type","text":"a"}'], ['anthropic', '{"action":"type","text":"a"}'],
  ]
  const button: BrowserBrowseHistoryEntry = { do: 'click', ref: 3, outcome: 'ok', pressed: { role: 'button', name: { outside: '登録' } as never } }
  for (const [set, answer] of answers) {
    assert.deepEqual(parse(set, answer), { answer: { do: 'type', text: 'a' } }, set)
    for (const history of [[], [button], [...PRESSED_FIELD, { do: 'select', ref: 1, outcome: 'ok' }], [{ ...PRESSED_FIELD[0], outcome: 'refused' }]] as BrowserBrowseHistoryEntry[][]) {
      assert.deepEqual(parse(set, answer, history), { problem: 'focus' }, `${set} ${JSON.stringify(history)}`)
    }
  }
  // Today's and the compact set keep their own rule: without a ref, the focused field (the window checks it).
  assert.deepEqual(parse('current', '{"do":"type","text":"a"}', []), { answer: { do: 'type', text: 'a' } })
  assert.deepEqual(parse('compact', '{"do":"set","value":"a"}', []), { answer: { do: 'type', text: 'a' } })
})

test('the history is shown in each set\'s words and keys; the rest of each entry unchanged', () => {
  const history: BrowserBrowseHistoryEntry[] = [
    { do: 'click', outcome: 'ok', pressed: 'click-unknown' }, { do: 'type', ref: 0, outcome: 'ok' }, { do: 'select', ref: 1, outcome: 'ok' },
    { do: 'click', ref: 3, outcome: 'refused', why: 'moved' }, { do: 'go', outcome: 'ok' }, { do: 'back', outcome: 'ok' }, { do: 'wait', outcome: 'ok' },
  ]
  assert.deepEqual(toolsetHistory('current', history), history)
  assert.deepEqual(toolsetHistory('compact', history), [
    { do: 'click', outcome: 'ok', pressed: 'click-unknown' }, { do: 'set', ref: 0, outcome: 'ok' }, { do: 'set', ref: 1, outcome: 'ok' },
    { do: 'click', ref: 3, outcome: 'refused', why: 'moved' }, { do: 'go', outcome: 'ok' }, { do: 'go', outcome: 'ok', path: 'back' }, { do: 'wait', outcome: 'ok' },
  ])
  assert.deepEqual(toolsetHistory('playwright', history), [
    { do: 'browser_mouse_click_xy', outcome: 'ok', pressed: 'click-unknown' }, { do: 'browser_type', target: 0, outcome: 'ok' },
    { do: 'browser_select_option', target: 1, outcome: 'ok' }, { do: 'browser_click', target: 3, outcome: 'refused', why: 'moved' },
    { do: 'browser_navigate', outcome: 'ok' }, { do: 'browser_navigate_back', outcome: 'ok' }, { do: 'browser_wait_for', outcome: 'ok' },
  ])
  assert.deepEqual(toolsetHistory('openai', history), [
    { type: 'click', outcome: 'ok', pressed: 'click-unknown' }, { type: 'type', outcome: 'ok' }, { do: 'select', ref: 1, outcome: 'ok' },
    { do: 'click', ref: 3, outcome: 'refused', why: 'moved' }, { do: 'go', outcome: 'ok' }, { do: 'back', outcome: 'ok' }, { type: 'wait', outcome: 'ok' },
  ])
  assert.deepEqual(toolsetHistory('anthropic', history), [
    { action: 'left_click', outcome: 'ok', pressed: 'click-unknown' }, { action: 'type', outcome: 'ok' }, { do: 'select', ref: 1, outcome: 'ok' },
    { do: 'click', ref: 3, outcome: 'refused', why: 'moved' }, { do: 'go', outcome: 'ok' }, { do: 'back', outcome: 'ok' }, { action: 'wait', outcome: 'ok' },
  ])
})

test('each set\'s prompts teach only its own words and keep every end and rule of today\'s', () => {
  assert.equal(browserToolsetPrompt('current', 'browse'), BROWSER_OPERATOR_BROWSE_PROMPT)
  assert.equal(browserToolsetPrompt('current', 'work-preview'), BROWSER_OPERATOR_WORK_PREVIEW_PROMPT)
  assert.equal(browserToolsetPrompt('current', 'work'), BROWSER_OPERATOR_WORK_PROMPT)
  const teaches: Record<Exclude<BrowserOperatorToolset, 'current'>, { has: RegExp[]; not: string[] }> = {
    compact: { has: [/"do":"set"/], not: ['"do":"type"', '"do":"select"', '"do":"back"', 'ref なしで type'] },
    playwright: {
      has: [/"do":"browser_click","target"/, /"do":"browser_mouse_click_xy"/, /"do":"browser_select_option".*"values"/, /"do":"browser_navigate","url"/, /"do":"browser_wait_for","time"/],
      not: ['"do":"type"', '"do":"select"', '"do":"back"', '"do":"set"', 'ref なしで'],
    },
    openai: { has: [/"type":"click","button":"left","x"/, /"type":"type","text"/, /"type":"wait"/, /"do":"select"/], not: ['"do":"type"', '"do":"wait"', '"do":"set"', 'ref なしで'] },
    anthropic: { has: [/"action":"left_click","coordinate"/, /"action":"type","text"/, /"action":"wait","duration"/, /"do":"select"/], not: ['"do":"type"', '"do":"wait"', '"do":"set"', 'ref なしで'] },
  }
  for (const p of ['browse', 'work-preview', 'work'] as const) {
    const current = browserToolsetPrompt('current', p)
    // Only the action lines and the first screen line differ: every other line is today's, in order.
    const lines = (s: string) => s.split('\n')
    const own = new Set([...OPERATOR_ACTION_LINES, OPERATOR_SCREEN_LINES[0]])
    const kept = lines(current).filter(l => !own.has(l))
    for (const [set, t] of Object.entries(teaches)) {
      const prompt = browserToolsetPrompt(set as BrowserOperatorToolset, p)
      for (const re of t.has) assert.match(prompt, re, `${set} ${p}`)
      for (const word of t.not) assert.ok(!prompt.includes(word), `${set} ${p} ${word}`)
      assert.deepEqual(lines(prompt).filter(l => kept.includes(l)), kept, `${set} ${p}`)
    }
  }
  assert.ok(browserToolsetPrompt('compact', 'work').length < browserToolsetPrompt('current', 'work').length)
})

test('the operator starts with the chosen set\'s prompt and nothing else differs; an unknown setting is today\'s set', () => {
  for (const set of BROWSER_OPERATOR_TOOLSETS) {
    const args = browserOperatorArgs('m', 'work', set)
    assert.deepEqual(args.slice(0, -1), browserOperatorArgs('m', 'work').slice(0, -1))
    assert.equal(args.at(-1), browserToolsetPrompt(set, 'work'))
    assert.equal(browserOperatorArgs('m', 'preview', set).at(-1), browserOperatorArgs('m', 'preview').at(-1))
    assert.equal(browserOperatorToolset(set), set)
  }
  for (const v of [undefined, null, 'COMPACT', 'mcp', 'Playwright', 1, {}]) assert.equal(browserOperatorToolset(v), 'current')
})

test('a refused answer is told back in the words of the set it was given in: the keys that set was taught', () => {
  const said = (set: BrowserOperatorToolset, problem: Parameters<typeof answerProblemWords>[0]) => workRetrySentence(problem, set)
  assert.equal(said('current', 'option'), workRetrySentence('option'))
  assert.match(said('current', 'option'), /option が/)
  assert.match(said('compact', 'option'), /set の value が/)
  assert.match(said('compact', 'text'), /value の文字/)
  assert.match(said('playwright', 'ref'), /target が/)
  assert.match(said('playwright', 'option'), /values が/)
  assert.match(said('playwright', 'path'), /browser_navigate の url/)
  assert.match(said('playwright', 'seconds'), /browser_wait_for の time/)
  assert.match(said('playwright', 'focus'), /target のない browser_type/)
  assert.match(said('openai', 'point'), /button が "left"/)
  assert.match(said('openai', 'shape'), /"type"/)
  assert.match(said('anthropic', 'point'), /left_click の coordinate/)
  assert.match(said('anthropic', 'seconds'), /duration/)
  assert.match(said('anthropic', 'focus'), /type の前に押したもの/)
  // Every problem has words in every set (its own, else today's).
  for (const set of BROWSER_OPERATOR_TOOLSETS) for (const p of BROWSER_ANSWER_PROBLEMS) assert.ok(answerProblemWords(p, set).length > 0)
  assert.equal(answerProblemWords('plan-keys', 'playwright'), BROWSER_ANSWER_PROBLEM_WORDS['plan-keys'])
})

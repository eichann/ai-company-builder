/**
 * The operator's own trail on the person's card (agent-browser.md "The operator's trail on the card"; owner 2026-11-27: a
 * write task's preview stopped with 「人の判断が要る」 and nobody could see what the operator AI tried or why). Against fakes
 * of the server's routes, the operator and the window; a fictional site only.
 *
 * Guards (each test fails when its guard is removed or inverted):
 * - each step's action, its kept-form label and the operator's own reason reach the person's card, for a read run and for
 *   a write run's preview and work; the operator's own words for stopping and its notes too;
 * - a write task's preview that stops (need-person) leaves the person a card (named by its operator run) with the fixed
 *   reason word and the trail — before this there was none;
 * - none of it reaches the consultation AI's words or the server's run log (the finish body);
 * - a reason is one line, without control / bidirectional / zero-width characters, cut at 200; notes at 4000; a reason
 *   that is not a string refuses the answer; a trail handed to the renderer past its caps or with an unsafe character is
 *   left off the card (the card still shows).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserContext } from '../electron/features/browser/context'
import { wireBrowserBrowse } from '../electron/features/browser/browse'
import { wireBrowserWork } from '../electron/features/browser/work'
import type { BrowserLinesAnswer, BrowserRunsApi } from '../electron/features/browser/lines-api'
import type { PreviewOperator } from '../electron/features/browser/preview'
import { BROWSER_OPERATOR_BROWSE_PROMPT, parseBrowseAnswer, readBrowserPageSnapshot, type BrowserBrowseSurface, type BrowserPageSnapshot } from '../shared/browser-browse'
import { BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT, BROWSER_WORK_WORDS as WW, parseWorkAnswer } from '../shared/browser-frame-writes'
import { readBrowserCard, readBrowserInspectionView } from '../shared/browser-inspection'
import { readBrowserWriteView } from '../shared/browser-line-writes'
import { BROWSER_TRAIL_LIMITS, BROWSER_TRAIL_WORDS, createOperatorTrail, readBrowserOperatorTrail, trailForCard, type BrowserOperatorTrail } from '../shared/browser-operator-trail'

const HOST = 'shop.example.test'
const COMPANY = 'company-1'
const RUN = `bo_${'a'.repeat(32)}`
const FRAME_RUN = `bf_${'b'.repeat(32)}`
const TOKEN = 'f'.repeat(64)
const PLAN_HASH = `sha256:${'c'.repeat(64)}`
const REASON_CLICK = '検索ボタンで一覧を絞るため'
const REASON_STOP = '確認の画面で、どちらの回に入れるか決められないため'
const NOTES = '一覧の2ページ目まで見た'

function page(): BrowserPageSnapshot {
  return readBrowserPageSnapshot(JSON.stringify({
    address: `https://${HOST}/events?page=2`, title: 'イベント', text: '会員 88123', truncated: false,
    elements: [
      { ref: 1, role: 'button', name: '検索する', logLabel: '検索する' },
      // A row the page made a button: its text is data, so the log (and the trail) keep no label for it.
      { ref: 6, role: 'button', name: '山田花子 88123', logLabel: '' },
    ],
  }), HOST)!
}

const operatorOf = (answers: string[], calls: string[]): PreviewOperator => {
  let n = 0
  return {
    model: 'm',
    async resolve() { return { ok: true, cli: { path: '/bin/claude', pathDirs: [] } } },
    async step(job) { calls.push(`step ${job.prompt}`); return { ok: true, text: answers[n++] ?? '{"do":"stop","why":"blocked","unread":[]}' } },
  }
}

const surfaceOf = (calls: string[]): BrowserBrowseSurface => ({
  async enter() { calls.push('enter'); return true },
  async leave() { calls.push('leave') },
  async snapshot() { return page() },
  async act(a) { calls.push(`act ${a.do}`); return { outcome: 'ok' } },
  pageClean: () => true,
  closed: () => false,
})

function browseWorld(answers: string[]) {
  const calls: string[] = []
  const surface = surfaceOf(calls)
  const finished: unknown[] = []
  const api: BrowserRunsApi = {
    async runStart() { return { kind: 'ok', value: { runId: RUN, leaseMs: 120_000 } } },
    async runContinue() { return { kind: 'ok', value: {} } },
    async runFinish(_c, _r, body) { finished.push(body); return { kind: 'ok', value: {} } },
  }
  const wiring = wireBrowserBrowse({
    aiSwitch: () => true, userId: () => 'u-1', context: createBrowserContext({ userId: () => 'u-1', aiSwitch: () => true }), stopped: () => false,
    window: () => surface, registered: () => true, api, operator: () => operatorOf(answers, calls), cliPath: () => '/bin/claude', parentEnv: () => ({}),
  })
  return { wiring, finished, run: () => wiring.browse({ companyId: COMPANY, conversationId: 'c', site: HOST, task: '一覧を読んで', items: ['受付'], signal: new AbortController().signal }) }
}

const step = (o: Record<string, unknown>) => JSON.stringify(o)
const leaks = [REASON_CLICK, REASON_STOP, NOTES]

test('a read run: each step\'s action, kept-form label and reason, the stop\'s own words and the notes reach the card; never the AI\'s words or the log', async () => {
  const { wiring, finished, run } = browseWorld([
    step({ do: 'click', ref: 1, reason: REASON_CLICK }),
    step({ do: 'click', ref: 6, reason: '山田花子さんの行を開く', notes: NOTES }),
    step({ do: 'stop', why: 'need-person', unread: [1], reason: REASON_STOP }),
  ])
  const r = await run()
  assert.equal(r.kind, 'card')
  const view = wiring.card('u-1', COMPANY, RUN)
  const trail = view?.trail
  assert.ok(trail, 'the card carries the trail')
  assert.equal(trail.length, 1)
  assert.deepEqual(trail[0].steps.map(s => [s.action, s.label, s.reason]), [
    ['click', '検索する', REASON_CLICK],
    // The row's text is never a label (the run log's rule); the operator's own reason is its words, outside text.
    ['click', null, '山田花子さんの行を開く'],
  ])
  assert.deepEqual(trail[0].end, { kind: 'stop', reason: REASON_STOP })
  assert.equal(trail[0].notes, NOTES)
  // The fixed reason word stays the card's headline; the AI hears fixed words only.
  assert.match(view.card.headline, /人の判断が要る画面/)
  if (r.kind === 'card') for (const leak of leaks) assert.equal(r.words.includes(leak), false, leak)
  // The renderer takes it in its shape.
  assert.deepEqual(readBrowserInspectionView(JSON.parse(JSON.stringify(view)))?.trail, trail)
  // The server's log: actions, page patterns and labels only.
  const body = JSON.stringify(finished)
  for (const leak of [...leaks, '山田花子']) assert.equal(body.includes(leak), false, leak)
})

// ── Write runs ────────────────────────────────────────────────────────────────────────────────────────────────────

function started(o: { needsApproval: boolean; adhoc?: boolean }) {
  return {
    runId: FRAME_RUN, state: o.needsApproval ? 'waiting' : 'open', endReason: null, host: HOST, source: o.adhoc ? 'adhoc' : 'skill', skill: o.adhoc ? null : 'coupons',
    planHash: PLAN_HASH, needsApproval: o.needsApproval, approval: o.needsApproval ? null : 'pre_approved', createdAt: '', expiresAt: '', endedAt: null,
    frames: [{ frame: 1, method: 'POST', path: '/coupons', fields: {}, max: 1, used: 0, left: 1 }], writes: [],
    approvalToken: o.needsApproval ? TOKEN : null, afterRead: [], neverRead: [],
  }
}

function workWorld(answers: string[], skill: string | null) {
  const calls: string[] = []
  const surface = surfaceOf(calls)
  const finished: string[] = []
  const api = {
    async runStart() { return { kind: 'ok', value: { runId: RUN, leaseMs: 120_000 } } as BrowserLinesAnswer },
    async runContinue() { return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async runFinish(_c: string, _r: string, body: unknown) { finished.push(JSON.stringify(body)); return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async frameStart(_c: string, body: unknown) { calls.push('frameStart'); return { kind: 'ok', value: started({ needsApproval: true, adhoc: 'plan' in (body as object) }) } as BrowserLinesAnswer },
    async frameApprove() { return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async framePermit() { return { kind: 'no-answer' } as BrowserLinesAnswer },
    async frameGet() { return { kind: 'no-answer' } as BrowserLinesAnswer },
    async frameConfirm() { return { kind: 'no-answer' } as BrowserLinesAnswer },
    async frameReport() { return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async frameEnd() { return { kind: 'ok', value: {} } as BrowserLinesAnswer },
  }
  const wiring = wireBrowserWork({
    aiSwitch: () => true, userId: () => 'u-1', context: createBrowserContext({ userId: () => 'u-1', aiSwitch: () => true }), stopped: () => false,
    window: () => surface, registered: () => true,
    reader: () => ({ async read() { return { status: 404, body: '' } }, closed: () => false }),
    api: api as never, operator: () => operatorOf(answers, calls), cliPath: () => '/bin/claude', parentEnv: () => ({}),
  })
  const cards: string[] = []
  const work = () => wiring.work({
    companyId: COMPANY, conversationId: 'conv-1', companyRoot: null, site: HOST, task: 'クーポンを作って', skill, items: [],
    signal: new AbortController().signal, onCard: id => cards.push(id),
  })
  return { wiring, cards, finished, work, calls }
}

test('the incident: a write task\'s preview that stops (need-person) leaves the person a card with the fixed reason and the operator\'s trail', async () => {
  for (const skill of [null, 'coupons']) {
    const { wiring, cards, finished, work } = workWorld([
      step({ do: 'click', ref: 1, reason: REASON_CLICK }),
      step({ do: 'stop', why: 'need-person', unread: [], reason: REASON_STOP, notes: NOTES }),
    ], skill)
    const said = await work()
    assert.equal(said.words.startsWith(WW.stoppedBy['need-person']), true, said.words)
    for (const leak of leaks) assert.equal(said.words.includes(leak), false, leak)
    // The card's reference is the preview's operator run; the card shows by the inspection card's IPC.
    assert.deepEqual(cards, [RUN])
    const view = wiring.previewCard('u-1', COMPANY, RUN)
    assert.ok(view, `a card for ${skill ?? 'ad hoc'}`)
    assert.match(view.card.headline, /人の判断が要る画面/)
    assert.deepEqual(view.trail?.[0].steps.map(s => [s.action, s.label, s.reason]), [['click', '検索する', REASON_CLICK]])
    assert.deepEqual(view.trail?.[0].end, { kind: 'stop', reason: REASON_STOP })
    assert.equal(view.trail?.[0].notes, NOTES)
    assert.equal(view.trail?.[0].phase, 'preview')
    assert.ok(readBrowserInspectionView(JSON.parse(JSON.stringify(view)))?.trail)
    // Another member's and a cleared wiring's: nothing.
    assert.equal(wiring.previewCard('u-2', COMPANY, RUN), undefined)
    for (const leak of leaks) assert.equal(finished.join('\n').includes(leak), false, leak)
    wiring.clear()
    assert.equal(wiring.previewCard('u-1', COMPANY, RUN), undefined)
  }
})

test('a preview the app ended because the operator never answered in its form (asked again once) leaves a card naming the rule it broke, in fixed words', async () => {
  const { wiring, cards, work } = workWorld(['not json', 'still not json'], null)
  const said = await work()
  assert.equal(said.words.startsWith(WW.stoppedBy.operator), true, said.words)
  assert.deepEqual(cards, [RUN])
  const view = wiring.previewCard('u-1', COMPANY, RUN)
  assert.ok(view)
  assert.match(view.card.headline, /決まった形で答えられませんでした/)
  assert.deepEqual(view.trail, [{ phase: 'preview', steps: [], more: 0, end: null, notes: null, problem: 'not-json' }])
  assert.ok(!JSON.stringify(view).includes('still not json'), 'never the operator\'s own text')
})

test('a write run\'s card carries the preview\'s trail and the work\'s, read live; never the AI\'s words or the log', async () => {
  const PLAN = JSON.stringify({ do: 'plan', summary: '作ります', affects: '', values: [], writes: [{ method: 'POST', path: '/coupons', max: 1 }], unread: [], reason: '一覧で作る先を見つけたため' })
  const { wiring, cards, finished, work } = workWorld([
    step({ do: 'click', ref: 1, reason: REASON_CLICK }),
    PLAN,
    step({ do: 'stop', why: 'blocked', unread: [], reason: REASON_STOP }),
  ], null)
  const said = work()
  for (let i = 0; i < 100 && cards.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(cards, [FRAME_RUN])
  const waiting = wiring.card(COMPANY, FRAME_RUN)
  try {
    assert.ok(waiting?.ok)
    assert.deepEqual(waiting.view.trail?.map(r => [r.phase, r.end]), [['preview', { kind: 'plan', reason: '一覧で作る先を見つけたため' }]])
  } catch (e) {
    // The card waits for ［任せる］ up to its time: let the task end so a failure does not hold the run.
    wiring.cancel(COMPANY, FRAME_RUN)
    await said
    throw e
  }
  await wiring.approve(COMPANY, FRAME_RUN, PLAN_HASH)
  const words = (await said).words
  const done = wiring.card(COMPANY, FRAME_RUN)
  assert.ok(done?.ok)
  assert.deepEqual(done.view.trail?.map(r => r.phase), ['preview', 'work'])
  assert.deepEqual(done.view.trail?.[1].end, { kind: 'stop', reason: REASON_STOP })
  assert.ok(readBrowserWriteView(JSON.parse(JSON.stringify(done.view)), readBrowserCard)?.trail)
  for (const leak of leaks) {
    assert.equal(words.includes(leak), false, leak)
    assert.equal(finished.join('\n').includes(leak), false, leak)
  }
})

test('a reason is one line without unsafe characters, cut at 200; not a string refuses the answer; notes cut at 4000', () => {
  const long = 'あ'.repeat(250)
  const a = parseBrowseAnswer(step({ do: 'back', reason: `${long}` }), { snapshot: page(), items: 0 })
  assert.ok('answer' in a)
  assert.equal(a.reason?.length, BROWSER_TRAIL_LIMITS.reason)
  const b = parseBrowseAnswer(step({ do: 'back', reason: '一行目\n二行目‮<b>x</b>​' }), { snapshot: page(), items: 0 })
  assert.ok('answer' in b)
  assert.equal(b.reason, '一行目 二行目 <b>x</b>')
  assert.deepEqual(parseBrowseAnswer(step({ do: 'back', reason: 3 }), { snapshot: page(), items: 0 }), { problem: 'reason' })
  const ctx = { snapshot: page(), items: 0, phase: 'preview' as const, adhoc: false, domain: HOST }
  assert.deepEqual(parseWorkAnswer(step({ do: 'stop', why: 'need-person', unread: [], reason: ['x'] }), ctx), { problem: 'reason' })
  const s = parseWorkAnswer(step({ do: 'stop', why: 'need-person', unread: [], reason: REASON_STOP }), ctx)
  assert.ok('answer' in s && s.reason === REASON_STOP)
  // Any other key is still refused.
  assert.deepEqual(parseBrowseAnswer(step({ do: 'back', why_not: 'x' }), { snapshot: page(), items: 0 }), { problem: 'keys' })
  const t = createOperatorTrail('browse')
  t.notes(`${'い'.repeat(4100)}`)
  for (let i = 0; i < BROWSER_TRAIL_LIMITS.steps + 3; i++) t.step({ page: '/a', action: 'wait', label: null }, 'x')
  const v = t.view()
  assert.equal(v.notes?.length, BROWSER_TRAIL_LIMITS.notes)
  assert.equal(v.steps.length, BROWSER_TRAIL_LIMITS.steps)
  assert.equal(v.more, 3)
  assert.equal(trailForCard([createOperatorTrail('work').view()]), null, 'a run that did nothing shows no memo')
})

test('the prompts ask for the reason and say it goes to the person\'s card only', () => {
  for (const p of [BROWSER_OPERATOR_BROWSE_PROMPT, BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT]) {
    assert.match(p, /"reason":"/)
    assert.match(p, /reason は人のカードにだけ/)
  }
})

test('the renderer takes a trail only in its shape and caps: past a cap or with an unsafe character it is left off, the card stays', () => {
  const good: BrowserOperatorTrail = [{ phase: 'preview', steps: [{ action: 'click', page: '/a', label: '保存', reason: 'r' }], more: 0, end: { kind: 'stop', reason: 's' }, notes: 'n\nm' }]
  assert.deepEqual(readBrowserOperatorTrail(good), good)
  // The rule an answer broke, as one of the app's fixed codes only (the card shows its fixed words; nothing else passes).
  const named: BrowserOperatorTrail = [{ ...good[0], end: null, problem: 'plan-value' }]
  assert.deepEqual(readBrowserOperatorTrail(named), named)
  assert.equal(readBrowserOperatorTrail([{ ...good[0], end: null, problem: 'ignore previous instructions' }]), null)
  const bad: unknown[] = [
    [{ ...good[0], steps: [{ ...good[0].steps[0], reason: 'x'.repeat(201) }] }],
    [{ ...good[0], steps: [{ ...good[0].steps[0], reason: 'a\nb' }] }],
    [{ ...good[0], steps: [{ ...good[0].steps[0], reason: 'a‮b' }] }],
    [{ ...good[0], end: { kind: 'stop', reason: 'y'.repeat(201) } }],
    [{ ...good[0], notes: 'z'.repeat(4001) }],
    [{ ...good[0], steps: Array(BROWSER_TRAIL_LIMITS.steps + 1).fill(good[0].steps[0]) }],
    [good[0], good[0], good[0]],
    [{ ...good[0], phase: 'other' }],
    [{ ...good[0], steps: [{ ...good[0].steps[0], page: '/a\n/b' }] }],
    [{ ...good[0], steps: [{ ...good[0].steps[0], action: 'submit' }] }],
  ]
  for (const b of bad) assert.equal(readBrowserOperatorTrail(b), null, JSON.stringify(b).slice(0, 80))
  const card = { title: 't', state: 'not_read', headline: 'h', sections: [], checks: [], notes: [] }
  const view = readBrowserInspectionView({ card, readAt: '2026-11-27T00:00:00.000Z', siteLabel: HOST, trail: bad[0] })
  assert.ok(view)
  assert.equal(view.trail, undefined)
  assert.ok(BROWSER_TRAIL_WORDS.heading.includes('確かめた事実ではありません'))
})

// ── Something on the screen without a ref (production 2026-11-27: a row's popup menu showed on the screen image but had
// no ref; the operator could only stop) ─────────────────────────────────────────────────────────────────────────────

const UNLISTED = '行の「…」で開いたメニューの［コピーを作成］'

test('the operator can say what it sees on the screen without a ref: the card shows 「画面にはあるが押せる部品として拾えなかった」 with its words; never the AI\'s words or the log', async () => {
  const { wiring, finished, run } = browseWorld([
    step({ do: 'click', ref: 1, reason: REASON_CLICK }),
    step({ do: 'stop', why: 'need-person', unread: [], reason: REASON_STOP, unlisted: UNLISTED }),
  ])
  const r = await run()
  assert.equal(r.kind, 'card')
  const trail = wiring.card('u-1', COMPANY, RUN)?.trail
  assert.equal(trail?.[0].unlisted, UNLISTED)
  assert.equal(BROWSER_TRAIL_WORDS.unlisted.startsWith('画面にはあるが押せる部品として拾えなかった'), true)
  assert.deepEqual(readBrowserOperatorTrail(JSON.parse(JSON.stringify(trail))), trail, 'the renderer takes it')
  if (r.kind === 'card') assert.equal(r.words.includes(UNLISTED), false)
  assert.equal(JSON.stringify(finished).includes('コピーを作成'), false)
})

test('a write run\'s preview keeps the operator\'s word for what has no ref; one that is not a string refuses the answer; the renderer takes only one line', async () => {
  const { wiring, cards, work } = workWorld([
    step({ do: 'stop', why: 'need-person', unread: [], reason: REASON_STOP, unlisted: UNLISTED }),
  ], null)
  await work()
  assert.equal(cards.length, 1)
  assert.equal(wiring.previewCard('u-1', COMPANY, cards[0])?.trail?.[0].unlisted, UNLISTED)
  const ctx = { snapshot: page(), items: 0, phase: 'preview' as const, adhoc: false, domain: HOST }
  assert.deepEqual(parseWorkAnswer(step({ do: 'stop', why: 'need-person', unread: [], unlisted: 4 }), ctx), { problem: 'unlisted' })
  assert.deepEqual(parseBrowseAnswer(step({ do: 'back', unlisted: { x: 1 } }), { snapshot: page(), items: 0 }), { problem: 'unlisted' })
  const a = parseBrowseAnswer(step({ do: 'back', unlisted: `一行目\n${'あ'.repeat(300)}` }), { snapshot: page(), items: 0 })
  assert.ok('answer' in a && a.unlisted?.length === BROWSER_TRAIL_LIMITS.reason && !a.unlisted.includes('\n'))
  const good: BrowserOperatorTrail = [{ phase: 'browse', steps: [], more: 0, end: { kind: 'stop', reason: null }, notes: null, unlisted: UNLISTED }]
  assert.deepEqual(readBrowserOperatorTrail(good), good)
  for (const bad of ['a\nb', 'x'.repeat(201), 3]) assert.equal(readBrowserOperatorTrail([{ ...good[0], unlisted: bad }]), null, String(bad))
  // A run whose only word is that one still shows on the card.
  const t = createOperatorTrail('preview')
  t.unlisted(UNLISTED)
  assert.equal(trailForCard([t.view()])?.[0].unlisted, UNLISTED)
})

test('the prompts say the elements come in priority order (open overlays first) and how to name what has no ref', () => {
  for (const p of [BROWSER_OPERATOR_BROWSE_PROMPT, BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT]) {
    assert.match(p, /開いているメニュー・ポップアップ・ダイアログの中の要素が先/)
    assert.match(p, /elementsLeftOut/)
    assert.match(p, /"unlisted":"/)
  }
})

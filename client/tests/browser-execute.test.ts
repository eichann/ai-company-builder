/**
 * Executing a plan (6b-2c; agent-browser.md "Executing a plan", design 6b-2 §3, §5; the lifecycle in
 * model/browser-plan/PlanLife.tla): the real runner (client/electron/features/browser/runner.ts) with the
 * real Lステップ 0.6.1 declaration and checker, the real facts driver and page parser, against a fake
 * Lステップ in the real site's shapes (made-up names and ids) and a fake of the server's plan routes.
 *
 * What is protected: a plan runs only with the server's fixed content, hashed to what the person
 * approved (an older server: never); nothing is sent when anything the person approved changed, when
 * the permit is not live by both clocks, the context changed or the AI was stopped; a write that may
 * have left is never "not sent" (`failed`) and never sent again — a site's refusal (4xx), no answer and
 * an error after the send are `unknown`; `failed` only when the request provably never left.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBrowserHtml } from '../electron/features/browser/html'
import { createBrowserRunner, type BrowserRunnerDeps, type BrowserRunWindow } from '../electron/features/browser/runner'
import { createBrowserCheckerRegistry, createBrowserConnectors } from '../shared/browser-checkers'
import { readBrowserFacts } from '../shared/browser-facts'
import {
  stoppedBeforeSending, type BrowserChecker, type BrowserFactDraft, type BrowserRunGateHooks, type BrowserStepRecord, type BrowserWriteOutcome,
} from '../shared/browser-runner'
import { lstepConnector } from '../connectors/lstep'
import type { BrowserFact } from '../../shared/core/browser-plans'
import type { PluginBrowser } from '../../shared/core/plugin-browser-declaration'
import { fakePlansServer, type FakeServerFaults } from './browser-plans-fake'

const HOST = 'manager.linestep.net'
const COMPANY = 'company-1'
const PLAN = 'bp_0123456789abcdef0123456789abcdef'
const REMINDER = '7001001'
const STEP = '7002001'
const ON_STEP = '7003001'
const TO_ADD = '7003002'
const ACCOUNT = '5550001'
const values = { target: { reminder: REMINDER, step: STEP }, change: { template: TO_ADD } }
const lstep = lstepConnector()
const declaration = createBrowserConnectors([lstep.declaration])
const browser = declaration('lstep', '0.6.1')!
const operation = browser.operations.reminder_step_add_template
const COMBINATION = { declarationHash: `sha256:${'d'.repeat(64)}`, checkerHash: `sha256:${'c'.repeat(64)}`, factsVersion: 2 }
const SITE_SETTING = { host: HOST, level: 'write' as const, assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }

// ---------------------------------------------------------------------------
// A fake Lステップ (the shapes of browser-facts.test.ts)
// ---------------------------------------------------------------------------

interface FakeLstep {
  account: string
  steps: Record<string, string[]>
  /** The site's own timing text of the step, `GET /api/episode-steps/<step>` `step_timing_text` (design memo §40). */
  timingText: string
  bodies: Record<string, string>
  /** What the test stand-in for the not yet confirmed count reads (null = unknown, as today). */
  audience: number | null
  posts: string[]
  /** Called on every read of the reminder page (to change the site mid-run). */
  onPage?: () => void
  /** The write: applied and answered (302), refused (the status, nothing changes), or applied / not with the answer lost. */
  write: 'apply' | { refuse: number } | { lose: 'applied' | 'not-applied' } | 'throw-after-end'
  /** Someone else changes the step right after our write lands. */
  afterWrite?: () => void
  /** Called while the write session is prepared (before the permit is asked). */
  onPrepare?: () => void
  /** The page carries its CSRF fields (false: none). */
  token: boolean
  /** Templates that are no longer text only (another form type). */
  notText: string[]
  /**
   * The real page's rows of attached templates (design memo §40: delete forms with `hole_id`, no template
   * id): none (the 11/20 capture's slots only), beside the slots, or rows only (no slot with an id).
   */
  rows?: 'with-slots' | 'only'
}

function fakeLstep(over: Partial<FakeLstep> = {}): FakeLstep {
  return {
    account: ACCOUNT, steps: { [STEP]: [ON_STEP] }, timingText: '3日前 09:00',
    bodies: { [ON_STEP]: '本文1\n2行目', [TO_ADD]: '本文2\n2行目' }, audience: null, posts: [], write: 'apply', token: true, notText: [], ...over,
  }
}

const pageOf = (data: unknown[], current = 1, last = 1, total = data.length) =>
  JSON.stringify({ current_page: current, data, last_page: last, per_page: 50, total, links: [], next_page_url: null, prev_page_url: null })
const template = (site: FakeLstep, id: string, group: number) =>
  ({ id: Number(id), name: `架空テンプレ${id.slice(-1)}`, content_text: site.bodies[id], created_at: 'x', form_type: site.notText.includes(id) ? 2 : 8, group: { id: group, name: '架空フォルダ' }, editor_version: 2 })

function reminderPage(site: FakeLstep): string {
  let hole = 1
  const slots = (site.steps[STEP] ?? []).map(t => `<a onclick="openModal(${REMINDER}, ${STEP}, ${hole++}, ${t}, 8)">架空テンプレ</a>`).join('')
  return `<!doctype html><html><head><meta name="lm-account-id" content="${site.account}">${site.token ? '<meta name="csrf-token" content="tok">' : ''}</head><body>`
    + (site.token ? `<input type="hidden" name="_token" value="tok"><input type="hidden" name="_lm_user_id" value="u1">` : '')
    + (site.steps[STEP] && site.rows
      ? `<div id="template_confirm_${STEP}"><table>${(site.steps[STEP] ?? []).map((_t, i) => `<tr><td>#${i + 1} テンプレート 架空テンプレ</td><td><form method="POST" action="https://manager.linestep.net/line/episode/step/pack"><input type="hidden" name="_method" id="_method" value="DELETE"><input type="hidden" name="hole_id" id="hole_id" value="${16100001 + i}"><input type="hidden" name="content_id" id="content_id" value="${STEP}"></form></td></tr>`).join('')}</table></div>`
      : '')
    + (site.steps[STEP] ? `<div class="step" id="templateStep${STEP}"><span>当日</span>${site.rows === 'only' ? '' : slots}</div>` : '') + '</body></html>'
}

function siteAnswer(site: FakeLstep, address: string): { status: number; body: string } {
  if (address === `/line/episode/show/${REMINDER}`) { site.onPage?.(); return { status: 200, body: reminderPage(site) } }
  const pages: Record<string, string> = {
    [`/api/episode-steps/${STEP}`]: JSON.stringify({ episode_id: Number(REMINDER), episode_group_id: 7100001, episode_name: '架空のリマインダ', episode_step_id: Number(STEP), step_timing_text: site.timingText }),
    [`/api/episodes/${REMINDER}`]: JSON.stringify({ id: Number(REMINDER), name: '架空のリマインダ', order: 1, type: 1, hid_at: null, steps: Object.keys(site.steps).map((id, i) => ({
      id: Number(id), order: i, step_days: 0, step_time: '09:00:00', step_type: 1, step_minutes: null, skip: 1, initial: 0, egg_id: null, member_query_id: null, action_id: null, episode_id: Number(REMINDER),
    })) }),
    '/api/episode-groups': JSON.stringify({ data: [{ id: 7100001, name: '架空の配信', order: 1, item_count: 1 }] }),
    '/api/episodes?group=7100001&page=1': pageOf([{ id: Number(REMINDER), name: '架空のリマインダ', order: 1, type: 1, created_at: 'x', group_id: 7100001, group: { id: 7100001, name: '架空', order: 1 } }]),
    '/api/template-groups': JSON.stringify({ data: [{ id: 7200001, name: '架空甲', order: 1, item_count: 2 }] }),
    '/api/templates?group=7200001&page=1': pageOf([template(site, ON_STEP, 7200001), template(site, TO_ADD, 7200001)]),
  }
  return Object.prototype.hasOwnProperty.call(pages, address) ? { status: 200, body: pages[address] } : { status: 404, body: '' }
}

/** The real checker; its facts as 0.6.1 reads them, plus the not yet confirmed `shared_with` / `audience` from the fake (a test stand-in). */
function checkerFor(site: FakeLstep): BrowserChecker {
  const real = lstep.checkers[0]
  const facts = real.facts!
  return {
    ...real,
    facts: {
      version: facts.version,
      next: (v, a) => facts.next(v, a),
      read: (v, a) => {
        const out = facts.read(v, a)
        const extra: Record<string, BrowserFactDraft> = { shared_with: { status: 'known', value: { count: 1, items: ['架空の第1回'] }, complete: true, from: 0 } }
        if (site.audience !== null) extra.audience = { status: 'known', value: { count: site.audience }, from: 0 }
        return { ...out, facts: { ...out.facts, ...extra } }
      },
    },
  }
}

/** The facts the plan was registered with: read from the fake site as it stands now. */
async function approvedFacts(site: FakeLstep): Promise<Record<string, BrowserFact>> {
  const out = await readBrowserFacts({
    checker: checkerFor(site), browser, operation, factsVersion: 2, values, readers: lstep.readers,
    read: async address => siteAnswer(site, address), parseHtml: parseBrowserHtml, now: () => new Date(),
  })
  assert.ok(out.facts && out.problem === null, `the fake site makes a plan: ${out.facts ? out.problem : out.problem}`)
  return out.facts
}

// ---------------------------------------------------------------------------
// The window as the runner gets it (the shell's rules, without Electron)
// ---------------------------------------------------------------------------

function fakeWindow(site: FakeLstep) {
  let hooks: BrowserRunGateHooks | null = null
  const calls: string[] = []
  let closed = false
  const win: BrowserRunWindow = {
    run: {
      async enterAi(h) { hooks = h; calls.push('ai'); return true },
      async leaveAi() { hooks = null; calls.push('human') },
      async request({ method, path }) {
        if (closed || !hooks || !hooks.sessionRequest({ method, url: `https://${HOST}${path}` }).allow) throw new Error('refused')
        return siteAnswer(site, path)
      },
      async write(request, steps): Promise<BrowserWriteOutcome> {
        if (closed) return { sent: false, stage: 'prepare' }
        calls.push('prepared')
        site.onPrepare?.()
        let go = false
        try { go = await steps.ready() } catch { go = false }
        if (!go) return { sent: false, stage: 'ready' }
        // As the shell's send: the last check right before the request is ended.
        let last = false
        try { last = steps.beforeSend() === true } catch { last = false }
        if (!last) return { sent: false, stage: 'before-send' }
        calls.push('sent')
        // The window's write session asks the run's gate (a refusal there cancels it: no answer).
        if (!hooks || !hooks.sessionRequest({ method: request.method, url: `https://${HOST}${request.path}`, body: request.body }).allow) return { sent: true, answer: null }
        site.posts.push(request.body)
        const form = new URLSearchParams(request.body)
        const add = () => { site.steps[form.get('content_id')!].push(form.get('template_id')!); site.afterWrite?.() }
        if (site.write === 'throw-after-end') { add(); throw new Error('connection reset') }
        if (typeof site.write === 'object' && 'lose' in site.write) {
          if (site.write.lose === 'applied') add()
          return { sent: true, answer: null }
        }
        if (typeof site.write === 'object') return { sent: true, answer: { status: site.write.refuse, body: '' } }
        add()
        return { sent: true, answer: { status: 302, body: '' } }
      },
      closed: () => closed,
    },
    preview: {
      async read(address) { if (closed) throw new Error('closed'); return siteAnswer(site, address) },
      closed: () => closed,
    },
  }
  return { win, calls, close: () => { closed = true } }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

async function harness(o: { site?: Partial<FakeLstep>; faults?: FakeServerFaults; deps?: Partial<BrowserRunnerDeps>; approved?: (facts: Record<string, BrowserFact>) => Record<string, BrowserFact> } = {}) {
  const site = fakeLstep(o.site)
  const facts = await approvedFacts(site)
  const server = fakePlansServer({
    planId: PLAN, companyId: COMPANY, connector: { id: 'lstep', version: '0.6.1', ...COMBINATION }, operation: 'reminder_step_add_template',
    account: ACCOUNT, target: values.target, change: values.change, facts: o.approved ? o.approved(facts) : facts, createdAt: Date.now() - 60_000,
  }, o.faults)
  const window = fakeWindow(site)
  const records: BrowserStepRecord[] = []
  const clock = { wall: Date.now(), mono: 1_000_000 }
  const live = { context: true, stopped: false, policy: SITE_SETTING as typeof SITE_SETTING | null }
  const checkers = createBrowserCheckerRegistry([checkerFor(site)])
  const deps: BrowserRunnerDeps = {
    aiSwitch: () => true,
    plans: server.api,
    connector: declaration,
    combination: (id, version) => (id === 'lstep' && version === '0.6.1' ? COMBINATION : null),
    checker: id => checkers.get(id),
    reader: id => lstep.readers.find(r => r.id === id),
    site: () => live.policy,
    stopped: () => live.stopped,
    window: () => window.win,
    parse: parseBrowserHtml,
    context: () => () => live.context,
    records: { has: id => records.some(r => r.planId === id), put: r => { records.push(r) } },
    now: () => clock.wall,
    monoMs: () => clock.mono,
    log: { warn: () => {} },
    ...o.deps,
  }
  const runner = createBrowserRunner(deps)
  const run = () => runner.run({ companyId: COMPANY, planId: PLAN, contentHash: server.contentHash })
  return { runner, run, site, server, window, records, clock, live, deps }
}

const states = (records: readonly BrowserStepRecord[]) => records.map(r => r.reason ? `${r.state}:${r.reason}` : r.state)

// ---------------------------------------------------------------------------
// The happy path and the claim
// ---------------------------------------------------------------------------

test('an approved plan is claimed, read again, permitted and sent exactly once; the page shows the plan; the server is told succeeded once', async () => {
  const h = await harness()
  assert.deepEqual(await h.run(), { outcome: 'succeeded' })
  assert.equal(h.site.posts.length, 1)
  assert.deepEqual([...new URLSearchParams(h.site.posts[0]).entries()], [['content_id', STEP], ['template_id', TO_ADD], ['_token', 'tok'], ['_lm_user_id', 'u1']])
  assert.deepEqual(h.site.steps[STEP], [ON_STEP, TO_ADD])
  assert.deepEqual(h.server.state.calls, ['approve', 'claim', 'permit', 'report'])
  assert.deepEqual(h.server.state.reports, [{ result: 'succeeded' }])
  assert.equal(h.server.state.execution, 'succeeded')
  assert.deepEqual(states(h.records), ['claimed', 'permit-asked', 'succeeded'])
  assert.deepEqual(h.window.calls, ['ai', 'prepared', 'sent', 'human'], 'the session is prepared before the permit; back to the member\'s mode')
  // This PC keeps ids and fixed words only: never the secret, the account, a template or a token.
  assert.doesNotMatch(JSON.stringify(h.records), new RegExp(`${h.server.state.secret}|${ACCOUNT}|${TO_ADD}|tok|u1`))
})

test('an older server\'s claim without the fixed content never runs: nothing read from the site, nothing sent, the plan given back', async () => {
  const h = await harness({ faults: { noFixed: true } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'server-too-old' })
  assert.deepEqual(h.site.posts, [])
  assert.deepEqual(h.window.calls, [], 'the window was never touched')
  assert.deepEqual(h.server.state.calls, ['approve', 'claim', 'cancel'])
  assert.equal(h.server.state.execution, 'void')
})

test('fixed content that is not what the person approved, or a claim that disagrees with it, never runs', async () => {
  const tampers: Array<[string, (claim: Record<string, unknown>) => void]> = [
    ['another hash', c => { (c.fixed as { contentHash: string }).contentHash = `sha256:${'0'.repeat(64)}` }],
    // A template's body other than the one approved, everything the plan names unchanged: only the hash tells.
    ['content not hashing to its hash', c => { const f = c.fixed as { content: string }; f.content = f.content.replace('本文2', '本文X') }],
    ['a plan with another template', c => { (c.plan as { change: Record<string, string> }).change = { template: '7003009' } }],
    ['a plan with another before', c => { (c.plan as { before: Record<string, string[]> }).before = { templates: [] } }],
    ['a plan with another account', c => { (c.plan as { account: string }).account = '5550002' }],
    ['another facts version', c => { (c.fixed as { factsVersion: number }).factsVersion = 1 }],
  ]
  for (const [label, tamperClaim] of tampers) {
    const h = await harness({ faults: { tamperClaim } })
    assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'fixed-mismatch' }, label)
    assert.deepEqual(h.site.posts, [], label)
    assert.deepEqual(h.window.calls, [], label)
    assert.equal(h.server.state.execution, 'void', label)
  }
})

test('a combination this build does not carry (another declaration or checker hash) never runs', async () => {
  const h = await harness({ deps: { combination: () => ({ ...COMBINATION, checkerHash: `sha256:${'e'.repeat(64)}` }) } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'connector' })
  assert.deepEqual(h.site.posts, [])
  assert.equal(h.server.state.execution, 'void')
})

test('with the build\'s switch (off in 6b) nothing is asked: no server call, no window, no record', async () => {
  const h = await harness({ deps: { aiSwitch: undefined } })
  assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'off' })
  assert.deepEqual(h.server.state.calls, [])
  assert.deepEqual(h.window.calls, [])
  assert.deepEqual(h.records, [])
})

// ---------------------------------------------------------------------------
// Before the permit: the full re-read
// ---------------------------------------------------------------------------

test('anything the person approved that changed on the site stops the run before the permit, saying what: nothing sent, the plan given back', async () => {
  const changes: Array<[string, (h: Awaited<ReturnType<typeof harness>>) => void, string]> = [
    ['a template body', h => { h.site.bodies[TO_ADD] = '変えた本文' }, 'facts-changed'],
    ['the step\'s timing', h => { h.site.timingText = '3日前 10:00' }, 'facts-changed'],
    ['another template on the step', h => { h.site.steps[STEP].push(TO_ADD) }, 'before-changed'],
    ['the LINE account', h => { h.site.account = '5550002' }, 'account-mismatch'],
    // The re-read cannot make a plan by itself: the site could not be read whole.
    ['a template list that fails', h => { h.site.bodies[TO_ADD] = '' }, 'read-failed'],
    ['a read the checker cannot make', h => { h.deps.reader = () => undefined }, 'read-failed'],
    // The checker's own word: the template to add is no longer text only.
    ['a template no longer text only', h => { h.site.notText.push(TO_ADD) }, 'checker-problem'],
  ]
  for (const [label, change, reason] of changes) {
    const h = await harness()
    change(h)
    const runner = createBrowserRunner(h.deps)
    assert.deepEqual(await runner.run({ companyId: COMPANY, planId: PLAN, contentHash: h.server.contentHash }), { outcome: 'stopped', reason }, label)
    assert.deepEqual(h.site.posts, [], label)
    assert.equal(h.server.state.calls.includes('permit'), false, `${label}: no permit asked`)
    assert.equal(h.server.state.execution, 'void', label)
    assert.deepEqual(states(h.records), ['claimed', `failed:${reason}`], label)
  }
})

test('the count of people who will receive it may fall, never rise; unknown at approval and known now is a change', async () => {
  const rose = await harness({ site: { audience: 3 } })
  rose.site.audience = 4
  assert.deepEqual(await rose.run(), { outcome: 'stopped', reason: 'facts-changed' })
  assert.deepEqual(rose.site.posts, [])
  const appeared = await harness()
  appeared.site.audience = 2
  assert.deepEqual(await appeared.run(), { outcome: 'stopped', reason: 'facts-changed' })
  assert.deepEqual(appeared.site.posts, [])
  const fell = await harness({ site: { audience: 3 } })
  fell.site.audience = 2
  assert.deepEqual(await fell.run(), { outcome: 'succeeded' })
})

test('a stop, a setting change or a changed context before the permit gives the plan back with nothing sent', async () => {
  for (const label of ['stopped', 'policy', 'context-changed'] as const) {
    const h = await harness()
    let reads = 0
    h.site.onPage = () => {
      if (++reads !== 2) return
      if (label === 'stopped') h.live.stopped = true
      else if (label === 'policy') h.live.policy = null
      else h.live.context = false
    }
    const result = await h.run()
    assert.equal(result.outcome, 'stopped', label)
    assert.deepEqual(h.site.posts, [], label)
    assert.equal(h.server.state.calls.includes('permit'), false, label)
  }
})

test('nothing is asked of the permit when this PC cannot keep its record first', async () => {
  let puts = 0
  const h = await harness({ deps: { records: { has: () => false, put: () => { if (++puts === 2) throw new Error('disk full') } } } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'records-unavailable' })
  assert.equal(h.server.state.calls.includes('permit'), false)
  assert.deepEqual(h.site.posts, [])
  assert.equal(h.server.state.execution, 'void')
})

// ---------------------------------------------------------------------------
// The permit and the last check right before sending
// ---------------------------------------------------------------------------

test('the permit is live only under 5 s since just before it was asked, on both clocks: 4999 ms sends, 5000 ms on either clock or a wall clock set back does not', async () => {
  const cases: Array<[string, { mono: number; wall: number }, boolean]> = [
    ['4999 ms on both', { mono: 4999, wall: 4999 }, true],
    ['5000 ms on the monotonic clock (the wall clock set back meanwhile)', { mono: 5000, wall: 0 }, false],
    ['5000 ms on the wall clock (asleep: the monotonic clock stopped)', { mono: 0, wall: 5000 }, false],
    ['the wall clock set back', { mono: 10, wall: -1 }, false],
  ]
  for (const [label, move, sends] of cases) {
    const faults: FakeServerFaults = {}
    const again = await harness({ faults })
    faults.onPermit = () => { again.clock.mono += move.mono; again.clock.wall += move.wall }
    const result = await again.run()
    if (sends) {
      assert.deepEqual(result, { outcome: 'succeeded' }, label)
      assert.equal(again.site.posts.length, 1, label)
    } else {
      assert.deepEqual(result, { outcome: 'failed', reason: 'permit-late' }, label)
      assert.deepEqual(again.site.posts, [], label)
      assert.deepEqual(again.server.state.reports, [{ result: 'failed', reason: 'permit-late' }], label)
      assert.equal(again.server.state.execution, 'failed', label)
      assert.ok(stoppedBeforeSending(again.records, PLAN), `${label}: this PC's hint says it stopped before sending`)
    }
  }
})

test('a stop, a closed window or a changed context between the permit and the send stops it: failed, nothing sent', async () => {
  for (const label of ['stopped', 'window-closed', 'context-changed'] as const) {
    const faults: FakeServerFaults = {}
    const h = await harness({ faults })
    faults.onPermit = () => {
      if (label === 'stopped') h.live.stopped = true
      else if (label === 'window-closed') h.window.close()
      else h.live.context = false
    }
    assert.deepEqual(await h.run(), { outcome: 'failed', reason: label }, label)
    assert.deepEqual(h.site.posts, [], label)
    // The server's reason words name a closed window a changed context (6b-2 §5-5).
    assert.deepEqual(h.server.state.reports, [{ result: 'failed', reason: label === 'window-closed' ? 'context-changed' : label }], label)
  }
})

test('the last check failing by a throw is not a send: failed, nothing sent', async () => {
  const faults: FakeServerFaults = {}
  const h = await harness({ faults })
  faults.onPermit = () => { h.deps.stopped = () => { throw new Error('the stop store is gone') } }
  // The stop is asked in the last check; a throw there must never let the request leave.
  const result = await h.run()
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(h.site.posts, [])
})

test('a permit the server refuses: nothing sent, nothing reported (the server made it void)', async () => {
  const h = await harness({ faults: { permit: 'refuse' } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'permit-refused' })
  assert.deepEqual(h.site.posts, [])
  assert.deepEqual(h.server.state.reports, [])
  assert.equal(h.server.state.calls.includes('cancel'), false)
})

test('no usable permit answer (a network error, a malformed answer, none within 5 s): never sent, reported failed', async () => {
  for (const permit of ['throw', { value: { permittedAt: 'later', validMs: 5000 } }, 'hang'] as const) {
    const h = await harness({ faults: { permit } })
    const started = Date.now()
    assert.deepEqual(await h.run(), { outcome: 'failed', reason: 'permit-unanswered' }, JSON.stringify(permit))
    assert.deepEqual(h.site.posts, [])
    assert.equal(h.server.state.calls.filter(c => c === 'permit').length, 1, 'asked once, never again')
    assert.deepEqual(h.server.state.reports.map(r => r.result), ['failed'])
    if (permit === 'hang') assert.ok(Date.now() - started >= 4900, 'it waited the permit\'s 5 s, no longer')
  }
})

// ---------------------------------------------------------------------------
// After the send: never failed, never again
// ---------------------------------------------------------------------------

test('a site that refuses the write (4xx) with the page unchanged is unknown, never failed ("not sent" would be false)', async () => {
  for (const status of [419, 422]) {
    const h = await harness({ site: { write: { refuse: status } } })
    assert.deepEqual(await h.run(), { outcome: 'unknown', reason: 'other-state' }, String(status))
    assert.equal(h.site.posts.length, 1)
    assert.deepEqual(h.server.state.reports, [{ result: 'unknown', reason: 'other-state' }])
    assert.equal(stoppedBeforeSending(h.records, PLAN), false, 'no hint that it was not sent')
  }
})

test('an error, a lost answer or a disconnect after the request left is unknown (never failed) and never sent again', async () => {
  for (const write of ['throw-after-end', { lose: 'applied' }, { lose: 'not-applied' }] as const) {
    const h = await harness({ site: { write } })
    assert.deepEqual(await h.run(), { outcome: 'unknown', reason: 'no-answer' }, JSON.stringify(write))
    assert.equal(h.site.posts.length, 1)
    assert.deepEqual(h.server.state.reports, [{ result: 'unknown', reason: 'no-answer' }])
    // The same press again (or the card asking again): this PC never runs it, the server never hands it out again.
    assert.deepEqual(await h.run(), { outcome: 'refused', reason: 'already-ran' })
    const otherPc = createBrowserRunner({ ...h.deps, records: { has: () => false, put: () => {} } })
    assert.equal((await otherPc.run({ companyId: COMPANY, planId: PLAN, contentHash: h.server.contentHash })).outcome, 'refused')
    assert.equal(h.site.posts.length, 1, 'never sent again')
    assert.equal(h.server.state.calls.filter(c => c === 'permit').length, 1, 'no second permit')
  }
})

test('the page read after the send decides: only exactly the planned state is success', async () => {
  const other = await harness({ site: { afterWrite: () => { other.site.steps[STEP].push('7003999') } } })
  assert.deepEqual(await other.run(), { outcome: 'unknown', reason: 'other-state' })
  const gone = await harness({ site: { afterWrite: () => { gone.site.steps = {} } } })
  assert.deepEqual(await gone.run(), { outcome: 'unknown', reason: 'target-after' })
  const account = await harness({ site: { afterWrite: () => { account.site.account = '5550009' } } })
  assert.deepEqual(await account.run(), { outcome: 'unknown', reason: 'account-after' })
  // Stopped right after the send: the read is refused by the run's gate — not known, not failed.
  const stopped = await harness({ site: { afterWrite: () => { stopped.live.stopped = true } } })
  assert.deepEqual(await stopped.run(), { outcome: 'unknown', reason: 'reread-failed' })
  for (const h of [other, gone, account, stopped]) assert.equal(h.site.posts.length, 1)
  // The real page's rows (design memo §40): matched one for one by id slots, the planned state is read —
  // success; rows without id slots after the send cannot say which template is there — unknown, never failed.
  const rows = await harness({ site: { rows: 'with-slots' } })
  assert.deepEqual(await rows.run(), { outcome: 'succeeded' })
  const rowsOnly = await harness({ site: { rows: 'with-slots', afterWrite: () => { rowsOnly.site.rows = 'only' } } })
  assert.deepEqual(await rowsOnly.run(), { outcome: 'unknown', reason: 'target-after' })
  assert.deepEqual(rowsOnly.server.state.reports, [{ result: 'unknown', reason: 'target-after' }])
})

test('a lost report is sent again with the same body, at most 3 times; a refused one is not', async () => {
  const lost = await harness({ faults: { lostReports: 2 } })
  assert.deepEqual(await lost.run(), { outcome: 'succeeded' })
  assert.equal(lost.server.state.calls.filter(c => c === 'report').length, 3)
  assert.deepEqual(lost.server.state.reports, [{ result: 'succeeded' }])
  const gone = await harness({ faults: { lostReports: 5 } })
  assert.deepEqual(await gone.run(), { outcome: 'succeeded' })
  assert.equal(gone.server.state.calls.filter(c => c === 'report').length, 3, 'then the server\'s time-out settles it')
  assert.equal(gone.site.posts.length, 1)
})

test('this PC\'s record is only a hint, and only "stopped before sending" (failed) says so', () => {
  const at = Date.now()
  const r = (state: BrowserStepRecord['state']): BrowserStepRecord => ({ planId: PLAN, operation: 'op', step: 0, state, at })
  assert.equal(stoppedBeforeSending([r('claimed'), r('permit-asked')], PLAN), false, 'a crash after asking: it may have been sent')
  assert.equal(stoppedBeforeSending([r('claimed'), r('permit-asked'), r('unknown')], PLAN), false)
  assert.equal(stoppedBeforeSending([r('claimed'), r('permit-asked'), r('failed')], PLAN), true)
  assert.equal(stoppedBeforeSending([], PLAN), false)
})

// ---------------------------------------------------------------------------
// The type, the checker and the window, checked after the claim (each gives the plan back)
// ---------------------------------------------------------------------------

test('after the claim, a type or checker this build cannot vouch for gives the plan back with nothing sent', async () => {
  const real = (site: FakeLstep) => checkerFor(site)
  const removing: PluginBrowser = { ...browser, operations: { reminder_step_add_template: { ...operation, expect: [{ list: 'templates', change: 'remove', field: 'template' }] } } }
  const same: PluginBrowser = { ...browser, operations: { reminder_step_add_template: { ...operation, expect: [{ list: 'templates', change: 'add', field: 'template' }, { list: 'templates', change: 'remove', field: 'template' }] } } }
  const otherChecker: PluginBrowser = { ...browser, operations: { reminder_step_add_template: { ...operation, checker: 'lstep.something_else' } } }
  const cases: Array<[string, (site: FakeLstep) => Partial<BrowserRunnerDeps>]> = [
    ['unknown-checker', () => ({ checker: () => undefined })],
    ['unknown-checker', site => ({ connector: () => otherChecker, checker: () => real(site) })],
    ['target-unconfirmed', site => ({ checker: () => ({ ...real(site), confirms: ['step'] }) })],
    ['connector', site => ({ checker: () => ({ ...real(site), facts: { ...real(site).facts!, version: 1 } }) })],
    ['cannot-come-true', () => ({ connector: () => removing })],
    ['no-visible-change', () => ({ connector: () => same })],
    ['policy', () => ({ site: () => ({ ...SITE_SETTING, level: 'read' as const }) })],
    ['no-window', () => ({ window: () => null })],
  ]
  for (const [reason, deps] of cases) {
    const site = fakeLstep()
    const h = await harness({ deps: deps(site) })
    assert.deepEqual(await h.run(), { outcome: 'stopped', reason }, reason)
    assert.deepEqual(h.site.posts, [], reason)
    assert.equal(h.server.state.calls.includes('permit'), false, reason)
    assert.equal(h.server.state.execution, 'void', reason)
  }
})

test('the checker\'s look right before the permit: a page without its CSRF field stops it; a checker\'s own text never reaches a record or a result', async () => {
  const noToken = await harness()
  noToken.site.token = false
  assert.deepEqual(await noToken.run(), { outcome: 'stopped', reason: 'csrf-missing' })
  assert.deepEqual(noToken.site.posts, [])
  const site = fakeLstep()
  const chatty = checkerFor(site)
  const talking: BrowserChecker = { ...chatty, view: (v, r) => ({ ...chatty.view(v, r), problem: `token ${ACCOUNT} tok` }) }
  const h = await harness({ deps: { checker: () => talking } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'checker-problem' })
  assert.doesNotMatch(JSON.stringify(h.records), new RegExp(`${ACCOUNT}|tok`))
})

test('a plan whose hour runs out during the run stops before the permit', async () => {
  const h = await harness()
  h.site.onPage = () => { h.clock.wall += 3600_000 }
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'expired' })
  assert.deepEqual(h.site.posts, [])
  assert.equal(h.server.state.calls.includes('permit'), false)
})

test('one run per window at a time: a second plan for the same window is given back, nothing sent', async () => {
  const first = await harness()
  const second = await harness()
  // The second plan, its own server, the same runner and window.
  const SECOND = 'bp_fedcba9876543210fedcba9876543210'
  const other = fakePlansServer({
    planId: SECOND, companyId: COMPANY, connector: { id: 'lstep', version: '0.6.1', ...COMBINATION }, operation: 'reminder_step_add_template',
    account: ACCOUNT, target: values.target, change: values.change, facts: await approvedFacts(second.site), createdAt: Date.now() - 60_000,
  })
  let release: () => void = () => {}
  const held = new Promise<void>(r => { release = r })
  const route = (planId: string) => (planId === SECOND ? other.api : first.server.api)
  const runner = createBrowserRunner({
    ...first.deps,
    plans: {
      approve: (c, p, hash) => route(p).approve(c, p, hash),
      claim: (c, p) => route(p).claim(c, p),
      cancel: (c, p) => route(p).cancel(c, p),
      permit: (c, e, s, signal) => (e.endsWith(SECOND.slice(-16)) ? other.api : first.server.api).permit(c, e, s, signal),
      report: (e, s, b) => (e.endsWith(SECOND.slice(-16)) ? other.api : first.server.api).report(e, s, b),
    },
    window: () => ({ ...first.window.win, run: { ...first.window.win.run, enterAi: async hooks => { await held; return first.window.win.run.enterAi(hooks) } } }),
  })
  const running = runner.run({ companyId: COMPANY, planId: PLAN, contentHash: first.server.contentHash })
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(await runner.run({ companyId: COMPANY, planId: SECOND, contentHash: other.contentHash }), { outcome: 'stopped', reason: 'busy' })
  assert.equal(other.state.execution, 'void')
  release()
  assert.deepEqual(await running, { outcome: 'succeeded' })
  assert.equal(first.site.posts.length, 1)
})

test('a stop while the write session is prepared: the permit is never asked, the plan given back', async () => {
  const h = await harness({ site: { onPrepare: () => { h.live.stopped = true } } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'stopped' })
  assert.equal(h.server.state.calls.includes('permit'), false)
  assert.equal(h.server.state.execution, 'void')
  assert.deepEqual(h.site.posts, [])
})

test('fixed content the server stored in another spelling than canonical JSON never runs, even though it hashes to what was approved', async () => {
  // The same object written with spaces: it parses to the same plan, but what was hashed is not what the core reads.
  const h = await harness({ faults: { contentText: text => JSON.stringify(JSON.parse(text), null, 1) } })
  assert.deepEqual(await h.run(), { outcome: 'stopped', reason: 'fixed-mismatch' })
  assert.deepEqual(h.site.posts, [])
})

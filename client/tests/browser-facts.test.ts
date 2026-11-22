/**
 * The facts read for a plan (6b-2b; agent-browser.md "The facts a checker reads"): the core's driver
 * (client/shared/browser-facts.ts) with the real Lステップ 0.6.1 connector against a fake Lステップ in the
 * real site's shapes (design memo §34–§36; every name and id made up), pages parsed by the real parser.
 * What is protected: facts come only from declared reads at addresses the core builds; what the site
 * shows is what the person approves (never a guess: unconfirmed facts are unknown and make no plan);
 * text-only templates; the step's timing only through the fixed table from the reminder's JSON (0.6.1,
 * design memo §39); a page the core could not read whole gives no view-read fact; the re-read refuses
 * any change (6b-2 §5-2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrowserHtml } from '../electron/features/browser/html'
import { createBrowserConnectors } from '../shared/browser-checkers'
import { readBrowserFacts, BROWSER_FACT_READS, type BrowserFactsInput } from '../shared/browser-facts'
import type { BrowserChecker } from '../shared/browser-runner'
import { lstepConnector } from '../connectors/lstep'
import { browserFactsChangedProblem, browserFactsProblem, type BrowserFact } from '../../shared/core/browser-plans'
import { browserFirstVersionProblem, expectedAfter } from '../../shared/core/plugin-browser-declaration'

const lstep = lstepConnector()
const browser = createBrowserConnectors([lstep.declaration])('lstep', '0.6.1')!
const operation = browser.operations.reminder_step_add_template
const checker = lstep.checkers[0]

const REMINDER = '7001001'
const STEP = '7002001'
const ON_STEP = '7003001'
const TO_ADD = '7003002'
const values = { target: { reminder: REMINDER, step: STEP }, change: { template: TO_ADD } }

const box = (inner: string) => `<div class="step" id="templateStep${STEP}">${inner}<a onclick="openModal(${REMINDER}, ${STEP}, 1, ${ON_STEP}, 8)">架空テンプレ甲</a></div>`
const reminderPage = (body: string, account = '<meta name="lm-account-id" content="5550001">') =>
  `<!doctype html><html><head>${account}<meta name="csrf-token" content="tok"></head><body><input type="hidden" name="_token" value="tok">${body}</body></html>`
const pageOf = (data: unknown[], current = 1, last = 1, total = data.length) =>
  JSON.stringify({ current_page: current, data, last_page: last, per_page: 50, total, links: [], next_page_url: null, prev_page_url: null })
const template = (id: string, group: number, over: Record<string, unknown> = {}) =>
  ({ id: Number(id), name: `架空テンプレ${id.slice(-1)}`, content_text: `本文${id.slice(-1)}\n2行目`, created_at: 'x', form_type: 8, group: { id: group, name: '架空フォルダ' }, editor_version: 2, ...over })
/** `GET /api/episodes/<reminder>` in the real site's shape (design memo §39; values made up). */
const stepJson = (id: string, over: Record<string, unknown> = {}) => ({
  id: Number(id), order: 1, step_days: 0, step_time: '09:00:00', step_type: 1, step_minutes: null, skip: 1, initial: 0,
  egg_id: null, member_query_id: null, action_id: null, episode_id: Number(REMINDER), ...over,
})
const episodeJson = (steps: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: Number(REMINDER), name: '架空のリマインダ', order: 1, type: 1, hid_at: null, steps, ...over })
const SCHEDULE = `/api/episodes/${REMINDER}`

/** The fake site by exact address (anything else is a 404). */
function site(over: Record<string, string | null> = {}): Record<string, string> {
  const pages: Record<string, string | null> = {
    [`/line/episode/show/${REMINDER}`]: reminderPage(box('<span>当日 09:00</span>')),
    [SCHEDULE]: episodeJson([stepJson('7002000', { order: 0, step_days: 1, step_time: '19:00:00' }), stepJson(STEP)]),
    '/api/template-groups': JSON.stringify({ data: [{ id: 0, name: '未分類', order: 0, item_count: 1 }, { id: 7200001, name: '架空甲', order: 1, item_count: 1 }, { id: 7200002, name: '架空乙', order: 2, item_count: 1 }] }),
    '/api/templates?group=7200001&page=1': pageOf([template(ON_STEP, 7200001)]),
    '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002)]),
    ...over,
  }
  return Object.fromEntries(Object.entries(pages).filter((e): e is [string, string] => e[1] !== null))
}

function input(pages: Record<string, string>, over: Partial<BrowserFactsInput> = {}) {
  const reads: string[] = []
  const deps: BrowserFactsInput = {
    checker, browser, operation, factsVersion: 2, values, readers: lstep.readers,
    read: async address => { reads.push(address); return Object.prototype.hasOwnProperty.call(pages, address) ? { status: 200, body: pages[address] } : { status: 404, body: '' } },
    parseHtml: parseBrowserHtml,
    now: () => new Date(),
    ...over,
  }
  return { deps, reads }
}

async function factsOf(pages: Record<string, string>) {
  const { deps, reads } = input(pages)
  const out = await readBrowserFacts(deps)
  assert.ok(out.facts, `no facts: ${out.problem}`)
  return { ...out, facts: out.facts, reads }
}
const valueOf = (facts: Record<string, BrowserFact>, name: string) => (facts[name].status === 'known' ? facts[name].value : 'unknown')
/** A `shared_with` read (Lステップ has none: the fact is optional since 0.6.1, the owner 2026-11-22); for the re-read's rules only. */
const withSharedWith = (facts: Record<string, BrowserFact>): Record<string, BrowserFact> =>
  ({ ...facts, shared_with: { status: 'known', value: { count: 1, items: ['架空の第1回'] }, complete: true, readAt: facts.shared_with.readAt, source: facts.shared_with.source } })

test('Lステップ 0.6.1 is scheduled with facts version 2 and passes the first version\'s rule: timing and templates required and read whole, the count optional', () => {
  assert.equal(operation.delivers, 'scheduled')
  assert.equal(checker.facts?.version, 2)
  assert.equal(browserFirstVersionProblem(operation), null)
  assert.deepEqual(operation.facts.audience, { required: false, complete: false })
})

test('the facts come from exactly the declared reads, scanning template folders in order until each id is found; confirmed facts are known, unconfirmed ones unknown — and the optional ones unknown still make a plan', async () => {
  const { facts, problem, reads } = await factsOf(site())
  assert.deepEqual(reads, [
    `/line/episode/show/${REMINDER}`,
    SCHEDULE, '/api/template-groups',
    '/api/templates?group=7200001&page=1', '/api/templates?group=7200002&page=1',
  ], '「未分類」 (0) is never asked; the reminder\'s name comes with its steps (no reminder folder walk)')
  assert.deepEqual(valueOf(facts, 'account'), { id: '5550001' })
  assert.deepEqual(valueOf(facts, 'step_parent'), { reminder: REMINDER })
  assert.deepEqual(valueOf(facts, 'state'), { templates: [ON_STEP] })
  assert.deepEqual(valueOf(facts, 'schedule'), { timing: '当日 09:00' })
  assert.deepEqual(valueOf(facts, 'names'), { reminder: '架空のリマインダ', step: '当日 09:00' })
  assert.deepEqual(valueOf(facts, 'templates'), {
    [ON_STEP]: { name: '架空テンプレ1', kind: 'text', body: '本文1\n2行目' },
    [TO_ADD]: { name: '架空テンプレ2', kind: 'text', body: '本文2\n2行目' },
  })
  assert.equal(facts.templates.complete, true)
  assert.equal(facts.schedule.complete, true)
  // Where each was read (a path, never the query) and when.
  assert.equal(facts.templates.source, '/api/templates')
  assert.equal(facts.account.source, `/line/episode/show/${REMINDER}`)
  assert.equal(facts.schedule.source, SCHEDULE)
  assert.equal(facts.names.source, SCHEDULE)
  assert.ok(Object.values(facts).every(f => !Number.isNaN(Date.parse(f.readAt))))
  // Not readable on the real site: unknown, never guessed. Both optional (0.6.1: Lステップ cannot say which
  // 回 use a reminder; the card shows the shared warning instead), so the facts make a plan.
  assert.equal(facts.shared_with.status, 'unknown')
  assert.equal(facts.audience.status, 'unknown')
  assert.deepEqual(operation.facts.shared_with, { required: false, complete: false })
  assert.equal(problem, null)
  // A shared_with that is read is still held to its shape.
  assert.equal(browserFactsProblem(operation, 2, { ...facts, shared_with: { ...facts.shared_with, status: 'known', value: { count: -1, items: [] } } }, values), '「shared_with」の値の形が正しくありません')
  assert.deepEqual(expectedAfter(valueOf(facts, 'state') as Record<string, string[]>, operation, values), { templates: [ON_STEP, TO_ADD] })
})

test('text-only templates: a template of another form_type, one only in 「未分類」, one naming another folder or one found twice differently is not read, so no plan', async () => {
  const notText = await factsOf(site({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002, { form_type: 9 })]) }))
  assert.equal(notText.facts.templates.status, 'unknown')
  assert.equal(notText.checkerProblem, 'template-not-text')
  assert.equal(browserFactsProblem(operation, 2, withSharedWith(notText.facts), values), '「templates」をサイトから読み取れていません')
  // form_type written as text is not the confirmed 8.
  assert.equal((await factsOf(site({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002, { form_type: '8' })]) }))).facts.templates.status, 'unknown')
  // The one on the step is not text: also no plan.
  assert.equal((await factsOf(site({ '/api/templates?group=7200001&page=1': pageOf([template(ON_STEP, 7200001, { form_type: 3 })]) }))).facts.templates.status, 'unknown')
  // Only in 「未分類」 (never asked): not found.
  const uncategorised = await factsOf(site({ '/api/templates?group=7200002&page=1': pageOf([]), '/api/templates?group=0&page=1': pageOf([template(TO_ADD, 0)]) }))
  assert.equal(uncategorised.facts.templates.status, 'unknown')
  assert.equal(uncategorised.reads.includes('/api/templates?group=0&page=1'), false)
  // An entry naming another folder than the one asked.
  assert.equal((await factsOf(site({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200001)]) }))).facts.templates.status, 'unknown')
  // The same id twice with different contents.
  const twice = site({
    '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002), template(TO_ADD, 7200002, { content_text: '別の本文' })]),
  })
  assert.equal((await factsOf(twice)).facts.templates.status, 'unknown')
  // A body that is not plain text (a control character).
  assert.equal((await factsOf(site({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002, { content_text: 'a\u0007b' })]) }))).facts.templates.status, 'unknown')
  // A folder answer that fails or does not parse strictly (a key written twice).
  assert.equal((await factsOf(site({ '/api/templates?group=7200002&page=1': null }))).facts.templates.status, 'unknown')
  const repeated = `{"data":[],"data":${JSON.stringify([template(TO_ADD, 7200002)])}}`
  assert.equal((await factsOf(site({ '/api/templates?group=7200002&page=1': repeated }))).facts.templates.status, 'unknown', 'JSON.parse would keep the last copy')
  // A page saying it is another page than the one asked: the folder's later pages are not read.
  const misnumbered = await factsOf(site({
    '/api/templates?group=7200002&page=1': pageOf([], 2, 2, 1),
    '/api/templates?group=7200002&page=2': pageOf([template(TO_ADD, 7200002)], 2, 2, 1),
  }))
  assert.equal(misnumbered.facts.templates.status, 'unknown')
  assert.equal(misnumbered.reads.includes('/api/templates?group=7200002&page=2'), false)
})

test('the step\'s timing comes only from the reminder\'s JSON through the fixed table (step_type 1, step_days 0, HH:MM:00 → 「当日 HH:MM」); anything else is unknown and makes no plan', async () => {
  const withSteps = async (steps: unknown[], over: Record<string, unknown> = {}) => (await factsOf(site({ [SCHEDULE]: episodeJson(steps, over) }))).facts
  const timing = async (step: Record<string, unknown>) => valueOf(await withSteps([stepJson(STEP, step)]), 'schedule')
  // The mapping.
  assert.deepEqual(await timing({}), { timing: '当日 09:00' }, 'the combination seen on the real site (§39)')
  assert.deepEqual(await timing({ step_time: '19:05:00' }), { timing: '当日 19:05' })
  assert.deepEqual(await timing({ step_time: '00:00:00' }), { timing: '当日 00:00' })
  assert.deepEqual(await timing({ step_time: '23:59:00' }), { timing: '当日 23:59' })
  // Not seen, so not mapped: another day (either sign), another step_type, seconds, a malformed or
  // missing time, values written as text.
  for (const odd of [
    { step_days: 3 }, { step_days: -3 }, { step_days: 1 }, { step_type: 2 }, { step_type: 0 }, { step_type: '1' }, { step_days: '0' },
    { step_time: '09:00:30' }, { step_time: '9:00:00' }, { step_time: '24:00:00' }, { step_time: '09:00' }, { step_time: null }, { step_type: undefined },
    // Only the skip / initial / step_minutes seen on the real site (§39: 1 / 0 / null); their meaning is not confirmed.
    { skip: 0 }, { skip: 2 }, { skip: '1' }, { skip: true }, { skip: undefined }, { initial: 1 }, { initial: '0' }, { initial: undefined },
    { step_minutes: 0 }, { step_minutes: 30 }, { step_minutes: undefined },
  ]) assert.equal(await timing(odd), 'unknown', JSON.stringify(odd))
  const unread = await withSteps([stepJson(STEP, { step_type: 2 })])
  assert.equal(unread.names.status, 'unknown', 'the step\'s name is its timing')
  assert.equal(browserFactsProblem(operation, 2, withSharedWith(unread), values), '「names」をサイトから読み取れていません')
  // The step must stand exactly once in this reminder's answer, name the reminder, and the reminder be shown.
  assert.equal(valueOf(await withSteps([stepJson('7002999')]), 'schedule'), 'unknown', 'step not in the list')
  assert.equal(valueOf(await withSteps([stepJson(STEP), stepJson(STEP)]), 'schedule'), 'unknown', 'step twice (same contents)')
  assert.equal(valueOf(await withSteps([stepJson(STEP), stepJson(STEP, { step_time: '10:00:00' })]), 'schedule'), 'unknown', 'step twice')
  assert.equal(valueOf(await withSteps([stepJson(STEP, { episode_id: 7001999 })]), 'schedule'), 'unknown', 'the step names another reminder')
  assert.equal(valueOf(await withSteps([stepJson(STEP, { id: String(STEP) + '0' })]), 'schedule'), 'unknown')
  assert.equal(valueOf(await withSteps([stepJson(STEP)], { id: 7001999 }), 'schedule'), 'unknown', 'another reminder\'s answer')
  assert.equal(valueOf(await withSteps([stepJson(STEP)], { hid_at: '2026-11-01 10:00:00' }), 'schedule'), 'unknown', 'a hidden reminder')
  const noHidAt = JSON.parse(episodeJson([stepJson(STEP)])) as Record<string, unknown>
  delete noHidAt.hid_at
  assert.equal(valueOf((await factsOf(site({ [SCHEDULE]: JSON.stringify(noHidAt) }))).facts, 'schedule'), 'unknown', 'hid_at must be there and null')
  assert.equal(valueOf(await withSteps(['x', stepJson(STEP)]), 'schedule'), 'unknown', 'a step that is not an object')
  assert.equal(valueOf(await withSteps([], { steps: { [STEP]: stepJson(STEP) } }), 'schedule'), 'unknown', 'steps not a list')
  // The answer failing, or not strict JSON (a key written twice: JSON.parse would keep the last copy).
  assert.equal(valueOf((await factsOf(site({ [SCHEDULE]: null }))).facts, 'schedule'), 'unknown')
  const repeated = episodeJson([stepJson(STEP, { step_type: 2 })]).replace('"step_type":2', '"step_type":2,"step_type":1')
  assert.equal(valueOf((await factsOf(site({ [SCHEDULE]: repeated }))).facts, 'schedule'), 'unknown')
  // The page's text plays no part any more: a timing-looking text in the box changes nothing.
  const pageText = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(box('<span>3日前 19:00</span>')) }))
  assert.deepEqual(valueOf(pageText.facts, 'schedule'), { timing: '当日 09:00' })
})

test('a page the core could not read whole (the real page repeats ids in every step\'s form, §39) keeps the account and the state, read by the run\'s own rules, and the timing and names, read from JSON', async () => {
  const twiceId = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(`${box('<input id="step_time" value="09:00"><input id="step_type" value="1">')}<div><input id="step_time" value="10:00"><input id="step_type" value="1"></div>`) }))
  assert.deepEqual(valueOf(twiceId.facts, 'schedule'), { timing: '当日 09:00' })
  assert.deepEqual(valueOf(twiceId.facts, 'names'), { reminder: '架空のリマインダ', step: '当日 09:00' })
  assert.deepEqual(valueOf(twiceId.facts, 'state'), { templates: [ON_STEP] })
  assert.deepEqual(valueOf(twiceId.facts, 'account'), { id: '5550001' })
})

test('no account, or no target on the page: unknown, and nothing beyond the page is read when the step is not there', async () => {
  const noAccount = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(box('<span>当日 09:00</span>'), '') }))
  assert.equal(noAccount.facts.account.status, 'unknown')
  assert.equal(browserFactsProblem(operation, 2, withSharedWith(noAccount.facts), values), '「account」をサイトから読み取れていません')
  const noStep = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage('<div id="templateStep7002999"></div>') }))
  assert.deepEqual(noStep.reads, [`/line/episode/show/${REMINDER}`])
  for (const name of ['step_parent', 'state', 'schedule', 'names', 'templates']) assert.equal(noStep.facts[name].status, 'unknown', name)
  // The reminder page failing: every fact unknown, from a failed answer.
  const failed = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: null }))
  assert.ok(Object.values(failed.facts).every(f => f.status === 'unknown'))
  // A reminder answer without a name, or a name that is not plain text (a bidirectional mark, a number): no names.
  const nameless = JSON.parse(episodeJson([stepJson(STEP)])) as Record<string, unknown>
  delete nameless.name
  const lost = await factsOf(site({ [SCHEDULE]: JSON.stringify(nameless) }))
  assert.equal(lost.facts.names.status, 'unknown')
  assert.deepEqual(valueOf(lost.facts, 'schedule'), { timing: '当日 09:00' })
  assert.equal((await factsOf(site({ [SCHEDULE]: episodeJson([stepJson(STEP)], { name: '架空\u202eのリマインダ' }) }))).facts.names.status, 'unknown')
  assert.equal((await factsOf(site({ [SCHEDULE]: episodeJson([stepJson(STEP)], { name: 7 }) }))).facts.names.status, 'unknown')
})

test('the core reads only declared reads with addresses it builds, at most BROWSER_FACT_READS, and only the facts version asked', async () => {
  // Many folders, the template in none: the scan stops at the cap with no facts.
  const many = Array.from({ length: 80 }, (_, i) => ({ id: 7300000 + i, name: `架空${i}`, order: i, item_count: 1 }))
  const pages: Record<string, string> = { ...site(), '/api/template-groups': JSON.stringify({ data: many }) }
  for (const f of many) pages[`/api/templates?group=${f.id}&page=1`] = pageOf([])
  const capped = input(pages)
  assert.deepEqual(await readBrowserFacts(capped.deps), { facts: null, problem: 'too-many-reads' })
  assert.equal(capped.reads.length, BROWSER_FACT_READS)
  // A checker asking for a read the declaration does not have, a page past `max`, or an id that is not plain: nothing read.
  const asking = (request: { read: string; values: Record<string, string>; page?: number }): BrowserChecker =>
    ({ ...checker, facts: { version: 2, next: () => [request], read: () => ({ facts: {} }) } })
  for (const [request, problem] of [
    [{ read: 'landing', values: { landing: '1' } }, 'undeclared-read'],
    [{ read: 'templates', values: { template_group: '7200001' }, page: 11 }, 'bad-address'],
    [{ read: 'reminder', values: { reminder: '1', page: '2' } }, 'bad-address'],
    [{ read: 'reminder', values: { reminder: '../x' } }, 'bad-address'],
    [{ read: 'reminder', values: { reminder: '1' }, page: 2 }, 'bad-address'],
  ] as const) {
    const h = input(site(), { checker: asking(request) })
    assert.deepEqual(await readBrowserFacts(h.deps), { facts: null, problem }, request.read)
    assert.deepEqual(h.reads, [])
  }
  // Whatever a checker says: a fact from a failed answer is never known, only declared facts are kept,
  // and asking again for a read already made reads nothing more.
  const careless: BrowserChecker = {
    ...checker,
    facts: {
      version: 2,
      next: () => [{ read: 'reminder', values: { reminder: REMINDER } }],
      read: () => ({ facts: { account: { status: 'known', value: { id: '1' }, from: 0, rawMarkup: true }, mood: { status: 'known', value: 'x', from: 0 } } }),
    },
  }
  const failing = input(site({ [`/line/episode/show/${REMINDER}`]: null }), { checker: careless })
  const out = await readBrowserFacts(failing.deps)
  assert.deepEqual(failing.reads, [`/line/episode/show/${REMINDER}`])
  assert.ok(out.facts)
  assert.equal(out.facts.account.status, 'unknown')
  assert.equal('mood' in out.facts, false)
  // `rawMarkup` counts only for the account, the parent and the state: another fact so marked, from a
  // page not read whole, stays unknown.
  const marking: BrowserChecker = {
    ...checker,
    facts: {
      version: 2,
      next: () => [{ read: 'reminder', values: { reminder: REMINDER } }],
      // It reads the page through the view (which finds the repeated id), then marks everything raw.
      read: (_values, answers) => ({ facts: {
        ...(answers[0].ok && answers[0].kind === 'html' ? (answers[0].view.find({}), {}) : {}),
        schedule: { status: 'known', value: { timing: '当日 09:00' }, complete: true, from: 0, rawMarkup: true },
        account: { status: 'known', value: { id: '1' }, from: 0, rawMarkup: true },
      } }),
    },
  }
  const notWhole = reminderPage(`${box('<span>当日 09:00</span>')}<p id="x">a</p><p id="x">b</p>`)
  const marked = await readBrowserFacts(input(site({ [`/line/episode/show/${REMINDER}`]: notWhole }), { checker: marking }).deps)
  assert.ok(marked.facts)
  assert.equal(marked.facts.schedule.status, 'unknown')
  assert.equal(marked.facts.account.status, 'known')
  // Another facts version than the plan's: nothing read.
  const v1 = input(site(), { factsVersion: 1 })
  assert.deepEqual(await readBrowserFacts(v1.deps), { facts: null, problem: 'facts-version' })
  assert.deepEqual(v1.reads, [])
  // A stop while reading ends with no facts.
  const stopped = input(site(), { read: async () => 'stop' })
  assert.deepEqual(await readBrowserFacts(stopped.deps), { facts: null, problem: 'stop' })
})

test('the re-read before the permit refuses any change: a template\'s body or name, the timing, another template on the step, the reminder\'s name; the count may fall, never rise, and unknown → known is a change', async () => {
  const approved = withSharedWith((await factsOf(site())).facts)
  const again = async (over: Record<string, string | null>) => withSharedWith((await factsOf(site(over))).facts)
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({}), values), null, 'the same site')
  // As the real site reads (shared_with unknown both times, optional): the same, and a plan.
  const plain = (await factsOf(site())).facts
  assert.equal(browserFactsChangedProblem(operation, 2, plain, (await factsOf(site())).facts, values), null)
  // unknown → known is still a change, for an optional fact too.
  assert.equal(browserFactsChangedProblem(operation, 2, plain, withSharedWith((await factsOf(site())).facts), values), '「shared_with」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002, { content_text: '変えた本文' })]) }), values),
    '「templates」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/templates?group=7200001&page=1': pageOf([template(ON_STEP, 7200001, { name: '変えた名前' })]) }), values),
    '「templates」が承認したときと変わりました')
  // The step's time moved (10:00 instead of 09:00): the timing changed (the names, which carry it, too).
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ [SCHEDULE]: episodeJson([stepJson(STEP, { step_time: '10:00:00' })]) }), values),
    '「names」が承認したときと変わりました')
  const moved = withSharedWith((await factsOf(site({ [SCHEDULE]: episodeJson([stepJson(STEP, { step_time: '10:00:00' })]) }))).facts)
  assert.equal(browserFactsChangedProblem(operation, 2, approved, { ...moved, names: approved.names }, values), '「schedule」が承認したときと変わりました')
  // The step's time now one the table does not map: the re-read cannot make a plan by itself.
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ [SCHEDULE]: episodeJson([stepJson(STEP, { step_days: 2 })]) }), values),
    '「names」をサイトから読み取れていません')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ [SCHEDULE]: episodeJson([stepJson('7002000', { order: 0, step_days: 1, step_time: '19:00:00' }), stepJson(STEP)], { name: '改名したリマインダ' }) }), values),
    '「names」が承認したときと変わりました')
  // Someone added the very template meanwhile: the state changed.
  const added = reminderPage(`<div id="templateStep${STEP}"><span>当日 09:00</span><a onclick="openModal(${REMINDER}, ${STEP}, 1, ${ON_STEP}, 8)">甲</a><a onclick="openModal(${REMINDER}, ${STEP}, 2, ${TO_ADD}, 8)">乙</a></div>`)
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ [`/line/episode/show/${REMINDER}`]: added }), values), '「state」が承認したときと変わりました')
  // A re-read that cannot make a plan by itself (the template gone) is refused before comparing.
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/templates?group=7200002&page=1': pageOf([]) }), values), '「templates」をサイトから読み取れていません')
  // The count (not read today: unknown both times = the same). Read later: unknown → known is a change; a rise is a change; a fall is not.
  const count = (facts: Record<string, BrowserFact>, n: number): Record<string, BrowserFact> => ({ ...facts, audience: { status: 'known', value: { count: n }, readAt: facts.audience.readAt, source: facts.audience.source } })
  const reread = await again({})
  assert.equal(browserFactsChangedProblem(operation, 2, approved, count(reread, 3), values), '「audience」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, count(approved, 3), count(reread, 4), values), '「audience」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, count(approved, 3), count(reread, 2), values), null)
})

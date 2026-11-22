/**
 * The facts read for a plan (6b-2b; agent-browser.md "The facts a checker reads"): the core's driver
 * (client/shared/browser-facts.ts) with the real Lステップ 0.6.0 connector against a fake Lステップ in the
 * real site's shapes (design memo §34–§36; every name and id made up), pages parsed by the real parser.
 * What is protected: facts come only from declared reads at addresses the core builds; what the site
 * shows is what the person approves (never a guess: unconfirmed facts are unknown and make no plan);
 * text-only templates; the step's timing exactly as shown; a page the core could not read whole gives no
 * view-read fact; the re-read refuses any change (6b-2 §5-2).
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
const browser = createBrowserConnectors([lstep.declaration])('lstep', '0.6.0')!
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
const reminderEntry = (id: number, group: number, name: string) => ({ id, name, order: 1, type: 1, created_at: 'x', group_id: group, group: { id: group, name: '架空', order: 1 } })

/** The fake site by exact address (anything else is a 404). */
function site(over: Record<string, string | null> = {}): Record<string, string> {
  const pages: Record<string, string | null> = {
    [`/line/episode/show/${REMINDER}`]: reminderPage(box('<span>3日前 09:00</span>')),
    '/api/episode-groups': JSON.stringify({ data: [{ id: 7100001, name: '架空の配信', order: 1, item_count: 1 }, { id: 7100002, name: '架空の試験', order: 2, item_count: 51 }] }),
    '/api/episodes?group=7100001&page=1': pageOf([reminderEntry(7009999, 7100001, '別のリマインダ')]),
    '/api/episodes?group=7100002&page=1': pageOf([reminderEntry(7009998, 7100002, '別のリマインダ二')], 1, 2, 2),
    '/api/episodes?group=7100002&page=2': pageOf([reminderEntry(Number(REMINDER), 7100002, '架空のリマインダ')], 2, 2, 2),
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
/** Stands in for the `shared_with` reader confirmed at the owner's next login (today always unknown). */
const withSharedWith = (facts: Record<string, BrowserFact>): Record<string, BrowserFact> =>
  ({ ...facts, shared_with: { status: 'known', value: { count: 1, items: ['架空の第1回'] }, complete: true, readAt: facts.shared_with.readAt, source: facts.shared_with.source } })

test('Lステップ 0.6.0 is scheduled with facts version 2 and passes the first version\'s rule: timing and templates required and read whole, the count optional', () => {
  assert.equal(operation.delivers, 'scheduled')
  assert.equal(checker.facts?.version, 2)
  assert.equal(browserFirstVersionProblem(operation), null)
  assert.deepEqual(operation.facts.audience, { required: false, complete: false })
})

test('the facts come from exactly the declared reads, scanning folders in order until each id is found; confirmed facts are known, unconfirmed ones unknown so no plan is made yet', async () => {
  const { facts, problem, reads } = await factsOf(site())
  assert.deepEqual(reads, [
    `/line/episode/show/${REMINDER}`,
    '/api/episode-groups', '/api/template-groups',
    '/api/episodes?group=7100001&page=1', '/api/templates?group=7200001&page=1',
    '/api/episodes?group=7100002&page=1', '/api/templates?group=7200002&page=1',
    '/api/episodes?group=7100002&page=2',
  ], '「未分類」 (0) is never asked; a folder\'s later page only when page 1 says there is one')
  assert.deepEqual(valueOf(facts, 'account'), { id: '5550001' })
  assert.deepEqual(valueOf(facts, 'step_parent'), { reminder: REMINDER })
  assert.deepEqual(valueOf(facts, 'state'), { templates: [ON_STEP] })
  assert.deepEqual(valueOf(facts, 'schedule'), { timing: '3日前 09:00' })
  assert.deepEqual(valueOf(facts, 'names'), { reminder: '架空のリマインダ', step: '3日前 09:00' })
  assert.deepEqual(valueOf(facts, 'templates'), {
    [ON_STEP]: { name: '架空テンプレ1', kind: 'text', body: '本文1\n2行目' },
    [TO_ADD]: { name: '架空テンプレ2', kind: 'text', body: '本文2\n2行目' },
  })
  assert.equal(facts.templates.complete, true)
  assert.equal(facts.schedule.complete, true)
  // Where each was read (a path, never the query) and when.
  assert.equal(facts.templates.source, '/api/templates')
  assert.equal(facts.account.source, `/line/episode/show/${REMINDER}`)
  assert.ok(Object.values(facts).every(f => !Number.isNaN(Date.parse(f.readAt))))
  // Not confirmed on the real site: unknown, never guessed — and shared_with is required, so no plan.
  assert.equal(facts.shared_with.status, 'unknown')
  assert.equal(facts.audience.status, 'unknown')
  assert.equal(problem, '「shared_with」をサイトから読み取れていません')
  // Once shared_with is read, the rest makes a plan, and the read-after expects the template added.
  assert.equal(browserFactsProblem(operation, 2, withSharedWith(facts), values), null)
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

test('the step\'s timing is taken only as one whole visible text in the step\'s box; otherwise unknown and no plan', async () => {
  const timing = async (inner: string) => valueOf((await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(box(inner)) }))).facts, 'schedule')
  assert.deepEqual(await timing('<span>当日 09:00</span>'), { timing: '当日 09:00' })
  assert.deepEqual(await timing('<span>12 日前 に送信</span>'), { timing: '12 日前 に送信' })
  assert.deepEqual(await timing('<div><span>当日 09:00</span></div>'), { timing: '当日 09:00' }, 'the same text at two levels is one timing')
  assert.equal(await timing(''), 'unknown')
  assert.equal(await timing('<span>当日 09:00</span><span>3日前 09:00</span>'), 'unknown', 'two timings')
  assert.equal(await timing('<span>当日 09:00 ごろ届きます</span>'), 'unknown', 'not a whole timing')
  assert.equal(await timing('<span hidden>当日 09:00</span>'), 'unknown', 'hidden')
  assert.equal(await timing('<span style="display:none">当日 09:00</span>'), 'unknown', 'hidden by style')
  // A template's name is never the timing: a slot named like a timing makes it unknown (in doubt, no
  // fact), also when it is the only timing-shaped text, wrapped, or a plain link.
  const slot = (name: string) => `<a onclick="openModal(${REMINDER}, ${STEP}, 2, ${TO_ADD}, 8)">${name}</a>`
  assert.equal(await timing(slot('当日 09:00')), 'unknown')
  assert.equal(await timing(`<span>3日前 09:00</span>${slot('当日 09:00')}`), 'unknown')
  assert.equal(await timing(`<div>${slot('当日 09:00')}</div>`), 'unknown')
  assert.equal(await timing(`<span onclick="openModal(${REMINDER}, ${STEP}, 2, ${TO_ADD}, 8)"><b>当日 09:00</b></span>`), 'unknown')
  assert.equal(await timing('<a href="#">当日 09:00</a>'), 'unknown')
  assert.equal(await timing('<button>当日 09:00</button>'), 'unknown')
  // An element holding a link is not the timing, even when its text together reads as one.
  assert.equal(await timing('<div>当日 <a href="#">09:00</a></div>'), 'unknown')
  // Next to a slot with another name, the timing is still read.
  assert.deepEqual(await timing(`<span>3日前 09:00</span>${slot('架空テンプレ乙')}`), { timing: '3日前 09:00' })
  // Outside the box (another step's or the page's) is not this step's.
  const outside = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(`<p>当日 09:00</p>${box('')}`) }))
  assert.equal(outside.facts.schedule.status, 'unknown')
  assert.equal(outside.facts.names.status, 'unknown', 'the step\'s name is its timing')
})

test('a page the core could not read whole gives no fact read through its view; the account and the state, read by the run\'s own rules, stay', async () => {
  const twiceId = await factsOf(site({ [`/line/episode/show/${REMINDER}`]: reminderPage(`${box('<span>当日 09:00</span>')}<p id="x">a</p><p id="x">b</p>`) }))
  assert.equal(twiceId.facts.schedule.status, 'unknown')
  assert.equal(twiceId.facts.names.status, 'unknown', 'the step\'s name is read through the view too')
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
  // A reminder found in no folder: no name.
  const lost = await factsOf(site({ '/api/episodes?group=7100002&page=2': pageOf([], 2, 2, 2) }))
  assert.equal(lost.facts.names.status, 'unknown')
  // A name that is not plain text (a bidirectional mark) is not read.
  const marked = await factsOf(site({ '/api/episodes?group=7100002&page=2': pageOf([reminderEntry(Number(REMINDER), 7100002, '架空\u202eのリマインダ')], 2, 2, 2) }))
  assert.equal(marked.facts.names.status, 'unknown')
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
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/templates?group=7200002&page=1': pageOf([template(TO_ADD, 7200002, { content_text: '変えた本文' })]) }), values),
    '「templates」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/templates?group=7200001&page=1': pageOf([template(ON_STEP, 7200001, { name: '変えた名前' })]) }), values),
    '「templates」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ [`/line/episode/show/${REMINDER}`]: reminderPage(box('<span>当日 09:00</span>')) }), values),
    '「names」が承認したときと変わりました')
  assert.equal(browserFactsChangedProblem(operation, 2, approved, await again({ '/api/episodes?group=7100002&page=2': pageOf([reminderEntry(Number(REMINDER), 7100002, '改名したリマインダ')], 2, 2, 2) }), values),
    '「names」が承認したときと変わりました')
  // Someone added the very template meanwhile: the state changed.
  const added = reminderPage(`<div id="templateStep${STEP}"><span>3日前 09:00</span><a onclick="openModal(${REMINDER}, ${STEP}, 1, ${ON_STEP}, 8)">甲</a><a onclick="openModal(${REMINDER}, ${STEP}, 2, ${TO_ADD}, 8)">乙</a></div>`)
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

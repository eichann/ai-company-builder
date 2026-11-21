/**
 * Paginated declared reads in the preview (electron/features/browser/preview.ts `readPages`;
 * agent-browser.md "The operator and the preview", design memo §38): the real Lステップ 0.5.0
 * connector against a fake Lステップ whose lists have 1, 3, 10 or 11 pages, every read going through
 * the real read-session chunk with its real `exactRead` hook (a fake page-less session that sends only
 * what the hook lets through). What is protected: the app — never the operator — chooses the page
 * numbers and reads them in order, each address exactly as built from the declaration; a list longer
 * than the declared 10 pages (or 500 items) offers nothing; a failed page, a page that is not the one
 * asked, a changed `last_page` / `total`, an id seen twice or a count other than `total` ends the list
 * incomplete; the operator sees one merged list that never names a page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrowserHtml } from '../electron/features/browser/html'
import { runBrowserPreview, type BrowserPreviewDeps, type BrowserPreviewRequest, type PreviewOperator } from '../electron/features/browser/preview'
import { createSessionLanes, exactRead, throughSession, type PagelessSession } from '../electron/features/browser/read-session'
import { createBrowserConnectors } from '../shared/browser-checkers'
import type { BrowserExploreReader, BrowserPreviewSurface, BrowserSessionRequest } from '../shared/browser-runner'
import { lstepConnector } from '../connectors/lstep'

const HOST = 'manager.linestep.net'
const lstep = lstepConnector()
const declared = createBrowserConnectors([lstep.declaration])
const FOLDER = 29529

const folders = JSON.stringify({ data: [{ id: FOLDER, name: '大きなフォルダ', order: 1, item_count: 999 }] })
const entry = (id: number) => ({ id, name: `リマインダ${id}`, order: 1, type: 1, created_at: 'x', group_id: FOLDER, group: { id: FOLDER, name: '大きなフォルダ', order: 1 } })
/** One page of a list as the real site answers it (design memo §36): 50 a page unless `ids` says otherwise. */
const listPage = (o: { current: number; last: number; total: number; ids: number[] }) => JSON.stringify({
  current_page: o.current, data: o.ids.map(entry), first_page_url: 'x', from: 1, last_page: o.last, last_page_url: 'x', links: [],
  next_page_url: null, path: 'x', per_page: 50, prev_page_url: null, to: o.ids.length, total: o.total,
})
const idsOf = (page: number, per = 50) => Array.from({ length: per }, (_, i) => 1_000_000 + (page - 1) * per + i)
const pageAddress = (n: number) => `/api/episodes?group=${FOLDER}&page=${n}`
/** A whole list of `pages` pages of `per` each: address → answer. */
function list(pages: number, per = 50): Record<string, string> {
  const out: Record<string, string> = { '/api/episode-groups': folders }
  for (let n = 1; n <= pages; n++) out[pageAddress(n)] = listPage({ current: n, last: pages, total: pages * per, ids: idsOf(n, per) })
  return out
}

const read = (name: string, values: Record<string, string> = {}) => JSON.stringify({ do: 'read', read: name, values })
const STOP = JSON.stringify({ do: 'stop', why: 'need-person', question: '' })
const candidateWith = (reminder: string) => JSON.stringify({ do: 'candidate', target: { reminder, step: '1' }, change: { template: '1' }, explanation: 'x' })

/**
 * The preview with the fake site behind the real session chunk: `sent` is every URL the session's
 * request hook (`exactRead`) let through to the site, in order.
 */
function harness(site: Record<string, string | ((n: number) => string)>, answers: string[], o: { deps?: Partial<BrowserPreviewDeps>; onRead?: (address: string) => void } = {}) {
  const sent: string[] = []
  const refusedByHook: string[] = []
  const materials: unknown[] = []
  const queue = [...answers]
  let allow: ((r: BrowserSessionRequest) => boolean) | null = null
  const session: PagelessSession = {
    async wipe() { /* nothing kept */ },
    async guard(a) { allow = a },
    async copyCookies() { /* no login to copy */ },
    async send(r) {
      const request = { method: r.method, url: r.url, body: r.body }
      if (!allow || !allow(request)) { refusedByHook.push(r.url); throw new Error('blocked by the request hook') }
      sent.push(r.url)
      const answer = site[r.url.slice(`https://${HOST}`.length)]
      return answer === undefined ? { status: 404, body: '' } : { status: 200, body: typeof answer === 'function' ? answer(sent.length) : answer }
    },
  }
  const lanes = createSessionLanes()
  const surface: BrowserPreviewSurface = {
    read(address, signal) {
      o.onRead?.(address)
      const url = `https://${HOST}${address}`
      return throughSession(lanes, 'p-read', session, { method: 'GET', url }, exactRead(url), signal)
    },
    closed: () => false,
  }
  const operator: PreviewOperator = {
    model: 'm',
    async resolve() { return { ok: true, cli: { path: '/real/claude', pathDirs: ['/real'] } } },
    async step(job) {
      materials.push(job.material)
      return { ok: true, text: queue.shift() ?? STOP }
    },
  }
  const deps: BrowserPreviewDeps = {
    aiSwitch: () => true,
    connector: declared,
    reader: id => lstep.readers.find(r => r.id === id),
    site: () => ({ host: HOST, level: 'write', assetHosts: ['d1nhtjid4lgi9y.cloudfront.net', 'profile.line-scdn.net'] }),
    stopped: () => false,
    window: () => surface,
    operator: () => operator,
    cliPath: () => '/usr/local/bin/claude',
    parentEnv: () => ({}),
    parse: parseBrowserHtml,
    stillCurrent: () => true,
    now: () => 1_000_000,
    ...o.deps,
  }
  const request: BrowserPreviewRequest = {
    companyId: 'c1', connector: { id: 'lstep', version: '0.5.0' }, operation: 'reminder_step_add_template',
    hints: { targetHints: { reminder: 'リマインダ' }, changeHints: { template: 'テンプレ' }, reason: '試験' }, signal: new AbortController().signal,
  }
  /** The reminders as the operator got them on the step after the list was read. */
  const remindersSeen = () => {
    const material = materials.at(-1) as { pages: Array<{ read: string; values: Record<string, string>; items: Array<{ field: string; value: string }>; complete: boolean }> }
    const page = material.pages.find(p => p.read === 'reminders')!
    return { values: page.values, ids: page.items.map(i => i.value), complete: page.complete }
  }
  const sentPaths = () => sent.map(u => u.slice(`https://${HOST}`.length))
  return { deps, request, sent, sentPaths, refusedByHook, materials, remindersSeen }
}

const walk = [read('reminder_folders'), read('reminders', { group: String(FOLDER) })]
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

test('a list of one page: exactly page=1 is read, and it is whole', async () => {
  const h = harness(list(1), walk)
  assert.deepEqual(await runBrowserPreview(h.request, h.deps), { outcome: 'stopped', why: 'need-person', question: '' })
  assert.deepEqual(h.sentPaths(), ['/api/episode-groups', pageAddress(1)])
  const seen = h.remindersSeen()
  assert.equal(seen.ids.length, 50)
  assert.equal(seen.complete, true)
})

test('a list of 3 pages: the app reads page=1, 2, 3 in order, each through exactRead byte for byte; the operator sees one merged list that names no page', async () => {
  const h = harness(list(3), walk)
  await runBrowserPreview(h.request, h.deps)
  assert.deepEqual(h.sent, ['/api/episode-groups', ...range(1, 3).map(pageAddress)].map(p => `https://${HOST}${p}`))
  assert.deepEqual(h.sentPaths().slice(1), ['/api/episodes?group=29529&page=1', '/api/episodes?group=29529&page=2', '/api/episodes?group=29529&page=3'])
  assert.deepEqual(h.refusedByHook, [])
  const seen = h.remindersSeen()
  assert.deepEqual(seen.ids, [...idsOf(1), ...idsOf(2), ...idsOf(3)].map(String))
  assert.equal(seen.complete, true)
  // One read, as the operator asked it: no page in its values, in the material's reads or in its pages.
  assert.deepEqual(seen.values, { group: String(FOLDER) })
  const material = JSON.stringify(h.materials.at(-1))
  for (const word of ['page', 'last_page', 'current_page', 'total']) assert.equal(material.includes(`"${word}"`), false, word)
  assert.equal((h.materials.at(-1) as { pages: unknown[] }).pages.length, 2)
})

test('a list of 10 pages (500 items) is read whole; one of 11 pages is read no further than page 1 and nothing of it is offered', async () => {
  const ten = harness(list(10), walk)
  await runBrowserPreview(ten.request, ten.deps)
  assert.deepEqual(ten.sentPaths().slice(1), range(1, 10).map(pageAddress))
  assert.equal(ten.remindersSeen().ids.length, 500)
  assert.equal(ten.remindersSeen().complete, true)

  const eleven = harness(list(11), [...walk, candidateWith(String(idsOf(1)[0]))])
  // An id of page 1 is not offered: the candidate naming it is refused.
  assert.deepEqual(await runBrowserPreview(eleven.request, eleven.deps), { outcome: 'failed', reason: 'bad-answer' })
  assert.deepEqual(eleven.sentPaths(), ['/api/episode-groups', pageAddress(1)])
  assert.deepEqual(eleven.remindersSeen(), { values: { group: String(FOLDER) }, ids: [], complete: false })
})

test('more than 500 items over pages within the limit: nothing of the list is offered', async () => {
  // 9 pages of 60 (540): within 10 pages, over the item cap.
  const h = harness(list(9, 60), walk)
  await runBrowserPreview(h.request, h.deps)
  assert.deepEqual(h.remindersSeen().ids, [])
  assert.equal(h.remindersSeen().complete, false)
})

test('a last_page or total that changes between pages ends the list there, incomplete, with the pages before', async () => {
  for (const changed of [{ last: 4, total: 150 }, { last: 3, total: 151 }]) {
    const site = list(3)
    site[pageAddress(2)] = listPage({ current: 2, ...changed, ids: idsOf(2) })
    const h = harness(site, walk)
    await runBrowserPreview(h.request, h.deps)
    assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1), pageAddress(2)], JSON.stringify(changed))
    assert.deepEqual(h.remindersSeen().ids, idsOf(1).map(String))
    assert.equal(h.remindersSeen().complete, false)
  }
})

test('a page that is not the one asked (its current_page) ends the list, its items left out', async () => {
  const site = list(3)
  site[pageAddress(2)] = listPage({ current: 1, last: 3, total: 150, ids: idsOf(2) })
  const h = harness(site, walk)
  await runBrowserPreview(h.request, h.deps)
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1), pageAddress(2)])
  assert.deepEqual(h.remindersSeen().ids, idsOf(1).map(String))
  assert.equal(h.remindersSeen().complete, false)
})

test('an id seen on an earlier page (the list moved while read) ends the list, that page left out', async () => {
  const site = list(3)
  site[pageAddress(2)] = listPage({ current: 2, last: 3, total: 150, ids: [idsOf(1)[49], ...idsOf(2).slice(1)] })
  const h = harness(site, walk)
  await runBrowserPreview(h.request, h.deps)
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1), pageAddress(2)])
  assert.deepEqual(h.remindersSeen().ids, idsOf(1).map(String))
  assert.equal(h.remindersSeen().complete, false)
})

test('a failing page 2 ends the list incomplete with page 1, and the request goes on; page 1 failing is the read failing', async () => {
  const site = list(3)
  delete site[pageAddress(2)]
  const h = harness(site, walk)
  assert.deepEqual(await runBrowserPreview(h.request, h.deps), { outcome: 'stopped', why: 'need-person', question: '' })
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1), pageAddress(2)])
  assert.deepEqual(h.remindersSeen().ids, idsOf(1).map(String))
  assert.equal(h.remindersSeen().complete, false)

  const first = list(3)
  delete first[pageAddress(1)]
  const f = harness(first, walk)
  assert.deepEqual(await runBrowserPreview(f.request, f.deps), { outcome: 'failed', reason: 'read-failed' })
  assert.deepEqual(f.sentPaths().slice(1), [pageAddress(1)])
})

test('all pages whole but fewer items than the reported total: incomplete', async () => {
  const site = list(2)
  for (const n of [1, 2]) site[pageAddress(n)] = listPage({ current: n, last: 2, total: 101, ids: idsOf(n) })
  const h = harness(site, walk)
  await runBrowserPreview(h.request, h.deps)
  assert.equal(h.remindersSeen().ids.length, 100)
  assert.equal(h.remindersSeen().complete, false)
})

test('page 1 not saying where it stands: nothing of the list is offered and no other page is read', async () => {
  const site = list(3)
  site[pageAddress(1)] = JSON.stringify({ data: idsOf(1).map(entry) })
  const h = harness(site, walk)
  await runBrowserPreview(h.request, h.deps)
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1)])
  assert.deepEqual(h.remindersSeen(), { values: { group: String(FOLDER) }, ids: [], complete: false })
})

test('page numbers never come from the operator: a page in its values is refused with nothing read, and asking again reads from page 1', async () => {
  for (const values of [{ group: String(FOLDER), page: '2' }, { group: String(FOLDER), page: '1' }, { group: `${FOLDER}&page=2` }]) {
    const h = harness(list(3), [read('reminder_folders'), read('reminders', values)])
    assert.deepEqual(await runBrowserPreview(h.request, h.deps), { outcome: 'failed', reason: 'bad-answer' }, JSON.stringify(values))
    assert.deepEqual(h.sentPaths(), ['/api/episode-groups'])
  }
  const again = harness(list(2), [...walk, read('reminders', { group: String(FOLDER) })])
  await runBrowserPreview(again.request, again.deps)
  assert.deepEqual(again.sentPaths().slice(1), [pageAddress(1), pageAddress(2), pageAddress(1), pageAddress(2)])
  // The operator's view of the type's reads names only the folder.
  const reads = (again.materials[0] as { type: { reads: Array<{ name: string; needs: string[] }> } }).type.reads
  assert.deepEqual(reads.find(r => r.name === 'reminders')!.needs, ['group'])
})

test('later pages stay within the request\'s 4 minutes: time running out between pages ends the request', async () => {
  const clock = { now: 1_000_000 }
  const h = harness(list(3), walk, {
    deps: { now: () => clock.now },
    onRead: address => { if (address === pageAddress(1)) clock.now += 4 * 60_000 },
  })
  assert.deepEqual(await runBrowserPreview(h.request, h.deps), { outcome: 'failed', reason: 'timeout' })
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1)])
})

test('a read declared without pages (0.4.0\'s fixed page=1) is whole only as its only page, whatever its reader says of its own entries', async () => {
  const old = lstep.declaration.replace('version: 0.5.0', 'version: 0.4.9')
    .replace('        - { name: group, value: "{group}" }\n      pages: { param: page, max: 10 }', '        - { name: group, value: "{group}" }\n        - { name: page, value: "1" }')
  const h = harness(list(2), walk, { deps: { connector: createBrowserConnectors([old]) } })
  await runBrowserPreview({ ...h.request, connector: { id: 'lstep', version: '0.4.9' } }, h.deps)
  assert.deepEqual(h.sentPaths().slice(1), [pageAddress(1)])
  assert.equal(h.remindersSeen().ids.length, 50)
  assert.equal(h.remindersSeen().complete, false)
})

test('a paginated read whose reader is not a JSON one (it cannot say where a page stands): the type is not previewed, nothing read or started', async () => {
  const pageReader: BrowserExploreReader = { id: 'lstep.reminders', fields: ['reminder'], extra: [], read: () => ({ items: [], complete: true }) }
  let started = 0
  const h = harness(list(1), walk, {
    deps: { reader: id => (id === 'lstep.reminders' ? pageReader : lstep.readers.find(r => r.id === id)) },
  })
  const op = h.deps.operator()!
  h.deps.operator = () => ({ ...op, resolve: async (...a) => { started++; return op.resolve(...a) } })
  assert.deepEqual(await runBrowserPreview(h.request, h.deps), { outcome: 'refused', reason: 'connector' })
  assert.deepEqual(h.sent, [])
  assert.equal(started, 0)
})

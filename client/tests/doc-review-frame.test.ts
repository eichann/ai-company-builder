/**
 * Reviewing an HTML document in its own view (doc-frame.md "Review in the document view"): what the
 * view hands back is untrusted (the document controls its DOM and selection), so only the checked
 * selection shape reaches the window, only for the view's own window, only while reviewing and only
 * after the member's real input; only quoted text goes into the view; marks come back after a load.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocViews, SELECTION_READ_LIMIT_MS, type DocViewHandle, type DocViewHooks, type DocViewPort } from '../electron/features/doc-frames/views'
import { registerDocViewsIpc } from '../electron/features/doc-frames/ipc'
import { READ_SELECTION_CODE } from '../electron/features/doc-frames/review-world'
import {
  DOC_REVIEW_CONTEXT_MAX, DOC_REVIEW_QUOTE_MAX, DOC_REVIEW_QUOTES_MAX, DOC_REVIEW_RAW_MAX,
  docQuoteFoundOf, docReviewSelectionOf, docViewReviewOf,
} from '../shared/doc-review-frame'
import type { DocViewEvent } from '../shared/doc-frame'
import type { OpenableDocument } from '../electron/features/doc-frames/protocol'

const MAIN = 1

test('a selection from the view is taken only in its exact shape, cut to size, with unseen characters dropped', () => {
  assert.deepEqual(docReviewSelectionOf({ text: '  前年同月比\n 112% ', prefix: 'の売上は 2,340 万円で、', suffix: ' でした。' }), { text: '前年同月比 112%', prefix: 'の売上は 2,340 万円で、', suffix: ' でした。' })
  for (const bad of [null, 'text', [], { text: 'a', prefix: '' }, { text: 'a', prefix: '', suffix: '', extra: 1 }, { text: 1, prefix: '', suffix: '' },
    { text: '   ', prefix: '', suffix: '' }, { text: 'x'.repeat(DOC_REVIEW_RAW_MAX + 1), prefix: '', suffix: '' }, { text: 'a', prefix: 'x'.repeat(DOC_REVIEW_RAW_MAX + 1), suffix: '' }]) {
    assert.equal(docReviewSelectionOf(bad), null, JSON.stringify(bad)?.slice(0, 60))
  }
  const long = docReviewSelectionOf({ text: 'あ'.repeat(DOC_REVIEW_RAW_MAX), prefix: 'p'.repeat(200), suffix: 's'.repeat(200) })!
  assert.equal(long.text.length, DOC_REVIEW_QUOTE_MAX)
  assert.equal(long.prefix, 'p'.repeat(DOC_REVIEW_CONTEXT_MAX), 'the end of the text before')
  assert.equal(long.suffix, 's'.repeat(DOC_REVIEW_CONTEXT_MAX), 'the start of the text after')
  // A page could reverse how a quote reads (bidi overrides) or hide characters or words in it.
  const hidden = '支\u202E払\u200Bい\u200D先\uFEFF\u2060\u{E0041}\u{E007F}\u0007'
  assert.equal(docReviewSelectionOf({ text: hidden, prefix: '', suffix: '' })!.text, '支払い先')
})

test('what the window asks the view to draw is checked quote by quote: a bad one is dropped alone, each keeps its index, a cap', () => {
  assert.deepEqual(docViewReviewOf({ selecting: true, quotes: [{ text: ' a\nb ', nth: 2, resolved: false }] }), { selecting: true, quotes: [{ text: 'a b', nth: 2, resolved: false, index: 0 }] })
  for (const bad of [null, { selecting: 'yes', quotes: [] }, { selecting: true }, { selecting: true, quotes: 'a' }]) assert.equal(docViewReviewOf(bad), null)
  const mixed = docViewReviewOf({ selecting: false, quotes: [
    { text: 'a', nth: -1, resolved: false }, { text: 'ok', nth: 0, resolved: true }, { text: 'a', nth: 1.5, resolved: false },
    { text: ' ', nth: 0, resolved: false }, { text: 'b', nth: 0, resolved: 'no' }, { text: 'last', nth: 3, resolved: false, body: 'not ours' },
  ] })!
  assert.equal(mixed.selecting, false)
  assert.deepEqual(mixed.quotes, [{ text: 'ok', nth: 0, resolved: true, index: 1 }, { text: 'last', nth: 3, resolved: false, index: 5 }])
  const many = docViewReviewOf({ selecting: true, quotes: Array.from({ length: DOC_REVIEW_QUOTES_MAX + 10 }, () => ({ text: 'a', nth: 0, resolved: false })) })!
  assert.equal(many.quotes.length, DOC_REVIEW_QUOTES_MAX)
  assert.equal(docQuoteFoundOf('shown'), 'shown')
  assert.equal(docQuoteFoundOf({ toString: () => 'shown' }), 'missing', 'anything else from the page is "not there"')
})

/** A fake shell whose views answer the review piece with `answer` (what a page could make it say). */
function fakeShell() {
  let next = 100
  const hooksOf = new Map<number, DocViewHooks>()
  const codes: Array<[number, string]> = []
  const released: number[] = []
  const answer: { value: unknown } = { value: null }
  const port: DocViewPort = {
    onWindowReset: () => {},
    watch: () => {},
    async create(_windowId, hooks): Promise<DocViewHandle> {
      const id = next++
      hooksOf.set(id, hooks)
      return {
        id, show: () => {}, destroy: () => hooksOf.get(id)?.onGone(id), closeKeepingPlace: async () => null,
        place: () => {}, zoom: () => {}, reload: () => {},
        inReviewWorld: async code => { codes.push([id, code]); return code === READ_SELECTION_CODE ? answer.value : 0 },
        releaseKeyboard: () => { released.push(id) },
      }
    },
  }
  return { port, codes, released, answer, hooks: (id: number) => hooksOf.get(id)! }
}

async function setUp() {
  const shell = fakeShell()
  const events: Array<[number, DocViewEvent]> = []
  const views = createDocViews({
    frames: { grant: () => 'acb-doc://0123456789abcdef0123456789abcdef/a.html', revoke: () => {} },
    shell: shell.port,
    notify: (windowId, event) => { events.push([windowId, event]) },
    // At once, but for the read's time limit (a test of its own).
    later: (fn, ms) => { if (ms !== SELECTION_READ_LIMIT_MS) fn(); return () => {} },
  })
  const id = (await views.open({} as OpenableDocument, views.begin(MAIN)))!
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { shell, events, views, id, settle }
}

const selections = (events: Array<[number, DocViewEvent]>) => events.filter(([, e]) => e.kind === 'selection')

test('a selection reaches only the view\'s own window, only while reviewing, only after the member\'s input, only in shape', async () => {
  const { shell, events, views, id, settle } = await setUp()
  shell.answer.value = { text: '前年同月比 112%', prefix: 'で、', suffix: ' でした' }
  // Not reviewing: the member's input reads nothing.
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.equal(shell.codes.length, 0, 'no review, no call into the page')
  // Another window cannot turn reporting on for this view.
  views.review(id, MAIN + 1, { selecting: true, quotes: [] })
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.deepEqual(selections(events), [])
  views.review(id, MAIN, { selecting: true, quotes: [] })
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.deepEqual(selections(events), [[MAIN, { viewId: id, kind: 'selection', quote: { text: '前年同月比 112%', prefix: 'で、', suffix: ' でした' } }]])
  assert.deepEqual(shell.released, [id], 'the comment box gets the keyboard')
  // A page that answers something else (a bigger object, a function's result) gets nothing through.
  shell.answer.value = { text: 'x', prefix: '', suffix: '', body: 'not ours' }
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.equal(selections(events).length, 1)
  // Reviewing only to look (a completed review): marks, no selections.
  shell.answer.value = { text: 'y', prefix: '', suffix: '' }
  views.review(id, MAIN, { selecting: false, quotes: [] })
  const readsBefore = shell.codes.filter(([, code]) => code === READ_SELECTION_CODE).length
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.equal(selections(events).length, 1)
  assert.equal(shell.codes.filter(([, code]) => code === READ_SELECTION_CODE).length, readsBefore, 'the page is not even asked')
})

test('a review ended between the member\'s input and the read hands nothing over', async () => {
  const shell = fakeShell()
  const events: Array<[number, DocViewEvent]> = []
  const queued: Array<() => void> = []
  const views = createDocViews({
    frames: { grant: () => 'acb-doc://0123456789abcdef0123456789abcdef/a.html', revoke: () => {} },
    shell: shell.port,
    notify: (windowId, event) => { events.push([windowId, event]) },
    later: fn => { queued.push(fn); return () => {} },
  })
  const id = (await views.open({} as OpenableDocument, views.begin(MAIN)))!
  shell.answer.value = { text: '前年同月比 112%', prefix: '', suffix: '' }
  views.review(id, MAIN, { selecting: true, quotes: [] })
  shell.hooks(id).onReviewInput(id)
  views.review(id, MAIN, null)
  for (const fn of queued.splice(0)) fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(selections(events), [])
})

test('only quoted text goes into the view; the marks are drawn again when its page loads; none after the review ends', async () => {
  const { shell, views, id, settle } = await setUp()
  views.review(id, MAIN, { selecting: true, quotes: [{ text: '新規のお客さまは 18 社', nth: 0, resolved: false, body: '秘密のコメント' }] })
  await settle()
  const drawn = shell.codes.filter(([, code]) => code.includes('CSS.highlights.set'))
  assert.equal(drawn.length, 1)
  assert.match(drawn[0][1], /新規のお客さまは 18 社/)
  assert.doesNotMatch(drawn[0][1], /秘密のコメント/, 'nothing but the checked quotes is put into the page')
  shell.hooks(id).onPageLoaded(id)
  await settle()
  assert.equal(shell.codes.filter(([, code]) => code.includes('新規のお客さまは')).length, 2, 'a reload draws them again')
  views.review(id, MAIN, null)
  shell.hooks(id).onPageLoaded(id)
  await settle()
  assert.equal(shell.codes.filter(([, code]) => code.includes('新規のお客さまは')).length, 2, 'no marks once the review is closed')
})

test('docView:review and docView:findQuote are the main window\'s page\'s only, and find only a mark it set', async () => {
  const { shell, views, id } = await setUp()
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) }, on: () => {} }
  registerDocViewsIpc(ipc as never, { frames: { check: async () => ({ ok: false }) } as never, views, fromMainWindow: ((event: { main: boolean }) => event.main) as never })
  const ev = (main: boolean) => ({ main, sender: { id: MAIN } })
  const review = { selecting: true, quotes: [{ text: '目標は 2,600 万円', nth: 0, resolved: false }] }
  await handlers.get('docView:review')!(ev(false), id, review)
  assert.equal(shell.codes.length, 0, 'a frame inside the page or another window sets nothing')
  assert.equal(await handlers.get('docView:findQuote')!(ev(true), id, 0), 'missing', 'no mark set yet')
  await handlers.get('docView:review')!(ev(true), id, review)
  assert.equal(await handlers.get('docView:findQuote')!(ev(false), id, 0), 'missing')
  assert.equal(await handlers.get('docView:findQuote')!(ev(true), id, 1), 'missing', 'only an index of the marks set')
  assert.equal(await handlers.get('docView:findQuote')!(ev(true), id, 0), 'missing', 'the fake page answers 0: anything but shown / hidden is "not there"')
  assert.ok(shell.codes.some(([, code]) => code.includes("return 'shown'") && code.includes('目標は 2,600 万円')))
})

test('another page of the folder in the view (a link, the page\'s script): the review pauses — no selection, no marks — and resumes on the reviewed document', async () => {
  const { shell, events, views, id, settle } = await setUp()
  const OWN = 'acb-doc://0123456789abcdef0123456789abcdef/a.html'
  const OTHER = 'acb-doc://0123456789abcdef0123456789abcdef/b.html'
  shell.answer.value = { text: 'B の言葉', prefix: '', suffix: '' }
  views.review(id, MAIN, { selecting: true, quotes: [{ text: 'A の言葉', nth: 0, resolved: false }] })
  shell.hooks(id).onPageStart(id, OWN)
  assert.deepEqual(events.filter(([, e]) => e.kind === 'page'), [], 'its own page tells nothing')
  shell.hooks(id).onPageStart(id, OTHER)
  assert.deepEqual(events.filter(([, e]) => e.kind === 'page'), [[MAIN, { viewId: id, kind: 'page', own: false }]])
  const drawnBefore = shell.codes.filter(([, code]) => code.includes('A の言葉')).length
  shell.hooks(id).onPageLoaded(id)
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.equal(shell.codes.filter(([, code]) => code.includes('A の言葉')).length, drawnBefore, 'A\'s marks are not drawn into B')
  assert.equal(shell.codes.filter(([, code]) => code === READ_SELECTION_CODE).length, 0, 'B\'s selection is not read')
  assert.deepEqual(selections(events), [])
  assert.equal(await views.findQuote(id, MAIN, 0), 'missing')
  // Back on the reviewed document (with a fragment or query, the same page).
  shell.hooks(id).onPageStart(id, `${OWN}?v=2#top`)
  assert.deepEqual(events.filter(([, e]) => e.kind === 'page').at(-1), [MAIN, { viewId: id, kind: 'page', own: true }])
  shell.hooks(id).onPageLoaded(id)
  assert.equal(shell.codes.filter(([, code]) => code.includes('A の言葉')).length, drawnBefore + 1)
  shell.hooks(id).onReviewInput(id)
  await settle()
  assert.equal(selections(events).length, 1)
})

test('a selection read on a page that went away meanwhile hands nothing over', async () => {
  const shell = fakeShell()
  const events: Array<[number, DocViewEvent]> = []
  const queued: Array<() => void> = []
  const views = createDocViews({
    frames: { grant: () => 'acb-doc://0123456789abcdef0123456789abcdef/a.html', revoke: () => {} },
    shell: shell.port,
    notify: (windowId, event) => { events.push([windowId, event]) },
    later: (fn, ms) => { if (ms !== SELECTION_READ_LIMIT_MS) queued.push(fn); return () => {} },
  })
  const id = (await views.open({} as OpenableDocument, views.begin(MAIN)))!
  shell.answer.value = { text: '前年同月比 112%', prefix: '', suffix: '' }
  views.review(id, MAIN, { selecting: true, quotes: [] })
  shell.hooks(id).onReviewInput(id)
  // The page reloads (even its own) before the read: what is selected then is not what the member released on.
  shell.hooks(id).onPageStart(id, 'acb-doc://0123456789abcdef0123456789abcdef/a.html')
  for (const fn of queued.splice(0)) fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(selections(events), [])
})

test('a page that never answers a selection read does not stop the next one (time limit)', async () => {
  const shell = fakeShell()
  const events: Array<[number, DocViewEvent]> = []
  const limits: Array<() => void> = []
  const views = createDocViews({
    frames: { grant: () => 'acb-doc://0123456789abcdef0123456789abcdef/a.html', revoke: () => {} },
    shell: shell.port,
    notify: (windowId, event) => { events.push([windowId, event]) },
    later: (fn, ms) => { if (ms === SELECTION_READ_LIMIT_MS) limits.push(fn); else fn(); return () => {} },
  })
  const id = (await views.open({} as OpenableDocument, views.begin(MAIN)))!
  views.review(id, MAIN, { selecting: true, quotes: [] })
  let answer: (value: unknown) => void = () => {}
  shell.answer.value = new Promise(resolve => { answer = resolve })
  shell.hooks(id).onReviewInput(id)
  await new Promise(resolve => setImmediate(resolve))
  shell.hooks(id).onReviewInput(id)
  assert.equal(shell.codes.filter(([, code]) => code === READ_SELECTION_CODE).length, 1, 'one read at a time')
  for (const fn of limits.splice(0)) fn()
  shell.answer.value = { text: '次の選択', prefix: '', suffix: '' }
  shell.hooks(id).onReviewInput(id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(shell.codes.filter(([, code]) => code === READ_SELECTION_CODE).length, 2, 'read again after the limit')
  answer({ text: '遅い答え', prefix: '', suffix: '' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(selections(events).map(([, e]) => (e as { quote: { text: string } }).quote.text), ['次の選択'], 'the late answer is dropped')
})

test('findQuote names the window\'s own comment even when a bad quote before it was dropped', async () => {
  const { shell, views, id } = await setUp()
  views.review(id, MAIN, { selecting: false, quotes: [{ text: ' ', nth: 0, resolved: false }, { text: '二つ目', nth: 0, resolved: false }] })
  await views.findQuote(id, MAIN, 1)
  assert.ok(shell.codes.some(([, code]) => code.includes("return 'shown'") && code.includes('二つ目')))
  assert.equal(await views.findQuote(id, MAIN, 0), 'missing', 'the dropped one finds nothing')
})

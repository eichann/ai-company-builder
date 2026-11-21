/**
 * The preview's page reading (agent-browser.md "The operator and the preview", design memo §33 2-3):
 * parse5's tree (electron/features/browser/html.ts), the view a site's reader gets and what is kept of
 * its items (client/shared/browser-page.ts), and Lステップ's reader of a reminder's page
 * (connectors/lstep/reminder-steps-reader.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrowserHtml } from '../electron/features/browser/html'
import { cleanLabel, runExploreReader } from '../shared/browser-page'
import type { BrowserExploreReader } from '../shared/browser-runner'
import { lstepConnector } from '../connectors/lstep'
import { createBrowserConnectors } from '../shared/browser-checkers'

/** A reader that takes every `data-ref` attribute of the region `#list` as a `ref` item, its text as the label. */
const refs: BrowserExploreReader = {
  id: 'test.refs',
  fields: ['ref'],
  extra: ['note'],
  read(_values, page) {
    const region = page.one({ id: 'list' })
    if (!region) return { items: [], complete: false }
    return {
      items: region.find({ hasAttribute: 'data-ref' }).map(el => ({ field: 'ref', value: el.attr('data-ref') ?? '', label: el.text() })),
      complete: true,
    }
  },
}
const read = (html: string, reader: BrowserExploreReader = refs, values: Record<string, string> = {}) => runExploreReader(reader, values, parseBrowserHtml(html))
const values = (r: ReturnType<typeof read>) => r.items.map(i => i.value)

test('only what a person could see: hidden, aria-hidden, template, noscript, script, style and inline display:none / visibility:hidden are skipped', () => {
  const page = `<div id="list">
    <p data-ref="1">見える</p>
    <p hidden data-ref="2">hidden</p>
    <div aria-hidden="true"><p data-ref="3">aria</p></div>
    <p aria-hidden=" TRUE " data-ref="3b">aria upper</p>
    <template><p data-ref="4">template</p></template>
    <noscript><p data-ref="5">noscript</p></noscript>
    <script>document.write('<p data-ref="6">')</script>
    <style>p[data-ref="7"] {}</style>
    <div style="color:red; display: none"><p data-ref="8">display none</p></div>
    <p style="visibility:hidden !important" data-ref="9">visibility</p>
    <p aria-hidden="false" data-ref="10">aria false is shown</p>
  </div>`
  const r = read(page)
  assert.deepEqual(values(r), ['1', '10'])
  assert.equal(r.complete, true)
  // The label is the visible text only (a noscript's, script's or style's text included).
  assert.equal(read('<div id="list"><p data-ref="1">名前<span hidden>偽の名前</span><noscript>偽</noscript><script>s</script><style>t</style><template>u</template></p></div>').items[0].label, '名前')
})

test('an id used twice anywhere (a hidden copy too) or an attribute written twice makes that element unreadable and the read incomplete', () => {
  // Two regions with one id: none is read.
  const twice = read('<div id="list"><p data-ref="1">a</p></div><div id="list"><p data-ref="2">b</p></div>')
  assert.deepEqual(twice, { items: [], complete: false })
  // A hidden forged copy of the region's id also makes it ambiguous.
  assert.equal(read('<div id="list"><p data-ref="1">a</p></div><template><div id="list"></div></template>').complete, true, 'a template\'s content is not part of the document')
  assert.deepEqual(read('<div id="list"><p data-ref="1">a</p></div><div hidden id="list"><p data-ref="9">x</p></div>'), { items: [], complete: false })
  // An attribute written twice (the parser keeps the first): the element is not read.
  const dup = read('<div id="list"><p data-ref="1" data-ref="2">a</p><p data-ref="3">b</p></div>')
  assert.deepEqual(values(dup), ['3'])
  assert.equal(dup.complete, false)
  // Also when the reader finds the element by its tag and then asks the attribute.
  const byTag: BrowserExploreReader = { ...refs, read: (_v, page) => ({ items: page.find({ tag: 'p' }).map(el => ({ field: 'ref', value: el.attr('data-ref') ?? '-' })).filter(i => i.value !== '-'), complete: true }) }
  assert.deepEqual(read('<p data-ref="1" data-ref="2">a</p><p data-ref="3">b</p>', byTag), { items: [{ field: 'ref', value: '3' }], complete: false })
  const dupRegion = read('<div id="list" id="other"><p data-ref="1">a</p></div>')
  assert.deepEqual(dupRegion, { items: [], complete: false })
})

test('broken HTML is mended the way a browser mends it, and a reference written in text never becomes a reference', () => {
  // Unclosed tags: the parser closes them as a browser would.
  assert.deepEqual(values(read('<div id="list"><p data-ref="1">a<p data-ref="2">b</div>')), ['1', '2'])
  // A reference spelled in text, a comment, or an attribute outside the region is never an item.
  const r = read(`<p data-ref="99">outside the region</p><div id="list">data-ref="98" <!-- <p data-ref="97"> --><p data-ref="1">ok</p></div>`)
  assert.deepEqual(values(r), ['1'])
  // A tag spelled inside an attribute value is text, not an element.
  assert.deepEqual(values(read('<div id="list"><p title=\'<p data-ref="96">\' data-ref="1">x</p></div>')), ['1'])
})

test('what a reader hands back is cut to its declared fields and extras, plain ids and clean labels; anything else makes the read incomplete', () => {
  const doc = parseBrowserHtml('<div id="list"></div>')
  const hand = (items: unknown[], complete = true): ReturnType<typeof read> =>
    runExploreReader({ ...refs, read: () => ({ items: items as never, complete }) }, {}, doc)
  assert.deepEqual(hand([{ field: 'ref', value: '1', label: 'a', extra: { note: 'n' } }]), { items: [{ field: 'ref', value: '1', label: 'a', extra: { note: 'n' } }], complete: true })
  for (const bad of [
    { field: 'secret', value: '1' }, // not a declared field
    { field: 'ref', value: 'a b' }, // not a plain id
    { field: 'ref', value: 'x'.repeat(65) },
    { field: 'ref', value: '1', extra: { token: 'abc' } }, // not a declared extra
    { field: 'ref', value: '1', extra: { note: 1 } },
  ]) {
    const r = hand([bad])
    assert.deepEqual(r.items, [], JSON.stringify(bad))
    assert.equal(r.complete, false, JSON.stringify(bad))
  }
  // A reader that throws, or more than 300 items.
  assert.deepEqual(runExploreReader({ ...refs, read: () => { throw new Error('x') } }, {}, doc), { items: [], complete: false })
  const many = hand(Array.from({ length: 301 }, (_, i) => ({ field: 'ref', value: String(i + 1) })))
  assert.equal(many.items.length, 300)
  assert.equal(many.complete, false)
  // A reader's own "complete: false" stays.
  assert.equal(hand([], false).complete, false)
})

test('a label is NFC, one line, without control, bidirectional or zero-width characters, cut at 80', () => {
  const rlo = String.fromCharCode(0x202e)
  const zw = String.fromCharCode(0x200b)
  assert.equal(cleanLabel(`ｶﾞ${rlo}名前${zw}\n\t続き`), 'ｶﾞ 名前 続き')
  assert.equal(cleanLabel('が'), 'が')
  assert.equal(cleanLabel('あ'.repeat(100)).length, 80)
})

// ---------------------------------------------------------------------------
// Lステップ's reader of a reminder's page
// ---------------------------------------------------------------------------

const lstep = lstepConnector()
const reader = lstep.readers[0]
const box = (step: string, slots: string[], text = `当日 09:00 に送信`) =>
  `<div class="step" id="templateStep${step}"><span>${text}</span>${slots.map((t, i) => `<a onclick="openModal(101, ${step}, ${i + 1}, ${t}, 8)">テンプレ</a>`).join('')}</div>`
const reminderPage = (body: string) => `<!doctype html><html><head><meta name="lm-account-id" content="5550001"><meta name="csrf-token" content="tok"></head>
<body><input type="hidden" name="_token" value="tok"><script>window.__state = { step: 777, template: 888 }</script>${body}</body></html>`

test('Lステップ\'s declaration 0.3.0 declares the reminder page as a reviewed, side-effect-free read with its reader', () => {
  const browser = createBrowserConnectors([lstep.declaration])('lstep', '0.3.0')
  assert.ok(browser)
  assert.deepEqual(browser.explore, { reminder: { label: 'リマインダの中身（段の一覧）', path: '/line/episode/show/{reminder}', placeholders: ['reminder'], reader: reader.id } })
  assert.equal(browser.operations.reminder_step_add_template.delivers, 'none', 'no scheduled type until its meaning is known (design memo §34)')
})

test('Lステップ\'s reader takes steps from their box ids and templates from the slots\' calls in each box, nothing from text, scripts or hidden parts', () => {
  const r = read(reminderPage(`${box('201', ['300'])}${box('202', [], 'N 日前 に送信')}
    <p>templateStep999 openModal(101, 999, 1, 666, 8)</p>
    <div hidden id="templateStep555"></div>`), reader, { reminder: '101' })
  assert.deepEqual(r.items, [
    { field: 'step', value: '201', label: '当日 09:00 に送信 テンプレ' },
    { field: 'template', value: '300', extra: { in_step: '201' } },
    { field: 'step', value: '202', label: 'N 日前 に送信' },
  ])
  assert.equal(r.complete, true)
  // A slot naming another reminder or step: the page is not what we think.
  const other = read(reminderPage(`<div id="templateStep201"><a onclick="openModal(102, 201, 1, 300, 8)">x</a></div>`), reader, { reminder: '101' })
  assert.equal(other.complete, false)
  assert.deepEqual(other.items, [{ field: 'step', value: '201', label: 'x' }])
  // A box id used twice: that step is not read.
  const twice = read(reminderPage(`${box('201', ['300'])}${box('201', ['301'])}`), reader, { reminder: '101' })
  assert.deepEqual(twice, { items: [], complete: false })
  // No step box at all, or a reminder that is not a plain positive id.
  assert.equal(read(reminderPage('<p>空</p>'), reader, { reminder: '101' }).complete, false)
  assert.deepEqual(read(reminderPage(box('201', [])), reader, { reminder: '0' }), { items: [], complete: false })
})

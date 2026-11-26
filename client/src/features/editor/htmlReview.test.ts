import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorHtmlQuote, htmlQuoteFinder, htmlQuoteNth, htmlReadableText, htmlReviewMarks } from './htmlReview'

const PAGE = `<!doctype html><html><head><title>売上 の報告</title><style>p::after { content: "売上" }</style></head>
<body>
  <h1>11月の売上</h1>
  <p>今月の売上は
     2,340 万円で、<b>前年比</b> 112%&nbsp;でした。</p>
  <table><tr><td>前年比</td><td>120%</td></tr></table>
  <p>来月の売上は未定です &amp; 調整中。</p>
  <script>const label = '12月の見込み 2,600 万円'; if (1 < 2) {}</script>
</body></html>`

test('a quote spanning tags, line breaks and entities is found where it is in the file', () => {
  const at = anchorHtmlQuote(PAGE, { text: '万円で、前年比 112% でした', prefix: '2,340 ', suffix: '。' })
  assert.ok(at)
  assert.equal(PAGE.slice(at.start, at.start + 3), '万円で')
  assert.ok(PAGE.slice(at.start, at.end).endsWith('でした'))
  assert.ok(anchorHtmlQuote(PAGE, { text: '未定です & 調整中', prefix: '', suffix: '' }), 'an entity reads as its character')
  assert.equal(anchorHtmlQuote(PAGE, { text: 'どこにもない言葉', prefix: '', suffix: '' }), null)
})

test('the occurrence the member selected is chosen by the words around it, not the first one', () => {
  const second = anchorHtmlQuote(PAGE, { text: '前年比', prefix: '', suffix: '120%' })!
  const first = anchorHtmlQuote(PAGE, { text: '前年比', prefix: '2,340 万円で、', suffix: ' 112%' })!
  assert.ok(second.start > first.start)
  assert.equal(htmlQuoteNth(PAGE, '前年比', first.start), 0)
  assert.equal(htmlQuoteNth(PAGE, '前年比', second.start), 1)
  // The file changed a little above it: still the nearest one.
  assert.equal(htmlQuoteNth(`<p>はじめに</p>${PAGE}`, '前年比', second.start), 1)
})

test('the title, styles and scripts are not words of the page for the n-th occurrence (as in the view)', () => {
  // 「売上」 in the title and in the style would shift the count if they were read.
  const at = anchorHtmlQuote(PAGE, { text: '売上', prefix: '11月の', suffix: '' })!
  assert.equal(htmlQuoteNth(PAGE, '売上', at.start), 0)
})

test('「位置不明」 for HTML: still there across tags and spacing, a script\'s words count, a changed sentence does not', () => {
  const has = htmlQuoteFinder(PAGE)
  assert.equal(has('2,340 万円で、前年比 112%'), true)
  assert.equal(has('前年比120%'), true, 'table cells read without the space the view shows between them')
  assert.equal(has('12月の見込み 2,600 万円'), true, 'a label a script draws is written in the script')
  assert.equal(has('2,340 万円で、前年比 115%'), false)
})

test('「変更を確認」 compares the page\'s words a line per block, not its tags', () => {
  const text = htmlReadableText(PAGE)
  assert.doesNotMatch(text, /<|>|script|const label/)
  assert.deepEqual(text.split('\n'), ['11月の売上', '今月の売上は 2,340 万円で、前年比 112% でした。', '前年比 | 120%', '来月の売上は未定です & 調整中。'])
})

test('the view is given the shown comments\' quotes only, in order, with their ids kept apart', () => {
  const marks = htmlReviewMarks(PAGE, [
    { id: 'a', selectedText: '前年比', startOffset: anchorHtmlQuote(PAGE, { text: '前年比', prefix: '', suffix: '120%' })!.start, resolved: true },
    { id: 'b', selectedText: '消えた文', startOffset: 0, resolved: false, orphaned: true },
    { id: 'c', selectedText: '未定です', startOffset: 0, resolved: false },
  ])
  assert.deepEqual(marks.ids, ['a', 'c'])
  assert.deepEqual(marks.quotes, [{ text: '前年比', nth: 1, resolved: true }, { text: '未定です', nth: 0, resolved: false }])
})

test('a template\'s content (nested ones too) is not counted, as the view does not count it', () => {
  const html = '<template><p>same</p><template>same</template>same</template><p>first same</p><p>second same</p>'
  const second = anchorHtmlQuote(html, { text: 'same', prefix: 'second', suffix: '' })!
  assert.equal(htmlQuoteNth(html, 'same', second.start), 1)
})

test('a character whose lower case is longer (İ) does not shift where an end tag is found', () => {
  const html = '<p>İİİİ</p><SCRIPT>const x = "same"</ScRiPt><p>first same</p><style>p{}</style><p>second same</p>'
  const at = anchorHtmlQuote(html, { text: 'same', prefix: 'second', suffix: '' })!
  assert.equal(html.slice(at.start, at.end), 'same')
  assert.equal(htmlQuoteNth(html, 'same', at.start), 1, 'the script\'s words are not counted')
})

test('a large page (3.5 MB, 50 comments) is read once: marks, 位置不明 and anchoring stay within the budget (about 10x a developer Mac, testing.md)', () => {
  const block = (i: number) => `<section><h2>第${i}節</h2><p>売上は前年比 ${100 + (i % 50)}% でした。<b>担当</b>は営業${i % 7}課です &amp; 確認中。</p><script>const v${i} = '${'x'.repeat(40)}'</script><style>.c${i}{color:red}</style></section>\n`
  let html = '<!doctype html><html><head><title>大きな報告</title></head><body>'
  for (let i = 0; html.length < 3_500_000; i++) html += block(i)
  html += '</body></html>'
  const comments = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, selectedText: `第${i * 97}節`, startOffset: html.indexOf(`第${i * 97}節`), resolved: false }))
  const started = performance.now()
  const marks = htmlReviewMarks(html, comments)
  const has = htmlQuoteFinder(html)
  for (const c of comments) assert.equal(has(c.selectedText), true)
  for (const c of comments.slice(0, 10)) assert.ok(anchorHtmlQuote(html, { text: c.selectedText, prefix: '', suffix: '売上は' }))
  const took = performance.now() - started
  assert.equal(marks.quotes.length, 50)
  console.log(`[perf] html-review-3.5mb-50-comments=${Math.round(took)} ms (budget 3000)`)
  assert.ok(took < 3000, `took ${Math.round(took)} ms`)
})

test('an entity standing for two UTF-16 units (an emoji) keeps the file positions in step', () => {
  const html = '<p>&#x1F600;hello</p>'
  const at = anchorHtmlQuote(html, { text: 'hello', prefix: '', suffix: '' })!
  assert.equal(html.slice(at.start, at.end), 'hello')
})

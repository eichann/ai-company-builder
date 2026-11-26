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

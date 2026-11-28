import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cssForTheme, hasRichBlock, richPiecesOf, writtenSoFar } from './richReply'

const fence = (info: string, body: string) => '```' + info + '\n' + body + '\n```'

// A code example the member asked for must stay code: only the app's own two fences draw a frame.
test('only ```acb-html and ```acb-slide make a reply rich; ```html, other fences and an acb fence inside another stay code', () => {
  assert.equal(hasRichBlock(`前\n\n${fence('acb-html', '<p>表</p>')}\n\n後`), true)
  assert.equal(hasRichBlock(fence('acb-slide', '<h1>1枚</h1>')), true)
  assert.equal(hasRichBlock(fence('ACB-HTML', '<p>表</p>')), true)
  assert.equal(hasRichBlock(fence('html', '<p>表</p>')), false)
  assert.equal(hasRichBlock('`acb-html` という書き方があります'), false)
  assert.equal(hasRichBlock('````markdown\n' + fence('acb-html', '<p>例</p>') + '\n````'), false)
  assert.equal(hasRichBlock('~~~\n```acb-html\n~~~'), false)
  assert.equal(hasRichBlock('ふつうの返事です。'), false)
})

test('the reply is cut into its pieces in order; ```html stays inside the Markdown around it', () => {
  const pieces = richPiecesOf(`結論です。\n\n${fence('acb-html', '<table><tr><td>A</td></tr></table>')}\n\n${fence('html', '<b>コード</b>')}\n\n${fence('acb-slide', '<h1>図</h1>')}`)
  assert.deepEqual(pieces.map(p => [p.kind, p.open]), [['markdown', false], ['html', false], ['markdown', false], ['slide', false]])
  assert.equal(pieces[1].text, '<table><tr><td>A</td></tr></table>')
  assert.match(pieces[2].text, /```html\n<b>コード<\/b>\n```/)
})

test('a block still being written is the last piece, open; a longer closing fence closes it, a shorter one does not', () => {
  const writing = richPiecesOf(`はじめに\n\n\`\`\`acb-html\n<p>途中`)
  assert.deepEqual(writing.map(p => [p.kind, p.open, p.text]), [['markdown', false, 'はじめに\n'], ['html', true, '<p>途中']])
  assert.equal(richPiecesOf('````acb-html\n<p>a</p>\n```\n<p>b</p>\n`````').map(p => p.text).join('|'), '<p>a</p>\n```\n<p>b</p>')
})

test('what is drawn of a block still being written stops at its last whole tag, outside an open <style> or table row', () => {
  assert.equal(writtenSoFar('<p>一つ目</p><p>二つ'), '<p>一つ目</p><p>')
  assert.equal(writtenSoFar('<p>a</p><style>.x { color: re'), '<p>a</p>')
  assert.equal(writtenSoFar('<p>a</p><style>.x{}</style><p>b</p>'), '<p>a</p><style>.x{}</style><p>b</p>')
  assert.equal(writtenSoFar('<table><tr><td>1</td></tr><tr><td>2</td>'), '<table><tr><td>1</td></tr>')
  assert.equal(writtenSoFar('<img src="data:image/png;base64,AAA'), '')
})

test('the reply\'s light / dark CSS follows the app\'s theme, not the computer\'s', () => {
  const css = '@media (prefers-color-scheme: dark) { .a { color: white } }\n@media (PREFERS-COLOR-SCHEME:light) { .a { color: black } }'
  assert.equal(cssForTheme(css, true), '@media (min-width: 0px) { .a { color: white } }\n@media (max-width: -1px) { .a { color: black } }')
  assert.equal(cssForTheme(css, false), '@media (max-width: -1px) { .a { color: white } }\n@media (min-width: 0px) { .a { color: black } }')
})

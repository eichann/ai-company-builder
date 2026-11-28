import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageCardOf } from './pageCards'

const ROOT = '/Users/demo/会社'
const PAGE = `${ROOT}/営業部/.personal/inbox/日付別/2026/20261128/ページ/比べる表.html`

// The reply is the AI's: only a page of the company folder the viewer can show becomes a card; the rest stays a link.
test('a link to an HTML file inside the company folder is a card: absolute, company-relative, percent-encoded as markdown writes it', () => {
  assert.deepEqual(pageCardOf(PAGE, ROOT), { path: PAGE, name: '比べる表.html', personal: true })
  assert.deepEqual(pageCardOf(encodeURI(PAGE), ROOT), { path: PAGE, name: '比べる表.html', personal: true })
  assert.deepEqual(pageCardOf('営業部/報告/売上.htm', `${ROOT}/`), { path: `${ROOT}/営業部/報告/売上.htm`, name: '売上.htm', personal: false })
})

test('no card for the web, other schemes, a place outside the company folder, a climb, the top level, a hidden file or another type', () => {
  for (const href of [
    'https://evil.example/営業部/x.html',
    'http://localhost/営業部/x.html',
    `file://${PAGE}`,
    'javascript:alert(1)//a/b.html',
    'acb-doc://token/x.html',
    'mailto:x/営業部/a.html',
    'javascript:x/営業部/a.html',
    '営業部/報告/a.html?b.html',
    '営業部/報告/a.html#b.html',
    '/tmp/よそ.html',
    `${ROOT}-other/営業部/x.html`,
    `${ROOT}/営業部/../../x.html`,
    `${ROOT}/営業部/%2e%2e/%2e%2e/x.html`,
    '../営業部/x.html',
    `${ROOT}/営業部//x.html`,
    `${ROOT}/会社案内.html`,
    `${ROOT}/営業部/.secret.html`,
    `${ROOT}/営業部/提案書.md`,
    `${PAGE}?x=1`,
    `${PAGE}#top`,
    `${ROOT}/営業部/a%0a.html`,
    `${ROOT}/営業部/%E0%A4%A.html`,
    '',
  ]) assert.equal(pageCardOf(href, ROOT), null, href)
  assert.equal(pageCardOf(PAGE, null), null, 'no company: no card')
  assert.equal(pageCardOf(undefined, ROOT), null)
})

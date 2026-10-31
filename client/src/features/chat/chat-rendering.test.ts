import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import { chatMarkdownSafety } from './chatMarkdownSafety'
import { splitMarkdownBlocks } from './markdownBlocks'
import { MESSAGE_WINDOW, earlierAnchor, windowStart } from './messageWindow'
import { thumbnailSize } from './historyThumbnail'

// --- markdown blocks ---------------------------------------------------------

const render = (text: string) => renderToStaticMarkup(React.createElement(Markdown, {
  remarkPlugins: [...chatMarkdownSafety.remarkPlugins], skipHtml: chatMarkdownSafety.skipHtml,
}, text))
// Whitespace between block elements (one parse puts a newline there) does not render.
const html = (markup: string) => markup.replace(/>\n+</g, '><').replace(/^\n+|\n+$/g, '')
const renderBlocks = (text: string) => html(splitMarkdownBlocks(text).map(block => render(block.text)).join(''))

const SAMPLES: Record<string, string> = {
  paragraphs: '最初の段落です。\n続きの行。\n\n二つ目の段落。\n\n## 見出し\n\n本文',
  tightList: '- a\n- b\n- c\n\n次の段落',
  looseList: '- a\n\n- b\n\n- c\n\n終わり',
  orderedLoose: '1. 手順一\n\n2. 手順二\n\n   続きの説明（インデント）\n\n3. 手順三',
  nestedList: '- 親\n  - 子\n\n    子の続き\n- 親2',
  fencedWithBlankLines: '説明\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n後の段落',
  tildeFence: '~~~\n```\nnot a fence end\n\n~~~\n\nafter',
  longerClosingFence: '````md\n```\ninner\n```\n\nstill inside\n````\n\nout',
  indentedCode: '段落\n\n    indented code\n\n    more code\n\n段落2',
  table: '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n| 3 |',
  blockquote: '> 引用\n> 続き\n\n> 別の引用\n\n本文',
  hr: '上\n\n---\n\n下',
  setextLike: 'タイトル\n========\n\n本文',
  html: '<div>\n\nskipped\n\n</div>\n\n本文',
  tasks: '- [ ] 未完了\n- [x] 完了\n\n以上',
  leadingBlankLines: '\n\n\n本文\n\n次',
  trailingBlankLines: '本文\n\n\n',
  toolMarkers: '確認します。\n[Tool: Read]\n[Tool: Grep]\n\n結果です。',
}

test('blocks render exactly like the whole reply', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    assert.equal(renderBlocks(text), html(render(text)), name)
  }
})

test('reference and footnote definitions keep the reply in one block', () => {
  for (const text of ['[公式][doc] を参照。\n\n説明\n\n[doc]: https://example.com', '本文[^1]\n\n次\n\n[^1]: 脚注']) {
    assert.equal(splitMarkdownBlocks(text).length, 1)
    assert.equal(renderBlocks(text), html(render(text)))
  }
})

test('a streaming reply: earlier blocks stay identical, only the tail grows; an unclosed fence is flagged', () => {
  const full = '# 結果\n\n説明の段落。\n\n```python\nprint(1)\n\nprint(2)\n```\n\nまとめ。'
  let previous: string[] = []
  for (let end = 1; end <= full.length; end++) {
    const blocks = splitMarkdownBlocks(full.slice(0, end))
    const texts = blocks.map(block => block.text)
    // Everything but the previous tail is unchanged (memoised blocks are not re-parsed).
    for (let i = 0; i < previous.length - 1; i++) assert.equal(texts[i], previous[i])
    const inFence = full.slice(0, end).split("\n").filter(line => line.startsWith("```")).length % 2 === 1
    assert.equal(blocks.at(-1)!.openFence, inFence, JSON.stringify(full.slice(0, end)))
    assert.ok(blocks.slice(0, -1).every(block => !block.openFence))
    previous = texts
  }
  assert.deepEqual(previous, ['# 結果', '説明の段落。', '```python\nprint(1)\n\nprint(2)\n```', 'まとめ。'])
})

// --- windowed message list -----------------------------------------------------

const ids = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

test('a long conversation opens with the latest messages only', () => {
  const messages = ids(564)
  assert.equal(windowStart(messages, null), 564 - MESSAGE_WINDOW)
  assert.equal(windowStart(ids(10), null), 0)
})

test('new messages are added to the window; nothing disappears at the top', () => {
  const messages = ids(200)
  const start = windowStart(messages, null)
  const anchor = messages[start].id
  const grown = [...messages, ...ids(30, 'new')]
  assert.equal(windowStart(grown, anchor), start)
  assert.equal(grown.length - windowStart(grown, anchor), MESSAGE_WINDOW + 30)
})

test('「以前のメッセージを表示」 adds a page at a time down to the first message', () => {
  const messages = ids(120)
  let start = windowStart(messages, null)
  assert.equal(start, 70)
  start = windowStart(messages, earlierAnchor(messages, start))
  assert.equal(start, 20)
  start = windowStart(messages, earlierAnchor(messages, start))
  assert.equal(start, 0)
})

test('a replaced or truncated conversation starts over with the latest messages', () => {
  const messages = ids(120)
  const anchor = messages[windowStart(messages, null)].id
  assert.equal(windowStart([{ id: '1' }], anchor), 0)
  assert.equal(windowStart(messages.slice(0, 60), anchor), 10)
})

// --- history thumbnails --------------------------------------------------------

test('history thumbnails keep the aspect ratio within 320 px and never upscale', () => {
  assert.deepEqual(thumbnailSize(2880, 1800), { width: 320, height: 200 })
  assert.deepEqual(thumbnailSize(600, 1200), { width: 160, height: 320 })
  assert.deepEqual(thumbnailSize(100, 50), { width: 100, height: 50 })
  assert.deepEqual(thumbnailSize(0, 0), { width: 1, height: 1 })
})

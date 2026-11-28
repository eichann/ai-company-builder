// Guards "editing a document in place never changes what was not edited" (files-and-editor.md
// "Editing a document in place"): the real Milkdown reader and writer, under jsdom, on fictional
// documents written the way people and the AI write them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import type { MarkdownCodec } from './markdownSplice'
import type { InPlaceBlock } from './blockChoices'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const win = dom.window as unknown as Record<string, unknown>
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis && !['window', 'document', 'navigator', 'Event', 'CustomEvent', 'EventTarget'].includes(key)) continue
  let value: unknown
  try { value = win[key] } catch { continue }
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  Object.defineProperty(globalThis, key, { value: (win[key] as (...a: unknown[]) => unknown).bind(dom.window), configurable: true, writable: true })
}

// Layout the editor asks for when it scrolls a change into view (jsdom lays nothing out).
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
for (const proto of [dom.window.Element.prototype, dom.window.Range.prototype] as Array<{ getClientRects: () => DOMRectList; getBoundingClientRect: () => DOMRect }>) {
  proto.getClientRects = noRects
  proto.getBoundingClientRect = zeroRect
}
const { SplicedDocument, splitFront } = await import('./markdownSplice')
const { selectionOf, setInPlaceLink, setInPlaceSize, toggleInPlaceMark } = await import('./milkdownFormat')
const { TextSelection } = await import('@milkdown/prose/state')
const { makeMilkdown } = await import('./milkdownSurface')
const { blockMenuOf, closeBlockMenu, editTable, turnIntoBlock } = await import('./milkdownBlocks')

let md: Awaited<ReturnType<typeof makeMilkdown>>
before(async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  md = await makeMilkdown(host)
})
after(async () => { await md.destroy() })

const MEETING = `---
title: 営業部 定例ミーティング
date: 2026-11-20
tags: [営業, 定例]
---

# 営業部 定例ミーティング（11/20）

参加：佐藤、鈴木、田中（AI が議事メモを取りました）
場所：会議室B / オンライン併用

## 決まったこと

* A社の新人研修は **12月第2週** から始める
* 見積もりは _来週の木曜まで_ に送る
    * 金額は前回と同じ（税抜 48 万円）
    * 送る前に田中さんが確認する
* 次回の定例は 11/27（木）10:00〜

1. 研修資料の下書きを作る
2. 先方の担当者に日程を確認する


## 数字の確認

| 項目 | 10月 | 11月（見込み） | メモ |
|:-----|-----:|------:|------|
| 問い合わせ | 42 | 51 | 広告を変えてから増えた |
| 商談 | 18 | 20 |  |
| 受注 |6|7| 平均単価は横ばい |

## 進め方のメモ

先方からは「現場のリーダーが参加しやすい時間帯にしてほしい」との要望があり、案ごとの費用と準備の手間を 1 枚にまとめて渡す。
資料の置き場所は [研修フォルダ](./研修/A社/) 、過去の見積もりは [見積もり一覧][mitsumori] を見てください。
問い合わせ窓口：<https://example.com/contact>

<details>
<summary>前回からの持ち越し</summary>

- 名刺の発注（総務に依頼済み）
- 展示会の振り返り

</details>

<!-- AI メモ: 次回までに受注率を計算しておく -->

***

### やること

- [x] 議事メモを共有する
- [ ] 見積もりを作る（担当：鈴木）

\\* 印の項目は来月に見直します。

\`\`\`text
件名：【A社様】新人研修のお見積もり
本文：いつもお世話になっております。…
\`\`\`

[mitsumori]: ./見積もり/一覧.md "見積もり一覧"
`

const SKILL = `---
name: weekly-report
description: "毎週金曜に、今週の商談と問い合わせをまとめて報告の下書きを作る"
---

週報の下書きを作る
==================

この Skill は、**今週の商談** と問い合わせの記録を読み、上長に送る週報の下書きを作ります。送るのは人が確かめてからです。

手順
----

1. \`営業部/商談/\` の今週の記録を読む
2. 問い合わせの件数を数える
   - 先週より 2 割以上増えたら、理由の候補を書く
3. 下書きを \`営業部/週報/YYYY-MM-DD.md\` に書く

> 注意：お客さんの個人名は書かない。会社名だけにする。

\`\`\`bash
ls 営業部/商談/2026-11-* | wc -l
\`\`\`

| 見出し | 書くこと |
|---|---|
| 今週の数字 | 問い合わせ・商談・受注 |
| 気づき | 3 行まで |

困ったときは <a href="https://example.com/help">社内ヘルプ</a> を見てください。<br>
最終更新：2026-11-10
`

function open(text: string) {
  const loaded = SplicedDocument.load(text, md.codec)
  assert.ok(loaded.ok, `loads: ${loaded.ok ? '' : loaded.reason}`)
  const view = md.view()
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, loaded.doc.doc.content))
  assert.ok(loaded.doc.rebase(view.state.doc))
  return { spliced: loaded.doc, view }
}

/** Position just after the first `after` in the document's text. */
function posAfter(doc: PMNode, after: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText && node.text) {
      const i = node.text.indexOf(after)
      if (i >= 0) { found = pos + i + after.length; return false }
    }
    return true
  })
  assert.ok(found >= 0, `found: ${after}`)
  return found
}

function insertAfter(view: EditorView, after: string, insert: string) {
  view.dispatch(view.state.tr.insertText(insert, posAfter(view.state.doc, after)))
}

function saved(spliced: import('./markdownSplice').SplicedDocument, view: EditorView, what = ''): string {
  const w = spliced.write(view.state.doc)
  assert.ok(w, `the change can be written back ${what}`)
  w.commit()
  return w.text
}

/** Lines of `a` replaced and lines added in `b`, outside the common start and end. */
function changedLines(a: string, b: string) {
  const x = a.split('\n')
  const y = b.split('\n')
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  return { removed: x.length - p - s, added: y.length - p - s }
}

const plusAfter = (text: string, after: string, insert: string) => {
  const at = text.indexOf(after) + after.length
  return text.slice(0, at) + insert + text.slice(at)
}

test('opening and writing back without an edit leaves the file byte for byte as it was', () => {
  for (const text of [MEETING, SKILL, '', '# 見出しだけ', 'テキスト\r\n\r\n- 一\r\n- 二\r\n']) {
    const { spliced, view } = open(text)
    assert.equal(saved(spliced, view), text)
  }
})

test('one character typed anywhere changes exactly that character in the file', () => {
  const cases: Array<[string, string, string]> = [
    [MEETING, '1 枚にまとめて', 'す'], // a long paragraph
    [MEETING, '送る前に田中さんが', '必'], // a nested `*` list indented by 4
    [MEETING, '広告を変えてから', '少'], // a table cell, padding kept
    [MEETING, '受注', '数'], // an unpadded table row
    [MEETING, '研修資料の', '新'], // a numbered list
    [MEETING, '議事メモを', '全員に'], // a checklist
    [MEETING, '名刺の発注', '（50枚）'], // a list inside <details>
    [MEETING, 'リーダーが', 'すぐ'], // the line before a reference link
    [MEETING, '営業部 定例ミーティング（11/20', '）'], // the first heading, under the frontmatter
    [SKILL, '送るのは人が確かめて', 'い'],
    [SKILL, '理由の候補を', '必ず'],
    [SKILL, '3 行まで', '。'],
    [SKILL, '会社名だけに', 'は'], // a quote
    [SKILL, '週報の下書きを', 'すぐ'], // a `===` heading
  ]
  for (const [text, after, insert] of cases) {
    const { spliced, view } = open(text)
    insertAfter(view, after, insert)
    assert.equal(saved(spliced, view, after), plusAfter(text, after, insert), `${after} + ${insert}`)
  }
})

test('edits in two far apart places each change only their own line (the baseline moves on)', () => {
  const { spliced, view } = open(MEETING)
  insertAfter(view, '1 枚にまとめて', 'す')
  saved(spliced, view)
  insertAfter(view, '名刺の発注', '（50枚）')
  insertAfter(view, '営業部 定例ミーティング（11/20', '）')
  const text = saved(spliced, view)
  assert.equal(text, plusAfter(plusAfter(plusAfter(MEETING, '1 枚にまとめて', 'す'), '名刺の発注', '（50枚）'), '営業部 定例ミーティング（11/20', '）'))
})

test('a new list item is one new line in the list\'s own indentation and marker', () => {
  const { spliced, view } = open(MEETING)
  const { state } = view
  const at = posAfter(state.doc, '送る前に田中さんが確認する')
  const $at = state.doc.resolve(at)
  const itemDepth = [...Array($at.depth + 1).keys()].reverse().find(d => $at.node(d).type.name === 'list_item')!
  const item = $at.node(itemDepth)
  const added = item.type.create(item.attrs, state.schema.nodes.paragraph.create(null, state.schema.text('請求書も送る')))
  view.dispatch(state.tr.insert($at.after(itemDepth), added))
  const text = saved(spliced, view)
  assert.deepEqual(changedLines(MEETING, text), { removed: 0, added: 1 })
  assert.ok(text.includes('    * 送る前に田中さんが確認する\n    * 請求書も送る\n'), text)
})

/** Splits the text block holding the caret right after `after`, as Enter does (an empty one when at its end). */
function enterAfter(view: EditorView, after: string): number {
  const at = posAfter(view.state.doc, after)
  const $at = view.state.doc.resolve(at)
  const inItem = [...Array($at.depth + 1).keys()].some(d => $at.node(d).type.name === 'list_item')
  view.dispatch(inItem ? view.state.tr.split(at, 2) : view.state.tr.split(at))
  return at + (inItem ? 4 : 2) // the start of the new, empty text block
}

test('Enter makes an empty line that writes nothing; what is typed into it is the one new line', () => {
  const text = '# 題\n\n一つめの段落\n\n二つめの段落\n'
  {
    const { spliced, view } = open(text)
    const at = enterAfter(view, '一つめの段落')
    assert.equal(saved(spliced, view), text, 'no `<br />` for the empty paragraph')
    view.dispatch(view.state.tr.insertText('間の段落', at))
    assert.equal(saved(spliced, view), '# 題\n\n一つめの段落\n\n間の段落\n\n二つめの段落\n')
  }
  {
    const { spliced, view } = open(text)
    view.dispatch(view.state.tr.split(posAfter(view.state.doc, '一つめの段落') - 6))
    assert.equal(saved(spliced, view), text, 'Enter at the start of a paragraph')
  }
})

test('a new item in a `-` or numbered list keeps the file\'s own markers; an empty item writes nothing', () => {
  const cases: Array<[string, string, string]> = [
    ['- 項目一\n- 項目二\n- 項目三\n', '項目一', '- 項目一\n- 新\n- 項目二\n- 項目三\n'],
    ['1. 一\n1. 二\n1. 三\n', '二', '1. 一\n1. 二\n1. 新\n1. 三\n'],
    ['1. 一\n2. 二\n', '二', '1. 一\n2. 二\n3. 新\n'],
  ]
  for (const [text, after, expected] of cases) {
    const { spliced, view } = open(text)
    const at = enterAfter(view, after)
    assert.equal(saved(spliced, view), text, `the empty item after ${after}`)
    view.dispatch(view.state.tr.insertText('新', at))
    assert.equal(saved(spliced, view), expected)
  }
})

test('typing in one of several equal list items changes that item only', () => {
  // Spaced as people type it: rewritten by the editor, the list would lose its spacing.
  const text = '-   同じ\n-   同じ\n-   同じ\n'
  const { spliced, view } = open(text)
  let second = -1
  let seen = 0
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === '同じ' && ++seen === 2) second = pos + 2
    return true
  })
  view.dispatch(view.state.tr.insertText('だ', second))
  assert.equal(saved(spliced, view), '-   同じ\n-   同じだ\n-   同じ\n')
})

test('a paragraph deleted whole takes its blank lines along, and the next edits still write', () => {
  const { spliced, view } = open('一つめ\n\n二つめ\n\n三つめ\n')
  const $at = view.state.doc.resolve(posAfter(view.state.doc, '二つめ'))
  view.dispatch(view.state.tr.delete($at.before(1), $at.after(1)))
  assert.equal(saved(spliced, view), '一つめ\n\n三つめ\n')
  insertAfter(view, '三つめ', 'です')
  assert.equal(saved(spliced, view), '一つめ\n\n三つめです\n')
})

test('a line cleared and typed again, and the last paragraph deleted, leave no stray blank lines', () => {
  {
    const { spliced, view } = open('一つめ\n\n二つめ\n\n三つめ\n')
    const from = posAfter(view.state.doc, '二つめ') - 3
    view.dispatch(view.state.tr.delete(from, from + 3))
    assert.equal(saved(spliced, view), '一つめ\n\n三つめ\n')
    view.dispatch(view.state.tr.insertText('新しい二つめ', from))
    assert.equal(saved(spliced, view), '一つめ\n\n新しい二つめ\n\n三つめ\n')
  }
  {
    const { spliced, view } = open('一\n\n二\n')
    const $at = view.state.doc.resolve(posAfter(view.state.doc, '二'))
    view.dispatch(view.state.tr.delete($at.before(1), $at.after(1)))
    assert.equal(saved(spliced, view), '一\n')
  }
})

test('a list item removed or emptied keeps the list\'s `-`, and an item emptied of two paragraphs never stops the writing', () => {
  {
    const { spliced, view } = open('- 一\n- 二\n- 三\n')
    const $at = view.state.doc.resolve(posAfter(view.state.doc, '二'))
    const item = [...Array($at.depth + 1).keys()].reverse().find(d => $at.node(d).type.name === 'list_item')!
    view.dispatch(view.state.tr.delete($at.before(item), $at.after(item)))
    assert.equal(saved(spliced, view), '- 一\n- 三\n')
  }
  {
    const { spliced, view } = open('- 一\n\n  続き\n- 二\n')
    for (const word of ['一', '続き']) {
      const at = posAfter(view.state.doc, word)
      view.dispatch(view.state.tr.delete(at - word.length, at))
      // Written or refused (then taken back on screen), but never a throw that stops the writing.
      let w: ReturnType<typeof spliced.write> = null
      assert.doesNotThrow(() => { w = spliced.write(view.state.doc) })
      if (w) (w as { commit(): void }).commit()
    }
    assert.match(spliced.text, /二/)
  }
})

test('bold, a heading level and a new table row change only their own line', () => {
  {
    const { spliced, view } = open(MEETING)
    const from = posAfter(view.state.doc, '過去の見積もりは') + 1
    view.dispatch(view.state.tr.addMark(from, from + 6, view.state.schema.marks.strong.create()))
    const text = saved(spliced, view)
    assert.deepEqual(changedLines(MEETING, text), { removed: 1, added: 1 })
    assert.match(text, /\*\*\[?見積もり一覧/)
  }
  {
    const { spliced, view } = open(MEETING)
    const $at = view.state.doc.resolve(posAfter(view.state.doc, '数字の確認'))
    view.dispatch(view.state.tr.setNodeMarkup($at.before($at.depth), undefined, { ...$at.parent.attrs, level: 3 }))
    const text = saved(spliced, view)
    assert.deepEqual(changedLines(MEETING, text), { removed: 1, added: 1 })
    assert.ok(text.includes('\n### 数字の確認\n'))
  }
  {
    const { spliced, view } = open(MEETING)
    const $at = view.state.doc.resolve(posAfter(view.state.doc, '問い合わせ'))
    const rowDepth = [...Array($at.depth + 1).keys()].reverse().find(d => $at.node(d).type.name === 'table_row')!
    const row = $at.node(rowDepth)
    view.dispatch(view.state.tr.insert($at.after(rowDepth), row.copy(row.content)))
    const text = saved(spliced, view)
    assert.deepEqual(changedLines(MEETING, text), { removed: 0, added: 1 })
  }
})

test('a file with CRLF line ends keeps them for typed text and new lines', () => {
  const text = '# 予定\r\n\r\n- 一つめ\r\n- 二つめ\r\n\r\n終わり\r\n'
  const { spliced, view } = open(text)
  insertAfter(view, '二つめ', 'です')
  assert.equal(saved(spliced, view), '# 予定\r\n\r\n- 一つめ\r\n- 二つめです\r\n\r\n終わり\r\n')
  const { state } = view
  view.dispatch(state.tr.addMark(posAfter(state.doc, '終') - 1, posAfter(state.doc, '終わり'), state.schema.marks.strong.create()))
  const next = saved(spliced, view)
  assert.ok(!/[^\r]\n/.test(next), JSON.stringify(next))
})

test('the frontmatter block stays as written, and an empty file takes what is typed', () => {
  assert.deepEqual(splitFront('---\nname: x\n---\n本文'), { front: '---\nname: x\n---\n', body: '本文' })
  assert.deepEqual(splitFront('---  \r\n---\r\n本文'), { front: '---  \r\n---\r\n', body: '本文' })
  const { spliced, view } = open('')
  view.dispatch(view.state.tr.insertText('はじめの一行', 1))
  assert.equal(saved(spliced, view), 'はじめの一行\n')
  // A file of link definitions only shows nothing: what is typed comes first, the definitions stay.
  const defsOnly = open('[ref]: https://example.com\n')
  defsOnly.view.dispatch(defsOnly.view.state.tr.insertText('こんにちは', 1))
  assert.equal(saved(defsOnly.spliced, defsOnly.view), 'こんにちは\n\n[ref]: https://example.com\n')
})

test('a document the editor cannot hold is refused before anything can be written', () => {
  const reason = (r: ReturnType<typeof SplicedDocument.load>) => (r.ok ? 'loaded' : r.reason)
  assert.equal(reason(SplicedDocument.load('本文です[^1]。\n\n[^1]: 注の中身\n', md.codec)), 'unsupported')
  // A reader that drops text on reading (as an editor does with syntax it does not know).
  const dropping: MarkdownCodec = { ...md.codec, parse: s => md.codec.parse(s.replace('大事な一言', '')) }
  assert.equal(reason(SplicedDocument.load('前の段落\n\n大事な一言のある段落\n', dropping)), 'lossy')
})

test('an editor that tidies the document as it shows it does not get to edit it', () => {
  const loaded = SplicedDocument.load('一つめ\n\n二つめ\n', md.codec)
  assert.ok(loaded.ok)
  // Shown with the same number of blocks, but not the same words: not a baseline to write from.
  assert.equal(loaded.doc.rebase(md.codec.parse('一つめ\n\n二つ\n')), false)
  assert.equal(loaded.doc.rebase(md.codec.parse('一つめ\n\n二つめ\n')), true)
})

test('a change that would not read back as what the screen shows is not written', () => {
  // A writer that loses a character: every way of writing the change fails the read-back.
  const lossy: MarkdownCodec = { ...md.codec, serialize: d => md.codec.serialize(d).replace('X', '') }
  const loaded = SplicedDocument.load('一つめの段落\n\n二つめの段落\n', lossy)
  assert.ok(loaded.ok)
  const view = md.view()
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, loaded.doc.doc.content))
  loaded.doc.rebase(view.state.doc)
  const { state } = view
  const at = posAfter(state.doc, '二つめ')
  view.dispatch(state.tr.insertText('X', at).addMark(at, at + 1, state.schema.marks.strong.create()))
  assert.equal(loaded.doc.write(view.state.doc), null)
})

test('a change that would make the next block read differently is not written', () => {
  // A reader that, around the edit, sees the next block joined into it.
  const joining: MarkdownCodec = {
    ...md.codec,
    blocks: s => (s.includes('つなぐ') ? [{ start: 0, end: s.length, kind: 'paragraph' }] : md.codec.blocks(s)),
  }
  const loaded = SplicedDocument.load('一つめ\n\n二つめ\n\n三つめ\n', joining)
  assert.ok(loaded.ok)
  const view = md.view()
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, loaded.doc.doc.content))
  loaded.doc.rebase(view.state.doc)
  view.dispatch(view.state.tr.insertText('つなぐ', posAfter(view.state.doc, '二つめ')))
  assert.equal(loaded.doc.write(view.state.doc), null)
})

/** Selects the first occurrence of `words`. */
function selectWords(view: EditorView, words: string) {
  const to = posAfter(view.state.doc, words)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to - words.length, to)))
}

test('the bubble\'s operations write their one line: a mark in a nested list, a size on one line of a paragraph written over several', () => {
  {
    const { spliced, view } = open(MEETING)
    selectWords(view, '金額は前回と同じ')
    toggleInPlaceMark(view, 'strong')
    assert.equal(saved(spliced, view), MEETING.replace('    * 金額は前回と同じ', '    * **金額は前回と同じ**'))
    toggleInPlaceMark(view, 'strong')
    assert.equal(saved(spliced, view), MEETING)
  }
  {
    const text = '一行め\n二行め\n三行め\n'
    const { spliced, view } = open(text)
    selectWords(view, '二行')
    setInPlaceSize(view, 2)
    assert.equal(saved(spliced, view), '一行め\n\n## 二行め\n\n三行め\n')
  }
  {
    const { spliced, view } = open(SKILL)
    selectWords(view, '手順')
    setInPlaceSize(view, 0)
    assert.equal(saved(spliced, view), SKILL.replace('手順\n----\n', '手順\n'))
  }
})

test('a space typed at the end of a line waits on screen: the file gets it with the next word, never taken back', () => {
  const text = '- 次回：12/1\n- 二つめ\n'
  const { spliced, view } = open(text)
  insertAfter(view, '12/1', ' ')
  assert.equal(saved(spliced, view), text, 'the trailing space alone writes nothing')
  insertAfter(view, '12/1 ', 'に再訪問')
  assert.equal(saved(spliced, view), '- 次回：12/1 に再訪問\n- 二つめ\n')
})

test('the bubble changes nothing it should not: 本文 on body text, a size where no heading can stand, half a link', () => {
  {
    // Already body text: the paragraph written over several lines is not split.
    const text = '一行め\n二行め\n三行め\n'
    const { spliced, view } = open(text)
    selectWords(view, '二行')
    assert.equal(setInPlaceSize(view, 0), false)
    assert.equal(saved(spliced, view), text)
  }
  {
    // A list item, or words over two lines: no size offered, none applied.
    const { view } = open('- 項目の文\n\n一行め\n二行め\n')
    selectWords(view, '項目')
    assert.equal(selectionOf(view)?.size, null)
    assert.equal(setInPlaceSize(view, 2), false)
    const from = posAfter(view.state.doc, '一行') - 2
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, posAfter(view.state.doc, '二行'))))
    assert.equal(selectionOf(view)?.size, null)
  }
  {
    // Taking a link off a few of its words takes the whole link off, written back as its words.
    const text = '詳しくは [社内の資料](https://example.com/a) を見てください。\n'
    const { spliced, view } = open(text)
    selectWords(view, '資料')
    setInPlaceLink(view, null)
    assert.equal(saved(spliced, view), '詳しくは 社内の資料 を見てください。\n')
  }
})

// ───── The 「/」 list, the line starts and the table bar (files-and-editor.md "The 「/」 list, line starts and the table bar") ─────

/** Typed as the keyboard does: each character through the editor's text input (its line-start rules run). */
function typeKeys(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection
    if (!view.someProp('handleTextInput', f => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

/** Enter after `after`, the caret on the new empty line (after a heading, a paragraph: as Enter makes it). */
function newLine(view: EditorView, after: string) {
  const at = posAfter(view.state.doc, after)
  if (view.state.doc.resolve(at).parent.type.name === 'heading') {
    view.dispatch(view.state.tr.split(at, 1, [{ type: view.state.schema.nodes.paragraph }]))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + 2)))
    return
  }
  const start = enterAfter(view, after)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)))
}

test('a 「/」 choice is written as what was made: the new lines only, in the file\'s bullet and divider', () => {
  const cases: Array<[InPlaceBlock, string, string]> = [
    ['heading2', '議題', '## 議題'],
    ['bullet', '項目', '* 項目'], // the MEETING's first bullet
    ['ordered', '一番', '1. 一番'],
    ['task', '資料を送る', '* [ ] 資料を送る'],
    ['quote', '引用', '> 引用'],
    ['code', 'ls', '```\nls\n```'],
    ['table', '名前', '| 名前 |   |   |\n| - | - | - |\n|   |   |   |\n|   |   |   |'],
  ]
  for (const [block, words, written] of cases) {
    const { spliced, view } = open(MEETING)
    newLine(view, '数字の確認')
    typeKeys(view, '/')
    assert.equal(blockMenuOf(view.state)?.choices.length, 10)
    assert.equal(saved(spliced, view), plusAfter(MEETING, '## 数字の確認\n', '\n/\n'), 'the 「/」 is text until a choice')
    assert.ok(turnIntoBlock(view, block), block)
    // Each change is written as it happens (the screen writes every step).
    saved(spliced, view, `${block} chosen`)
    view.dispatch(view.state.tr.insertText(words, view.state.selection.from))
    assert.equal(saved(spliced, view, block), plusAfter(MEETING, '## 数字の確認\n', `\n${written}\n`), block)
  }
  // A divider: the file's own (`***` in the MEETING, `---` where there is none), the caret on the line after it.
  for (const [text, after, line, rule] of [[MEETING, '数字の確認', '## 数字の確認\n', '***'], [SKILL, '手順', '手順\n----\n', '---']] as const) {
    const { spliced, view } = open(text)
    newLine(view, after)
    typeKeys(view, '/区切り')
    assert.ok(turnIntoBlock(view, 'divider'))
    saved(spliced, view)
    view.dispatch(view.state.tr.insertText('下', view.state.selection.from))
    assert.equal(saved(spliced, view), plusAfter(text, line, `\n${rule}\n\n下\n`))
  }
})

test('the 「/」 list: opened by typing 「/」 on an empty line, narrowed, closed by Esc; a 「/todo」 line the file holds is text', () => {
  const { view } = open('# 題\n\n/todo\n\n- 項目\n')
  newLine(view, '題')
  typeKeys(view, '/みだし')
  assert.deepEqual(blockMenuOf(view.state)?.choices, ['heading1', 'heading2', 'heading3'])
  typeKeys(view, 'x')
  assert.equal(blockMenuOf(view.state), null, 'nothing found: no list (Enter is a new line again)')
  view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from))
  assert.ok(blockMenuOf(view.state), 'a letter taken back: found again')
  closeBlockMenu(view)
  assert.equal(blockMenuOf(view.state), null, 'closed with Esc')
  view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from))
  assert.equal(blockMenuOf(view.state), null, 'stays closed for that line')
  // The file's own 「/todo」 line: the caret at its end opens nothing (its Enter is a new line, its words stay).
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posAfter(view.state.doc, '/todo'))))
  assert.equal(blockMenuOf(view.state), null, 'a 「/」 line not typed now')
  const item = posAfter(view.state.doc, '項目')
  view.dispatch(view.state.tr.insertText('/', item))
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, item + 1)))
  assert.equal(blockMenuOf(view.state), null, 'not after words, nor in a list item')
})

test('「```」 and 「---」 in a list item stay the characters typed (no code or divider where they cannot stand)', () => {
  for (const start of ['```', '---']) {
    const text = '- a\n- b\n'
    const { spliced, view } = open(text)
    const at = enterAfter(view, 'b')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
    typeKeys(view, `${start}NEW`)
    assert.equal(view.state.doc.textContent, `ab${start}NEW`, start)
    const written = saved(spliced, view, start)
    assert.ok(written.startsWith('- a\n- b\n- ') && written.includes('NEW'), written)
  }
})

test('the line starts become their block and write what was typed; a list next to a `-` list stays its own (`*`)', () => {
  const text = '# 題\n\n本文の段落です。\n\n- 一つめ\n- 二つめ\n\n終わりの段落。\n'
  const cases: Array<[string, string, string]> = [
    ['# ', '見出し', '# 見出し'], ['### ', '小', '### 小'], ['- ', '項目', '- 項目'], ['* ', '項目', '- 項目'], ['1. ', '一番', '1. 一番'],
    ['3. ', '三番', '3. 三番'], ['[] ', 'やること', '- [ ] やること'], ['[ ] ', 'やること', '- [ ] やること'], ['> ', '引用', '> 引用'],
    ['```', 'ls', '```\nls\n```'], ['---', '下', '---\n\n下'],
  ]
  for (const [start, words, written] of cases) {
    const { spliced, view } = open(text)
    newLine(view, '終わりの段落。')
    typeKeys(view, start)
    typeKeys(view, words)
    assert.equal(saved(spliced, view, start), `${text}\n${written}\n`, start)
  }
  {
    // Right above the `-` list: a `-` would join it (one list), so the new one is written `*`.
    const { spliced, view } = open(text)
    newLine(view, '本文の段落です。')
    typeKeys(view, '- 新しい')
    assert.equal(saved(spliced, view), text.replace('本文の段落です。\n', '本文の段落です。\n\n* 新しい\n'))
  }
  {
    // 「[] 」 at the start of a list item: that item only.
    const { spliced, view } = open(text)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posAfter(view.state.doc, '二つめ') - 3)))
    typeKeys(view, '[] ')
    assert.equal(saved(spliced, view), text.replace('- 二つめ', '- [ ] 二つめ'))
  }
  {
    // 「```」 and 「---」 in front of words are words.
    const { spliced, view } = open(text)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posAfter(view.state.doc, '終わりの段落。') - 7)))
    typeKeys(view, '---')
    assert.equal(view.state.doc.lastChild!.type.name, 'paragraph')
    assert.equal(view.state.doc.lastChild!.textContent, '---終わりの段落。')
    saved(spliced, view)
  }
})

test('the table bar: a row is one line, a column one cell on each line, words typed into a new cell land in that cell', () => {
  const caretIn = (view: EditorView, words: string) => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, posAfter(view.state.doc, words))))
  const ROW = '| 問い合わせ | 42 | 51 | 広告を変えてから増えた |\n'
  {
    const { spliced, view } = open(MEETING)
    caretIn(view, '問い合わせ')
    assert.ok(editTable(view, 'addRow'))
    let text = saved(spliced, view)
    assert.deepEqual(changedLines(MEETING, text), { removed: 0, added: 1 })
    assert.equal(text, MEETING.replace(ROW, `${ROW}|  |  |  |  |\n`))
    // The caret is in the new row: words typed go into the cell of its column, written as `| words |`.
    view.dispatch(view.state.tr.insertText('商談', view.state.selection.from))
    text = saved(spliced, view)
    assert.equal(text, MEETING.replace(ROW, `${ROW}| 商談 |  |  |  |\n`))
    // Into the third cell of that row: the empty one before it is kept, so the words stay in their column.
    let third = -1
    let seen = 0
    view.state.doc.descendants((n, pos) => { if (third < 0 && n.type.name === 'table_cell' && n.textContent === '' && ++seen === 2) third = pos; return third < 0 })
    view.dispatch(view.state.tr.insertText('25', third + 2))
    assert.equal(saved(spliced, view), MEETING.replace(ROW, `${ROW}| 商談 |  | 25 |  |\n`))
    assert.ok(editTable(view, 'deleteRow'))
    assert.equal(saved(spliced, view), MEETING)
  }
  {
    const { spliced, view } = open(MEETING)
    caretIn(view, '10月')
    assert.equal(editTable(view, 'deleteRow'), false, 'the header row, even with rows under it')
    assert.ok(editTable(view, 'addColumn'))
    const text = saved(spliced, view)
    const rows = MEETING.split('\n').filter(l => l.startsWith('|')).length
    assert.deepEqual(changedLines(MEETING, text), { removed: rows, added: rows }, 'one cell on each of the table\'s lines (owner: accepted)')
    assert.ok(text.includes('| 項目 | 10月 |  | 11月（見込み） | メモ |\n|:-----|-----:|---|------:|------|\n'), 'no alignment for the new column')
    view.dispatch(view.state.tr.insertText('12月', view.state.selection.from))
    assert.ok(saved(spliced, view).includes('| 項目 | 10月 | 12月 | 11月（見込み） | メモ |\n'), 'the caret was in the new column')
    assert.ok(editTable(view, 'deleteColumn'))
    assert.equal(saved(spliced, view), MEETING)
  }
  {
    // The header row is never deleted (a Markdown table needs it), nor the last row under it (the editor
    // would only empty it), nor the last column.
    const { spliced, view } = open('| 一 |\n|---|\n| 二 |\n')
    caretIn(view, '一')
    assert.equal(editTable(view, 'deleteRow'), false)
    assert.equal(editTable(view, 'deleteColumn'), false)
    caretIn(view, '二')
    assert.equal(editTable(view, 'deleteRow'), false)
    assert.equal(saved(spliced, view), '| 一 |\n|---|\n| 二 |\n')
  }
})

test('a line typed under a block the editor writes otherwise (a `----` heading) leaves that block\'s bytes as they are', () => {
  const { spliced, view } = open(SKILL)
  newLine(view, '手順')
  view.dispatch(view.state.tr.insertText('新しい段落', view.state.selection.from))
  assert.equal(saved(spliced, view), SKILL.replace('手順\n----\n', '手順\n----\n\n新しい段落\n'))
})

test('the file\'s own bullet is used only for what is newly written: a typed character leaves every marker as it was', () => {
  for (const text of ['- 親\n  * 子\n', '+ 一\n\n  * 二\n', '- 一\n\n***\n\n二\n']) {
    const { spliced, view } = open(text)
    insertAfter(view, text.includes('親') ? '親' : '一', 'X')
    const written = saved(spliced, view)
    assert.deepEqual(changedLines(text, written), { removed: 1, added: 1 }, written)
  }
})

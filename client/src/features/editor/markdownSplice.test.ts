// Guards "editing a document in place never changes what was not edited" (files-and-editor.md
// "Editing a document in place"): the real Milkdown reader and writer, under jsdom, on fictional
// documents written the way people and the AI write them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import type { MarkdownCodec } from './markdownSplice'

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

const { SplicedDocument, splitFront } = await import('./markdownSplice')
const { makeMilkdown } = await import('./milkdownSurface')

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
})

test('a document the editor cannot hold is refused before anything can be written', () => {
  const reason = (r: ReturnType<typeof SplicedDocument.load>) => (r.ok ? 'loaded' : r.reason)
  assert.equal(reason(SplicedDocument.load('本文です[^1]。\n\n[^1]: 注の中身\n', md.codec)), 'unsupported')
  // A reader that drops text on reading (as an editor does with syntax it does not know).
  const dropping: MarkdownCodec = { ...md.codec, parse: s => md.codec.parse(s.replace('大事な一言', '')) }
  assert.equal(reason(SplicedDocument.load('前の段落\n\n大事な一言のある段落\n', dropping)), 'lossy')
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

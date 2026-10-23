// Performance baselines for #154 at the size of the largest real history
// (~8 MB, a 564-message conversation): an autosave blocks the main process
// only briefly (in-memory store, per-session serialisation cache, writes off
// the main thread), and the session list sent over IPC carries summaries,
// not message bodies. Behaviour is covered by tests/chat-history-store.test.ts
// and tests/chat-rendering.test.ts; these add the scale and the numbers.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatHistoryStore } from '../../electron/chat-history-store'
import type { ChatSession } from '../../shared/chat-history'
import { MESSAGE_WINDOW, windowStart } from '../../src/components/chat/messageWindow'
import Markdown from 'react-markdown'
import { chatMarkdownSafety } from '../../src/components/chat/chatMarkdownSafety'
import { splitMarkdownBlocks } from '../../src/components/chat/markdownBlocks'
import { budget, scratch, timeMs } from './perf'

const box = scratch('history')
after(() => box.cleanup())
const COMPANY = 'perf-company'
const T = '2026-10-01T00:00:00.000Z'

/** A markdown reply of about `bytes` bytes: headings, lists, a table, code. */
function reply(i: number, bytes: number): string {
  const block = [
    `## 検討結果 ${i}`,
    '',
    `会議の議事録をもとに、**要点**と次の手順を整理しました。詳しくは \`営業部/提案書.md\` を参照してください。`,
    '',
    '- 決定事項：見積もりを来週までに更新する',
    '- 宿題：顧客への確認事項をまとめる',
    '',
    '| 項目 | 担当 | 期限 |',
    '|---|---|---|',
    '| 見積もり | 田中 | 10/30 |',
    '',
    '```ts',
    `const total = items.reduce((sum, item) => sum + item.price * item.count, ${i})`,
    '```',
    '',
  ].join('\n')
  return block.repeat(Math.max(1, Math.round(bytes / Buffer.byteLength(block))))
}

function conversation(id: string, count: number, replyBytes: number): ChatSession {
  return {
    id, companyId: COMPANY, title: `相談 ${id}`, createdAt: T, updatedAt: T,
    messages: Array.from({ length: count }, (_, i) => i % 2 === 0
      ? { id: `${id}-m${i}`, role: 'user' as const, content: `質問 ${i}：先週の会議の内容をまとめてください。`, timestamp: T }
      : { id: `${id}-m${i}`, role: 'assistant' as const, content: reply(i, replyBytes), timestamp: T }),
  }
}

// 564 messages (~5.5 MB) + 100 smaller conversations (~2.5 MB).
const big = conversation('big', 564, 19_000)
const others = Array.from({ length: 100 }, (_, i) => conversation(`c${i}`, 10, 5_000))

test('perf #154: an autosave of an ~8 MB history returns at once; the list sent over IPC is summaries', async () => {
  const store = new ChatHistoryStore(path.join(box.dir, 'history'), { writeDelayMs: 0 })
  for (const s of [big, ...others]) store.save(COMPANY, s)
  await store.flush()
  const historyBytes = Buffer.byteLength(JSON.stringify(store.list(COMPANY)))
  assert.ok(historyBytes > 7_500_000, `history is ${historyBytes} bytes`)

  // The 4-second autosave of the open conversation: one more message.
  const current = store.get(COMPANY, 'big')!
  const next: ChatSession = { ...current, messages: [...current.messages, { id: 'big-new', role: 'user', content: '追加の質問', timestamp: T }] }
  // save() runs on the main process's thread; the file is written later,
  // asynchronously. A save that serialised or wrote the history itself would
  // take tens of milliseconds at this size.
  const save = await timeMs(() => store.save(COMPANY, next))
  assert.equal(save.value.status, 'saved')
  await store.flush()

  console.log(`[perf] history.size=${historyBytes} bytes`)
  budget('history.save.call', save.ms, 'ms', 20)
  budget('history.summaries.payload', Buffer.byteLength(JSON.stringify(store.summaries(COMPANY))), 'bytes', 500_000)
})

test('perf #154: opening the 564-message conversation renders only the latest window of markdown', async () => {
  const start = windowStart(big.messages, null)
  const window = big.messages.slice(start)
  assert.equal(window.length, MESSAGE_WINDOW)
  // Server-side rendering of the window, as a proxy for the renderer's first
  // paint: each reply split into blocks and parsed with the chat's markdown
  // settings, as MarkdownMessage does (Prism highlighting is left out — its
  // ESM build does not load under plain Node).
  const markdown = (text: string) => splitMarkdownBlocks(text).map((block, i) => React.createElement(Markdown, {
    key: i, remarkPlugins: [...chatMarkdownSafety.remarkPlugins], skipHtml: chatMarkdownSafety.skipHtml,
  }, block.text))
  renderToStaticMarkup(React.createElement('div', null, ...markdown(window[1].content))) // warm-up (module init, JIT)
  const { ms, value } = await timeMs(() => renderToStaticMarkup(React.createElement(React.Fragment, null,
    ...window.map(m => React.createElement('div', { key: m.id }, ...(m.role === 'assistant' ? markdown(m.content) : [m.content]))))))
  assert.ok(value.length > 0)
  budget('chat.openWindow.render', ms, 'ms', 6_000)
})

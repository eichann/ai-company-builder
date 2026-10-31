/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'

// Preview / measurement page for the tool-row rendering. It replays a
// synthetic turn shaped like the one that froze the chat (9 subagents, 902
// inner calls, 69 main-thread calls = 980 tools) and, like @ai-sdk/react,
// replaces the message with a structuredClone on every update.
//
// Results are written to window.__toolRowsResult. When a render-counting jsx
// runtime is aliased in (see the PR description), per-row render counts are
// collected in window.__acbRenderLog and checked against each row's finish tick.

type Part = UIMessage['parts'][number]
interface RenderLog { renders: Map<string, number[]> }
declare global {
  interface Window {
    __acbTick?: number
    __acbRenderLog?: RenderLog
    __toolRowsResult?: unknown
  }
}

const AGENTS = 9
const INNER = 902
const MAIN = 69

function buildEvents() {
  const events: Array<{ id: string; kind: 'start' | 'finish' | 'text'; part?: Part }> = []
  for (let a = 0; a < AGENTS; a++) {
    events.push({ id: `agent-${a}`, kind: 'start', part: { type: 'dynamic-tool', toolCallId: `agent-${a}`, toolName: 'Agent', state: 'input-available', input: { description: `${a + 1}章を精読して要約`, prompt: '…' }, callProviderMetadata: { 'claude-code': { parentToolCallId: null } } } as Part })
  }
  for (let i = 0; i < INNER; i++) {
    const id = `inner-${i}`
    events.push({ id, kind: 'start', part: { type: 'dynamic-tool', toolCallId: id, toolName: 'Read', state: 'input-available', input: { file_path: `/book/page-${i}.jpg` }, callProviderMetadata: { 'claude-code': { parentToolCallId: `agent-${i % AGENTS}` } } } as Part })
    events.push({ id, kind: 'finish' })
  }
  for (let a = 0; a < AGENTS; a++) events.push({ id: `agent-${a}`, kind: 'finish' })
  for (let i = 0; i < MAIN; i++) {
    if (i % 20 === 0) events.push({ id: `text-${i}`, kind: 'text', part: { type: 'text', text: `${i / 20 + 1}つ目の作業に入ります。` } })
    const id = `main-${i}`
    events.push({ id, kind: 'start', part: { type: 'dynamic-tool', toolCallId: id, toolName: 'Bash', state: 'input-available', input: { command: `wc -l notes/${i}.md` } } as Part })
    events.push({ id, kind: 'finish' })
  }
  return events
}

let push: (message: UIMessage) => void = () => {}

function Harness() {
  const [message, setMessage] = useState<UIMessage>({ id: 'm', role: 'assistant', parts: [] })
  push = setMessage
  return (
    <main className="min-h-screen bg-white text-gray-900 p-8">
      <p className="text-xs text-gray-500 mb-4">表示確認用の人工データ（980件のツール呼び出し）。本番の相談には接続しません。</p>
      <section id="message" className="max-w-2xl">
        <AssistantMessageParts parts={message.parts} isStreaming={true} markdown={false} />
      </section>
    </main>
  )
}

function run() {
  const events = buildEvents()
  const working: UIMessage = { id: 'm', role: 'assistant', parts: [] }
  const finishTick = new Map<string, number>()
  const started = performance.now()
  let maxRows = 0
  events.forEach((event, tick) => {
    window.__acbTick = tick
    if (event.part) working.parts.push(event.part)
    else {
      const part = working.parts.find(p => p.type === 'dynamic-tool' && p.toolCallId === event.id) as Extract<Part, { type: 'dynamic-tool' }>
      Object.assign(part, { state: 'output-available', output: event.id.startsWith('agent') ? '要約を書き出しました。' : ['[image: image/jpeg, 390KB]'] })
      finishTick.set(event.id, tick)
    }
    const snapshot = structuredClone(working)
    flushSync(() => push(snapshot))
    maxRows = Math.max(maxRows, document.querySelectorAll('#message button').length)
  })
  const elapsedMs = Math.round(performance.now() - started)

  const log = window.__acbRenderLog
  let rendersAfterFinish = 0
  let rowRenders = 0
  let rowsRendered = 0
  if (log) {
    for (const [id, ticks] of log.renders) {
      rowRenders += ticks.length
      rowsRendered++
      const done = finishTick.get(id)
      if (done !== undefined) rendersAfterFinish += ticks.filter(t => t > done).length
    }
  }
  window.__toolRowsResult = {
    updates: events.length,
    tools: AGENTS + INNER + MAIN,
    elapsedMs,
    buttonsInDom: document.querySelectorAll('#message button').length,
    maxButtonsInDom: maxRows,
    elementsInDom: document.querySelectorAll('#message *').length,
    ...(log ? { rowsRendered, rowRenders, rendersAfterFinish } : {}),
  }
}

createRoot(document.getElementById('root')!).render(<Harness />)
setTimeout(run, 100)

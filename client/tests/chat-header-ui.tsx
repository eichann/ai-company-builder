import { createRoot } from 'react-dom/client'
import { markAgentLogNoticeSeen } from '../src/lib/agentLogNotice'
import '../src/i18n'
import '../src/index.css'
import { ChatPanel } from '../src/components/chat/ChatPanel'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { RATE_LIMITS_PART_TYPE, type RateLimitSnapshot } from '../shared/rate-limits'
import { AGENT_PROGRESS_PART_TYPE } from '../shared/agent-progress'
import { CHOICE_PART_TYPE, parseChoiceQuestions, type ChoicePromptRecord } from '../shared/choice-prompt'
import { STEER_PART_TYPE, type SteerStatus } from '../shared/steer'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../shared/agent-interaction'
import type { CodexStatus } from '../shared/agent'
import type { ChatSaveReceipt, ChatSession } from '../shared/chat-history'
import { emitter, installElectronAPI } from './ui/fixtures/electron-api'

// Preview page for the chat header's usage meter, the message gutter and a
// running subagent's progress line: the real ChatPanel with a mocked
// electronAPI and a mocked chat server (fetch). Send any message (⌘+Enter) to
// start a turn that streams a subagent and stays running. Synthetic data only.
//   ?theme=dark   dark mode
//   ?limits=ok|warn|rejected|unknown   which usage snapshot the server reports
//   ?agent=codex  Codex instead of Claude Code
//   ?history=long  two restored tabs with a 240-message conversation (windowed
//                  rendering, 「以前のメッセージを表示」, code highlighting)
//   ?history=edit  one restored conversation whose first message references
//                  files (editing and resending a message)
//   ?turn=manual   the reply streams only what window.__acbChat sends (the
//                  Playwright UI tests drive it: tests/ui/chat-panel.spec.ts)
//   ?auth=none     Claude Code is not signed in: the setup screen (設定を開く)
//   ?storage=keep  keep localStorage across reloads (remembered folded groups)

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const agent = params.get('agent') === 'codex' ? 'codex' : 'claude-code'
const scenario = params.get('limits') || 'ok'
// ?storage=keep: a reload keeps what the page remembered (a new Playwright page starts empty anyway).
if (params.get('storage') !== 'keep') { try { localStorage.clear() } catch { /* preview only */ } }
// The one-time AI action log notice only with ?notice=1 (it would cover the chat in the other specs).
if (params.get('notice') !== '1') markAgentLogNoticeSeen('preview-user')
const longHistory = params.get('history') === 'long'
const editHistory = params.get('history') === 'edit'
const signedOut = params.get('auth') === 'none'

const CODE_SAMPLES: Array<[string, string]> = [
  ['ts', 'interface Quote { id: string; total: number }\nexport const sum = (qs: Quote[]) => qs.reduce((n, q) => n + q.total, 0)'],
  ['python', 'def total(rows):\n    return sum(r["price"] * r["qty"] for r in rows)'],
  ['bash', 'cd 営業部/見積書 && ls -la | grep 2026'],
  ['json', '{ "client": "A社", "items": [{ "name": "保守", "price": 12000 }] }'],
  ['yaml', 'quote:\n  client: A社\n  due: 2026-11-30'],
  ['sql', 'SELECT client, SUM(total) FROM quotes GROUP BY client;'],
  ['diff', '- 単価: 10,000円\n+ 単価: 12,000円'],
  ['html', '<table><tr><td>保守</td><td>12,000円</td></tr></table>'],
  ['css', '.quote { font-feature-settings: "palt"; color: #333; }'],
  ['tsx', 'export function Total({ value }: { value: number }) { return <strong>{value.toLocaleString()}円</strong> }'],
  ['go', 'func Total(xs []int) (n int) { for _, x := range xs { n += x }; return }'],
  ['brainfuck', '++++[>++++<-]>.'],
]
function longSession() {
  const messages = []
  for (let i = 0; i < 120; i++) {
    const [lang, code] = CODE_SAMPLES[i % CODE_SAMPLES.length]
    messages.push({ id: `u${i}`, role: 'user', content: `質問${i + 1}: ${lang} の例を見せてください`, timestamp: new Date(now - (240 - i * 2) * 60_000).toISOString() })
    messages.push({ id: `a${i}`, role: 'assistant', timestamp: new Date(now - (239 - i * 2) * 60_000).toISOString(),
      content: `## 回答 ${i + 1}\n\n${lang} の例です。\n\n- 要点一\n- 要点二\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n| 項目 | 金額 |\n|---|---|\n| 保守 | 12,000円 |\n\n以上です。` })
  }
  return { id: 'long-history', companyId: 'preview-company', title: '長い相談（240件）', messages, createdAt: new Date(now - 300 * 60_000).toISOString(), updatedAt: new Date(now).toISOString(), revision: 1 }
}
function editSession() {
  const at = (n: number) => new Date(now - n * 60_000).toISOString()
  return { id: 'edit-history', companyId: 'preview-company', title: '見積書の相談', createdAt: at(10), updatedAt: at(6), revision: 1, messages: [
    { id: 'eu1', role: 'user', content: '見積書を作って', timestamp: at(10), referenceFiles: ['営業部/価格表/2026-10改定.pdf'] },
    { id: 'ea1', role: 'assistant', content: '見積書のたたき台を作りました。', timestamp: at(9) },
    { id: 'eu2', role: 'user', content: '単価を見直して', timestamp: at(8) },
    { id: 'ea2', role: 'assistant', content: '単価を10月版にしました。', timestamp: at(7) },
  ] }
}
if (editHistory) {
  try { localStorage.setItem('chatTabs:preview-company', JSON.stringify({ tabs: [{ title: '見積書の相談', sessionId: 'edit-history' }], activeIndex: 0 })) } catch { /* preview only */ }
}
if (longHistory) {
  try { localStorage.setItem('chatTabs:preview-company', JSON.stringify({ tabs: [{ title: '長い相談（240件）', sessionId: 'long-history' }, { title: '別の相談', sessionId: null }], activeIndex: 0 })) } catch { /* preview only */ }
}

const now = Date.now()
const minutes = (n: number) => now + n * 60_000
const snapshots: Record<string, RateLimitSnapshot | null> = {
  ok: { provider: 'claude-code', status: 'allowed', updatedAt: now, windows: [
    { id: 'five_hour', label: '5時間', usedPercent: 24, resetsAt: minutes(130) },
    { id: 'seven_day', label: '1週間', usedPercent: 66, resetsAt: minutes(3 * 1440 + 300) },
  ] },
  warn: { provider: 'claude-code', status: 'warning',updatedAt: now, windows: [
    { id: 'five_hour', label: '5時間', usedPercent: 82, resetsAt: minutes(45) },
    { id: 'seven_day', label: '1週間', usedPercent: 71, resetsAt: minutes(3 * 1440 + 300) },
  ] },
  rejected: { provider: 'claude-code', status: 'rejected', updatedAt: now, windows: [
    { id: 'five_hour', label: '5時間', usedPercent: 100, resetsAt: minutes(38) },
    { id: 'seven_day', label: '1週間', usedPercent: 93, resetsAt: minutes(3 * 1440 + 300) },
  ] },
  unknown: null,
}
let snapshot = snapshots[scenario] ?? null
if (snapshot && agent === 'codex') snapshot = { ...snapshot, provider: 'codex', windows: [{ id: 'codex:10080', label: '1週間', usedPercent: 60, resetsAt: minutes(4 * 1440) }] }

const PORT = 1
const noop = () => {}
const interactions = emitter<AgentInteractionRequest>()
const interactionsClosed = emitter<AgentInteractionRequest>()
installElectronAPI({
  getChatServerInfo: async () => ({ port: PORT, authToken: 'preview' }),
  getClaudeCodeStatus: async () => signedOut
    ? ({ available: false, authenticated: false, cliPath: null, version: null, error: 'Claude Code にログインしていません', checkedAt: now }) as never
    : ({ available: true, authenticated: true, cliPath: '/usr/local/bin/claude', version: '2.1.304', error: null, checkedAt: now }),
  getAuthMode: async () => agent,
  hasApiKey: async () => false,
  getCodexStatus: async () => ({ available: true, authenticated: true, models: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5-Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true }] }) as CodexStatus,
  getChatSessionSummaries: async () => longHistory ? [{ id: 'long-history', companyId: 'preview-company', title: '長い相談（240件）', messageCount: 240, preview: '以上です。', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }] as never
    : editHistory ? [{ id: 'edit-history', companyId: 'preview-company', title: '見積書の相談', messageCount: 4, preview: '単価を10月版にしました。', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }] as never : [],
  searchChatSessions: async () => [],
  getChatSession: async (_company: string, id: string) => longHistory && id === 'long-history' ? longSession() as ChatSession
    : editHistory && id === 'edit-history' ? editSession() as ChatSession : null,
  getAgentInteractions: async () => [],
  onAgentInteraction: interactions.subscribe,
  onAgentInteractionClosed: interactionsClosed.subscribe,
  respondAgentInteraction: async (id, response) => { control.answered(id, response); return true },
  getPermissionMode: async () => 'auto',
  getHandoff: async () => ({ status: 'waiting', message: '', canUpdate: false, pendingTurns: 0 }),
  saveChatSession: async () => ({ status: 'saved', revision: 1 }) as ChatSaveReceipt,
  // The synchronous save before a send, recorded in order with the requests.
  flushChatSession: (_company: string, session: ChatSession) => {
    if (manual) control.requests.push({ path: 'flushChatSession', body: JSON.parse(JSON.stringify(session)) })
    return { status: 'saved', revision: 1 } as ChatSaveReceipt
  },
  voiceInput: {
    capabilities: async () => ({ available: false, reason: 'プレビューでは音声入力を使えません', retryable: false }),
    devices: async () => ({ ok: true, devices: [] }),
    start: async () => {}, stop: async () => {}, cancel: async () => {},
    onEvent: () => noop, onLevel: () => noop, onState: () => noop,
  } as never,
})

// --- Mocked chat server ------------------------------------------------------
const encoder = new TextEncoder()
const sse = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const AGENT_ID = 'toolu_preview_agent'

function chatStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: unknown) => controller.enqueue(sse(chunk))
      send({ type: 'start', messageId: 'assistant-preview' })
      send({ type: 'start-step' })
      send({ type: 'text-start', id: 't1' })
      send({ type: 'text-delta', id: 't1', delta: '見積書の作り方を確認するため、営業部のフォルダにある過去の見積書と価格表を調べます。サブエージェントに資料の読み込みを任せて、その結果をもとに新しい見積書のたたき台を作成します。' })
      send({ type: 'text-end', id: 't1' })
      send({ type: 'tool-input-available', toolCallId: AGENT_ID, toolName: 'Agent', dynamic: true, providerExecuted: true,
        input: { description: '過去の見積書と価格表を調べる', subagent_type: 'general-purpose', prompt: '…' },
        providerMetadata: { 'claude-code': { parentToolCallId: null } } })
      const inner = [
        { id: 'r1', toolName: 'Glob', input: { path: '営業部/見積書/**/*.xlsx' } },
        { id: 'r2', toolName: 'Read', input: { path: '営業部/見積書/2026-09_A社.xlsx' } },
        { id: 'r3', toolName: 'Read', input: { path: '営業部/価格表/2026-10改定.pdf' } },
      ]
      for (const call of inner) {
        send({ type: 'tool-input-available', toolCallId: call.id, toolName: call.toolName, dynamic: true, providerExecuted: true, input: call.input, providerMetadata: { 'claude-code': { parentToolCallId: AGENT_ID } } })
        send({ type: 'tool-output-available', toolCallId: call.id, dynamic: true, providerExecuted: true, output: 'ok' })
      }
      send({ type: 'tool-input-available', toolCallId: 'r4', toolName: 'Read', dynamic: true, providerExecuted: true, input: { path: '営業部/見積書/2026-08_B社.xlsx' }, providerMetadata: { 'claude-code': { parentToolCallId: AGENT_ID } } })
      if (snapshot) send({ type: RATE_LIMITS_PART_TYPE, data: { ...snapshot, updatedAt: Date.now() }, transient: true })
      await sleep(300)
      if (agent === 'claude-code') send({ type: AGENT_PROGRESS_PART_TYPE, data: { toolCallId: AGENT_ID, summary: '価格表の10月改定分と過去の見積書の単価を照らし合わせています' }, transient: true })
      // Stays open: the subagent keeps running for the screenshot.
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}

// ?turn=manual: the test is the chat server. Each /api/chat request opens a
// stream that stays open until control.finish(); /api/steer answers with
// control.steerStatus (and, like the chat server, puts a delivered
// instruction into the running reply); /api/prompt-suggestion answers with
// control.suggestion; control.ask() shows a choice card, and answering it
// puts the record into the reply like the chat server's chunk injector.
const manual = params.get('turn') === 'manual'
let current: ReadableStreamDefaultController<Uint8Array> | null = null
let currentSessionId: string | null = null
let steerCount = 0
const control = {
  requests: [] as Array<{ path: string; body: Record<string, unknown> | null }>,
  steerStatus: 'delivered' as SteerStatus,
  suggestion: null as string | null,
  open: () => current !== null,
  send(chunk: unknown) { current?.enqueue(sse(chunk)) },
  text(id: string, delta: string) { control.send({ type: 'text-delta', id, delta }) },
  finish() {
    control.send({ type: 'finish-step' })
    control.send({ type: 'finish', finishReason: 'stop' })
    current?.close()
    current = null
  },
  ask(toolCallId = 'toolu_ask') {
    const questions = parseChoiceQuestions([{ question: '提案書はどの形式で作成しますか？', header: '出力形式', multiSelect: false, options: [
      { label: 'PowerPoint', description: '営業がそのまま編集・投影できます' },
      { label: 'PDF', description: '配布用。レイアウトが崩れません' },
    ] }])
    pendingQuestions.set(toolCallId, questions)
    interactions.emit({ id: `ask-${toolCallId}`, appSessionId: currentSessionId ?? '', kind: 'choices', agent: 'claude-code', toolCallId, questions })
  },
  answers: [] as Array<{ id: string; response: AgentInteractionResponse }>,
  /** Files the chat asked the main screen to open (a review request's files). */
  opened: [] as string[],
  answered(id: string, response: AgentInteractionResponse) {
    control.answers.push({ id, response })
    const toolCallId = id.replace(/^ask-/, '')
    const questions = pendingQuestions.get(toolCallId) ?? []
    const record: ChoicePromptRecord = 'choices' in response ? { id: toolCallId, questions, answers: response.choices } : { id: toolCallId, questions, cancelled: 'cancelled' }
    control.send({ type: CHOICE_PART_TYPE, id: `choice-${toolCallId}`, data: record })
  },
}
const pendingQuestions = new Map<string, ReturnType<typeof parseChoiceQuestions>>()
Object.assign(window, { __acbChat: control })

function manualStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      current = controller
      // 停止 aborts the request, as a real fetch would.
      signal?.addEventListener('abort', () => {
        if (current === controller) current = null
        try { controller.error(new DOMException('The user aborted a request.', 'AbortError')) } catch { /* already closed */ }
      })
      control.send({ type: 'start', messageId: `assistant-${control.requests.length}` })
      control.send({ type: 'start-step' })
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
}

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) return realFetch(input, init)
  const path = new URL(url).pathname
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
  if (manual) control.requests.push({ path, body })
  if (manual && path === '/api/chat') {
    currentSessionId = typeof body?.appSessionId === 'string' ? body.appSessionId : null
    return manualStream(init?.signal)
  }
  if (manual && path === '/api/steer') {
    const id = `s${++steerCount}`
    if (control.steerStatus !== 'unavailable') control.send({ type: STEER_PART_TYPE, id: `steer-${id}`, data: { id, text: body?.text } })
    return json({ status: control.steerStatus, ...(control.steerStatus !== 'unavailable' ? { id } : {}) })
  }
  if (path.startsWith('/api/prompt-suggestion/')) return json({ suggestion: control.suggestion })
  if (path === '/api/rate-limits') return json({ rateLimits: snapshot && params.get('preload') !== '0' ? snapshot : null })
  if (path === '/api/chat') return chatStream()
  if (path === '/api/generate-title') return json({ title: '見積書のたたき台' })
  return json({})
}

useAuthStore.setState({ user: { id: 'preview-user', email: 'member@example.com', name: '山田 花子' } as never })
useAppStore.setState({ currentCompany: { id: 'preview-company', name: 'デモ株式会社', rootPath: '/tmp/acb-preview', departments: [], createdAt: new Date() } })

const width = Number(params.get('width')) || 760
createRoot(document.getElementById('root')!).render(
  <div className="h-screen flex justify-end bg-gray-50 dark:bg-zinc-950">
    <div style={{ width }} className="h-full border-l border-gray-200 dark:border-zinc-800">
      <ChatPanel departmentPath="/tmp/acb-preview" onOpenFile={path => { control.opened.push(path) }} />
    </div>
  </div>,
)

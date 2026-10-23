/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { ChatPanel } from '../src/components/chat/ChatPanel'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { RATE_LIMITS_PART_TYPE, type RateLimitSnapshot } from '../shared/rate-limits'
import { AGENT_PROGRESS_PART_TYPE } from '../shared/agent-progress'

// Preview page for the chat header's usage meter, the message gutter and a
// running subagent's progress line: the real ChatPanel with a mocked
// electronAPI and a mocked chat server (fetch). Send any message (⌘+Enter) to
// start a turn that streams a subagent and stays running. Synthetic data only.
//   ?theme=dark   dark mode
//   ?limits=ok|warn|rejected|unknown   which usage snapshot the server reports
//   ?agent=codex  Codex instead of Claude Code
//   ?history=long  two restored tabs with a 240-message conversation (windowed
//                  rendering, 「以前のメッセージを表示」, code highlighting)

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const agent = params.get('agent') === 'codex' ? 'codex' : 'claude-code'
const scenario = params.get('limits') || 'ok'
try { localStorage.clear() } catch { /* preview only */ }
const longHistory = params.get('history') === 'long'

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
const api: Record<string, unknown> = {
  getChatServerInfo: async () => ({ port: PORT, authToken: 'preview' }),
  getClaudeCodeStatus: async () => ({ available: true, authenticated: true }),
  getAuthMode: async () => agent,
  hasApiKey: async () => false,
  getCodexStatus: async () => ({ available: true, authenticated: true, models: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5-Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true }] }),
  getChatSessionSummaries: async () => longHistory ? [{ id: 'long-history', companyId: 'preview-company', title: '長い相談（240件）', messageCount: 240, preview: '以上です。', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }] : [],
  searchChatSessions: async () => [],
  getChatSession: async (_company: string, id: string) => longHistory && id === 'long-history' ? longSession() : null,
  getAgentInteractions: async () => [],
  getPermissionMode: async () => 'auto',
  getHandoff: async () => ({ status: 'waiting', message: '', canUpdate: false, pendingTurns: 0 }),
  saveChatSession: async () => ({ status: 'saved', revision: 1 }),
  flushChatSession: () => ({ status: 'saved', revision: 1 }),
  voiceInput: {
    capabilities: async () => ({ available: false, reason: 'プレビューでは音声入力を使えません', retryable: false }),
    devices: async () => ({ devices: [] }),
    start: async () => {}, stop: async () => {}, cancel: async () => {},
    onEvent: () => noop, onLevel: () => noop, onState: () => noop,
  },
}
;(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(api, {
  get(target, name: string) {
    if (name in target) return target[name]
    if (name.startsWith('on')) return () => noop
    return async () => undefined
  },
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

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) return realFetch(input, init)
  const path = new URL(url).pathname
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
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
      <ChatPanel departmentPath="/tmp/acb-preview" />
    </div>
  </div>,
)

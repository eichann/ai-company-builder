import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { ChatWindowApp } from '../src/app/ChatWindowApp'
import { markAgentLogNoticeSeen } from '../src/lib/agentLogNotice'
import { useAppStore } from '../src/stores/appStore'
import type { ChatSaveReceipt, ChatSession } from '../shared/chat-history'
import type { ChatWindowStatus } from '../shared/chat-windows'
import { installElectronAPI } from './ui/fixtures/electron-api'

// Preview page for a consultation's own window (「別ウィンドウで開く」,
// src/app/ChatWindowApp.tsx, `?window=chat` in the app): the real chat of one
// consultation with a mocked electronAPI and chat server. Synthetic data only.
//   ?theme=dark     dark mode
//   ?context=none   main has no consultation for this window
//   ?review=1       the last reply asks for a review of two files (the second one main refuses)

const params = new URLSearchParams(location.search)
try { localStorage.clear() } catch { /* preview only */ }
useAppStore.setState({ theme: params.get('theme') === 'dark' ? 'dark' : 'light' })
markAgentLogNoticeSeen('preview-user')
const now = Date.now()
const at = (n: number) => new Date(now - n * 60_000).toISOString()
const session = { id: 'edit-history', companyId: 'preview-company', title: '見積書の相談', createdAt: at(10), updatedAt: at(6), revision: 1, messages: [
  { id: 'eu1', role: 'user', content: '見積書を作って', timestamp: at(10) },
  { id: 'ea1', role: 'assistant', content: '見積書のたたき台を作りました。', timestamp: at(9),
    ...(params.get('review') ? { reviewRequests: [{ id: 'r1', title: '見積書のたたき台', files: ['営業部/見積/たたき台.md', '営業部/見積/古い版.md'], points: [] }] } : {}) },
] } as ChatSession

const reported: ChatWindowStatus[] = []
const openedInMain: string[] = []
Object.assign(window, { __acbWindow: { reported, openedInMain } })

installElectronAPI({
  getChatWindowContext: async () => params.get('context') === 'none' ? null
    : { sessionId: 'edit-history', companyId: 'preview-company', companyName: 'デモ株式会社', rootPath: '/tmp/acb-preview', title: '見積書の相談' },
  reportChatWindowStatus: async status => { reported.push(status); return true },
  openFileInMainWindow: async filePath => {
    openedInMain.push(filePath)
    return filePath.endsWith('古い版.md') ? { ok: false, error: 'このファイルが見つからないため、開けませんでした。' } : { ok: true }
  },
  getChatServerInfo: async () => ({ port: 1, authToken: 'preview' }),
  getClaudeCodeStatus: async () => ({ available: true, authenticated: true, cliPath: '/usr/local/bin/claude', version: '2.1.304', error: null, checkedAt: now }),
  getAuthMode: async () => 'claude-code',
  hasApiKey: async () => false,
  getChatSessionSummaries: async () => [],
  searchChatSessions: async () => [],
  getChatSession: async (_company: string, id: string) => id === session.id ? session : null,
  getAgentInteractions: async () => [],
  getPermissionMode: async () => 'auto',
  getHandoff: async () => ({ status: 'waiting', message: '', canUpdate: false, pendingTurns: 0 }),
  saveChatSession: async () => ({ status: 'saved', revision: 1 }) as ChatSaveReceipt,
  flushChatSession: () => ({ status: 'saved', revision: 1 }) as ChatSaveReceipt,
  voiceInput: {
    capabilities: async () => ({ available: false, reason: 'プレビューでは音声入力を使えません', retryable: false }),
    devices: async () => ({ ok: true, devices: [] }),
    start: async () => {}, stop: async () => {}, cancel: async () => {},
    onEvent: () => () => {},
  } as never,
})

// The chat server: a reply that starts and stays open (the AI is working).
const encoder = new TextEncoder()
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('http://127.0.0.1:1/')) return realFetch(input, init)
  const path = new URL(url).pathname
  if (path === '/api/chat') {
    const chunks = [{ type: 'start', messageId: 'a1' }, { type: 'start-step' }, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: '確認します。' }]
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
    } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } })
  }
  return new Response(JSON.stringify(path === '/api/rate-limits' ? { rateLimits: null } : {}), { headers: { 'content-type': 'application/json' } })
}

createRoot(document.getElementById('root')!).render(<div className="h-screen"><ChatWindowApp /></div>)

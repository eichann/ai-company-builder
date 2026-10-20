import type { AuthMode } from './agent'
export interface HandoffView {
  status: 'waiting' | 'queued' | 'running' | 'saved' | 'error' | 'unsupported'
  markdown?: string
  updatedAt?: string
  provider?: AuthMode
  message: string
  canUpdate: boolean
  pendingTurns: number
  metrics?: { totalMs: number; inputTokens?: number; outputTokens?: number }
}
export interface HandoffCompletion {
  messageId: string
  content: string
  provider: AuthMode
}

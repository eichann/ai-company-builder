import type { AuthMode } from './agent'
export interface HandoffRecovery { status: 'recovering' | 'recovered' | 'error'; at: string; usedMemo: boolean }
export interface HandoffView {
  recovery?: HandoffRecovery
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

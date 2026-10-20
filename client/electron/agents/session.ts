import type { UIMessage } from 'ai'
import type { AgentSession, AuthMode } from '../../shared/agent'

export function resumeSession(candidate: AgentSession | null | undefined, providerId: AuthMode, modelId?: string) {
  return candidate?.providerId === providerId && (!candidate.modelId || candidate.modelId === modelId)
    ? candidate.id : undefined
}

/** Native tool/reasoning records are not portable between agent runtimes. */
export function agentInputMessages(messages: UIMessage[], resumeId?: string): UIMessage[] {
  if (resumeId) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    if (lastUser) return [{ ...lastUser, parts: lastUser.parts.filter(p => p.type === 'text' || p.type === 'file') }]
  }
  const portable = messages.map(m => ({ ...m, parts: m.parts.filter(p => p.type === 'text' || p.type === 'file') })).filter(m => m.parts.length)
  const textLength = portable.reduce((n, m) => n + m.parts.reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : 0), 0), 0)
  if (textLength > 160_000) throw new Error('AIを切り替えるには相談の履歴が長すぎます。必要な内容をまとめて新しい相談を開始してください。')
  return portable
}

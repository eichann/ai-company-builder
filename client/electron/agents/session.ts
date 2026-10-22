import type { UIMessage } from 'ai'
import type { AgentSession, AuthMode } from '../../shared/agent'
import { CHOICE_PART_TYPE, choiceAnswerText, choiceCancelLabel, readChoiceRecord } from '../../shared/choice-prompt'

type Part = UIMessage['parts'][number]

/** A choice prompt's outcome as text, so another agent (or a fresh session) sees what the member chose. */
function portableChoice(part: Part): Part | undefined {
  if (part.type !== CHOICE_PART_TYPE) return undefined
  const record = readChoiceRecord((part as { data?: unknown }).data)
  if (!record) return undefined
  const lines = record.questions.map((q, i) => `- ${q.question} → ${record.answers ? choiceAnswerText(record.answers[i]) : `（${choiceCancelLabel(record.cancelled ?? 'cancelled')}）`}`)
  return { type: 'text', text: `\n[選択肢の質問とユーザーの回答]\n${lines.join('\n')}\n` }
}

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
  const portable = messages.map(m => ({ ...m, parts: m.parts.flatMap(p => p.type === 'text' || p.type === 'file' ? [p] : (m.role === 'assistant' ? [portableChoice(p)].filter((x): x is Part => !!x) : [])) })).filter(m => m.parts.length)
  const textLength = portable.reduce((n, m) => n + m.parts.reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : 0), 0), 0)
  if (textLength > 160_000) throw new Error('AIを切り替えるには相談の履歴が長すぎます。必要な内容をまとめて新しい相談を開始してください。')
  return portable
}

import type { ChoiceAnswer, ChoiceCancelReason, ChoiceQuestion } from './choice-prompt'

export interface AgentQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: { label: string; description: string }[] | null
}
export type AgentInteraction = { kind: 'questions'; questions: AgentQuestion[] } | {
  kind: 'permissions'; reason: string; cwd: string; entries: { label: string; access: string }[]; network: boolean; supported: boolean
} | {
  /** A choice prompt (choice-prompt.ts): Claude Code's AskUserQuestion or Codex's ask_user. */
  kind: 'choices'; agent: 'claude-code' | 'codex'; toolCallId?: string; questions: ChoiceQuestion[]
}
export type AgentInteractionRequest = AgentInteraction & { id: string; appSessionId: string }
export type AgentInteractionResponse =
  | { approved: boolean }
  | { answers: Record<string, string> }
  | { choices: ChoiceAnswer[] }
  /** `reason` is set by the broker (timeout, turn stopped); a member's cancel has none. */
  | { cancelled: true; reason?: ChoiceCancelReason }

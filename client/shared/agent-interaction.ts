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
}
export type AgentInteractionRequest = AgentInteraction & { id: string; appSessionId: string }
export type AgentInteractionResponse = { approved: boolean } | { answers: Record<string, string> } | { cancelled: true }

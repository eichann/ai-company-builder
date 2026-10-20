export type AuthMode = 'claude-code' | 'codex' | 'api-key'
export interface AgentSession {
  providerId: AuthMode
  id: string
  modelId?: string
}
export interface CodexModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string
  isDefault: boolean
}
export interface CodexStatus {
  available: boolean
  authenticated: boolean
  models: CodexModel[]
  error?: string
}

/**
 * The member's sign-in choice = the agent registry's ids (shared/agents/registry.ts
 * `AgentId`, which must list exactly these). Named here so the IPC contract keeps its type name.
 */
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
  unsupported?: boolean
  available: boolean
  authenticated: boolean
  models: CodexModel[]
  error?: string
}

export const CODEX_LOGIN_HELP = 'Codexに接続できない場合は、ターミナルを開いて codex login を実行し、ChatGPTアカウントでログインしてから接続を再確認してください。'
export const CODEX_WINDOWS_UNSUPPORTED = 'Windows版ACBでは、現在Codexによる相談に対応していません。Claude CodeまたはAPIモードを選択してください。'

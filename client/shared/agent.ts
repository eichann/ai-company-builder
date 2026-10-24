import type { AgentId } from './agents/registry'

/** The member's sign-in choice = an agent registry id (shared/agents/registry.ts). */
export type AuthMode = AgentId
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

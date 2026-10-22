export interface VoiceDevice { id: string; name: string; isDefault: boolean }
export interface VoiceCapabilities {
  available: boolean
  reason?: string
  // Unavailable for a reason that can clear while the app runs (probe timed
  // out, helper failed, Japanese model not installed yet): the chat input
  // offers 「もう一度確認」. Absent for permanent reasons (not macOS, macOS < 26,
  // helper not bundled), where a retry could only repeat the same answer.
  retryable?: boolean
}
// `timeout` and `failed` are reported separately so the UI can tell the user
// that the Mac was slow rather than that something is broken.
export type VoiceDeviceList = { ok: true; devices: VoiceDevice[] } | { ok: false; error: 'timeout' | 'failed' }
export type VoiceEvent = { requestId: string } & (
  | { type: 'listening'; deviceName?: string }
  | { type: 'level'; level: number; clipping: boolean }
  | { type: 'finalizing' | 'polishing' }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; rawText?: string }
)
import type { VoicePromptSettings } from './voice-prompt'
export interface VoiceInputAPI {
  capabilities: () => Promise<VoiceCapabilities>
  devices: () => Promise<VoiceDeviceList>
  start: (requestId: string, deviceId?: string) => Promise<void>
  stop: (requestId: string) => Promise<void>
  cancel: (requestId: string) => Promise<void>
  onEvent: (callback: (event: VoiceEvent) => void) => () => void
  /** The member's 「整え方の指示」 (this PC only). */
  getPrompt: () => Promise<VoicePromptSettings>
  /** Saves edited instructions (at most 8,000 characters); rejects with a member-facing message. */
  setPrompt: (instructions: string) => Promise<VoicePromptSettings>
  resetPrompt: () => Promise<VoicePromptSettings>
}

export interface VoiceCapabilities { available: boolean; reason?: string }
export type VoiceEvent = { requestId: string } & (
  | { type: 'listening' | 'finalizing' | 'polishing' }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; rawText?: string }
)
export interface VoiceInputAPI {
  capabilities: () => Promise<VoiceCapabilities>
  start: (requestId: string) => Promise<void>
  stop: (requestId: string) => Promise<void>
  cancel: (requestId: string) => Promise<void>
  onEvent: (callback: (event: VoiceEvent) => void) => () => void
}

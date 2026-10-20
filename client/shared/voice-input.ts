export interface VoiceDevice { id: string; name: string; isDefault: boolean }
export interface VoiceCapabilities { available: boolean; reason?: string }
export type VoiceEvent = { requestId: string } & (
  | { type: 'listening'; deviceName?: string }
  | { type: 'level'; level: number; clipping: boolean }
  | { type: 'finalizing' | 'polishing' }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; rawText?: string }
)
export interface VoiceInputAPI {
  capabilities: () => Promise<VoiceCapabilities>
  devices: () => Promise<VoiceDevice[]>
  start: (requestId: string, deviceId?: string) => Promise<void>
  stop: (requestId: string) => Promise<void>
  cancel: (requestId: string) => Promise<void>
  onEvent: (callback: (event: VoiceEvent) => void) => () => void
}

import type { VoiceCapabilities, VoiceEvent } from '../shared/voice-input'
export type RecognitionEvent = { type: string; text?: string; message?: string; deviceName?: string; level?: number; clipping?: boolean }
export interface SpeechRecognitionProvider {
  capabilities(): Promise<VoiceCapabilities>
  start(onEvent: (event: RecognitionEvent) => void, deviceId?: string): { stop(): void; cancel(): void }
}
type Session = { id: string; abort: AbortController; recognition?: ReturnType<SpeechRecognitionProvider['start']>; timer?: ReturnType<typeof setTimeout>; phase: string }
type VoicePayload = VoiceEvent extends infer E ? E extends VoiceEvent ? Omit<E, 'requestId'> : never : never

// One coordinator per renderer owner; recognition/polishing results are fenced by session identity.
export class VoiceInputSession {
  private active?: Session
  constructor(
    private provider: SpeechRecognitionProvider,
    private permit: () => Promise<boolean>,
    private polish: (text: string, signal: AbortSignal) => Promise<string>,
    private emit: (event: VoiceEvent) => void,
  ) {}
  get busy() { return Boolean(this.active) }
  cancel(id?: string) {
    if (id && this.active?.id !== id) return
    const old = this.active
    this.active = undefined
    if (old) { clearTimeout(old.timer); old.abort.abort(); old.recognition?.cancel() }
  }
  async start(id: string, deviceId?: string, polish = this.polish) {
    if (this.active) throw new Error('音声入力が既に動作中です')
    const session: Session = { id, abort: new AbortController(), phase: 'preparing' }
    this.active = session
    const send = (event: VoicePayload) => { if (this.active === session) this.emit({ ...event, requestId: id }) }
    const fail = (message: string, rawText?: string) => {
      if (this.active !== session) return
      send({ type: 'error', message, rawText }); this.cancel()
    }
    session.timer = setTimeout(() => fail('音声入力の準備がタイムアウトしました'), 60_000)
    try {
      const caps = await this.provider.capabilities()
      if (this.active !== session) return
      if (!caps.available) throw new Error(caps.reason)
      if (!await this.permit()) throw new Error('マイクの使用を許可してください')
      if (this.active !== session) return
      const recognition = this.provider.start(data => {
        if (this.active !== session) return
        if (data.type === 'listening' && session.phase === 'preparing') {
          session.phase = 'listening'; clearTimeout(session.timer)
          session.timer = setTimeout(() => this.stop(id), 120_000)
          send({ type: 'listening', deviceName: data.deviceName })
        } else if (data.type === 'level' && session.phase === 'listening') {
          if (typeof data.level === 'number' && Number.isFinite(data.level)) send({ type: 'level', level: Math.max(0, Math.min(1, data.level)), clipping: data.clipping === true })
        } else if (data.type === 'error') fail(data.message ?? '音声認識に失敗しました')
        else if (data.type === 'result' && session.phase !== 'polishing') {
          const rawText = typeof data.text === 'string' ? data.text.trim() : ''
          clearTimeout(session.timer)
          if (!rawText) { fail('音声を聞き取れませんでした'); return }
          session.phase = 'polishing'; send({ type: 'polishing' })
          void polish(rawText, session.abort.signal).then(text => {
            if (this.active !== session) return
            send({ type: 'result', text }); this.cancel()
          }).catch(error => fail(error instanceof Error ? error.message : '整形に失敗しました', rawText))
        }
      }, deviceId)
      session.recognition = recognition
      if (this.active !== session) recognition.cancel()
    } catch (error) { fail(error instanceof Error ? error.message : '音声入力を開始できませんでした') }
  }
  stop(id: string) {
    const session = this.active
    if (!session || session.id !== id || session.phase !== 'listening') return
    session.phase = 'finalizing'; clearTimeout(session.timer)
    this.emit({ requestId: id, type: 'finalizing' })
    session.timer = setTimeout(() => {
      if (this.active !== session) return
      this.emit({ requestId: id, type: 'error', message: '音声認識がタイムアウトしました' }); this.cancel()
    }, 60_000)
    session.recognition?.stop()
  }
}

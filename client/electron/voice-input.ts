import { VoiceHelperPool } from './voice-helper'
import { app, ipcMain, systemPreferences, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { VoiceCapabilities, VoiceDeviceList } from '../shared/voice-input'
import { listDevices, probeCapabilities } from './voice-probe'
import { createVoiceFormatter } from './voice-formatter'
import { createVoicePromptStore } from './voice-prompt-store'
import type { AuthMode } from '../shared/agent'

import { VoiceInputSession, type SpeechRecognitionProvider, type RecognitionEvent } from './voice-session'

class AppleSpeechProvider implements SpeechRecognitionProvider {
  private pool: VoiceHelperPool
  constructor(private readonly binary: string) { this.pool = new VoiceHelperPool(binary) }
  warmUp() { this.pool.warmUp() }
  dispose() { this.pool.dispose() }
  capabilities(): Promise<VoiceCapabilities> { return probeCapabilities(this.binary) }
  devices(): Promise<VoiceDeviceList> { return listDevices(this.binary) }
  start(onEvent: (event: RecognitionEvent) => void, deviceId?: string) {
    return this.pool.start(onEvent, deviceId)
  }
}
class UnavailableSpeechProvider implements SpeechRecognitionProvider {
  warmUp() {}
  dispose() {}
  async capabilities() { return { available: false, reason: '音声入力は現在macOS 26以降に対応しています。Windows対応は準備中です' } }
  async devices(): Promise<VoiceDeviceList> { return { ok: true, devices: [] } }
  start(): never { throw new Error('このOSの音声認識は未対応です') }
}

export function registerVoiceInput(getCli: () => string, getEnv: () => Record<string, string>, getSettings: () => { authMode: AuthMode; apiKey?: string }) {
  const provider: SpeechRecognitionProvider & { devices(): Promise<VoiceDeviceList>; warmUp(): void; dispose(): void } = process.platform === 'darwin'
    ? new AppleSpeechProvider(app.isPackaged ? path.join(process.resourcesPath, 'voice/acb-speech') : path.join(app.getAppPath(), 'native/bin/acb-speech'))
    : new UnavailableSpeechProvider()
  // A definitive answer (available, or permanently unsupported) is cached for
  // the app's lifetime. A transient one (timeout, helper failure, model not
  // installed yet) is not, so 「もう一度確認」 in the chat input probes again.
  // Concurrent callers share one in-flight probe.
  let check: Promise<VoiceCapabilities> | undefined
  const capabilities = () => check ??= provider.capabilities().then(result => {
    if (result.available) provider.warmUp()
    else if (result.retryable) check = undefined
    return result
  }, error => { check = undefined; throw error })
  let owner: WebContents | undefined
  let requestedAt = 0
  const session = new VoiceInputSession(
    { capabilities, start: (callback, deviceId) => provider.start(callback, deviceId) },
    async () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' || await systemPreferences.askForMediaAccess('microphone'),
    async () => { throw new Error('音声整形の設定がありません') },
    event => {
      if (event.type === 'listening') console.info('[voice] recording ready', { requestToListeningMs: Date.now() - requestedAt })
      if (owner && !owner.isDestroyed()) owner.send('voice:event', event)
    },
  )
  const cancel = () => session.cancel()
  // 「整え方の指示」: per member on this PC, read at the start of each voice input.
  const prompts = createVoicePromptStore(path.join(app.getPath('userData'), 'voice-prompt.json'))
  ipcMain.handle('voice:getPrompt', () => prompts.get())
  ipcMain.handle('voice:setPrompt', (_event, instructions: unknown) => prompts.set(instructions))
  ipcMain.handle('voice:resetPrompt', () => prompts.reset())
  ipcMain.handle('voice:capabilities', capabilities)
  ipcMain.handle('voice:devices', () => provider.devices())
  ipcMain.handle('voice:start', async (event, id: unknown, deviceId?: unknown) => {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('無効な音声入力IDです')
    if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length > 1024 || deviceId.includes('\0'))) throw new Error('無効なマイクIDです')
    if (session.busy) throw new Error('音声入力が既に動作中です')
    if (owner !== event.sender) {
      owner?.removeListener('destroyed', cancel)
      owner?.removeListener('did-start-navigation', cancel)
      owner = event.sender
      owner.once('destroyed', cancel)
      owner.on('did-start-navigation', cancel)
    }
    requestedAt = Date.now()
    const cwd = path.join(app.getPath('userData'), 'voice-polisher')
    mkdirSync(cwd, { recursive: true })
    const formatter = createVoiceFormatter({ ...getSettings(), getCli, env: getEnv(), cwd, systemPrompt: prompts.systemPrompt() })
    await session.start(id, deviceId as string | undefined, formatter)
  })
  ipcMain.handle('voice:stop', (event, id: string) => { if (owner === event.sender) session.stop(id) })
  ipcMain.handle('voice:cancel', (event, id: string) => { if (owner === event.sender) session.cancel(id) })
  app.on('before-quit', () => { provider.dispose(); cancel() })
}

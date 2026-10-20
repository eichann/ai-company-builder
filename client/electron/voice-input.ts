import { VoiceHelperPool } from './voice-helper'
import { app, ipcMain, systemPreferences, type WebContents } from 'electron'
import { spawnVoiceProcess } from './voice-process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { VoiceCapabilities, VoiceDevice } from '../shared/voice-input'
import { polishVoice } from './voice-polisher'

import { VoiceInputSession, type SpeechRecognitionProvider, type RecognitionEvent } from './voice-session'

class AppleSpeechProvider implements SpeechRecognitionProvider {
  private pool: VoiceHelperPool
  constructor(private readonly binary: string) { this.pool = new VoiceHelperPool(binary) }
  warmUp() { this.pool.warmUp() }
  dispose() { this.pool.dispose() }
  async capabilities(): Promise<VoiceCapabilities> {
    if (!existsSync(this.binary)) return { available: false, reason: '音声認識ヘルパーがありません。Mac用ビルドが必要です' }
    return new Promise(resolve => {
      const child = spawnVoiceProcess(this.binary, ['--probe'])
      let available = false
      let reason = '日本語の音声認識を確認できませんでした'
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ available: false, reason }) }, 10_000)
      createInterface({ input: child.stdout }).on('line', line => {
        try { const data = JSON.parse(line); if (data.type === 'available') available = true; if (data.type === 'error') reason = data.message } catch { /* invalid protocol */ }
      })
      child.stderr.resume()
      child.on('error', () => { clearTimeout(timer); resolve({ available: false, reason }) })
      child.on('close', () => { clearTimeout(timer); resolve({ available, reason: available ? undefined : reason }) })
    })
  }
  async devices(): Promise<VoiceDevice[]> {
    return new Promise((resolve, reject) => {
      const child = spawnVoiceProcess(this.binary, ['--devices'])
      let devices: VoiceDevice[] | undefined
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('マイク一覧の取得がタイムアウトしました')) }, 10_000)
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const data = JSON.parse(line)
          if (data.type === 'devices' && Array.isArray(data.devices)) devices = data.devices.filter((d: VoiceDevice) => typeof d.id === 'string' && typeof d.name === 'string' && typeof d.isDefault === 'boolean')
        } catch { /* invalid protocol */ }
      })
      child.stderr.resume()
      child.on('error', () => { clearTimeout(timer); reject(new Error('マイク一覧を取得できませんでした')) })
      child.on('close', code => { clearTimeout(timer); if (code === 0 && devices) resolve(devices); else reject(new Error('マイク一覧を取得できませんでした')) })
    })
  }
  start(onEvent: (event: RecognitionEvent) => void, deviceId?: string) {
    return this.pool.start(onEvent, deviceId)
  }
}
class UnavailableSpeechProvider implements SpeechRecognitionProvider {
  warmUp() {}
  dispose() {}
  async capabilities() { return { available: false, reason: '音声入力は現在macOS 26以降に対応しています。Windows対応は準備中です' } }
  async devices(): Promise<VoiceDevice[]> { return [] }
  start(): never { throw new Error('このOSの音声認識は未対応です') }
}

export function registerVoiceInput(getCli: () => string, getEnv: () => NodeJS.ProcessEnv) {
  const provider: SpeechRecognitionProvider & { devices(): Promise<VoiceDevice[]>; warmUp(): void; dispose(): void } = process.platform === 'darwin'
    ? new AppleSpeechProvider(app.isPackaged ? path.join(process.resourcesPath, 'voice/acb-speech') : path.join(app.getAppPath(), 'native/bin/acb-speech'))
    : new UnavailableSpeechProvider()
  let check: Promise<VoiceCapabilities> | undefined
  const capabilities = () => check ??= provider.capabilities().then(result => { if (result.available) provider.warmUp(); return result })
  let owner: WebContents | undefined
  let requestedAt = 0
  const session = new VoiceInputSession(
    { capabilities, start: (callback, deviceId) => provider.start(callback, deviceId) },
    async () => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted' || await systemPreferences.askForMediaAccess('microphone'),
    (text, signal) => {
      const cwd = path.join(app.getPath('userData'), 'voice-polisher')
      mkdirSync(cwd, { recursive: true })
      return polishVoice(getCli(), cwd, text, signal, getEnv())
    },
    event => {
      if (event.type === 'listening') console.info('[voice] recording ready', { requestToListeningMs: Date.now() - requestedAt })
      if (owner && !owner.isDestroyed()) owner.send('voice:event', event)
    },
  )
  const cancel = () => session.cancel()
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
    await session.start(id, deviceId as string | undefined)
  })
  ipcMain.handle('voice:stop', (event, id: string) => { if (owner === event.sender) session.stop(id) })
  ipcMain.handle('voice:cancel', (event, id: string) => { if (owner === event.sender) session.cancel(id) })
  app.on('before-quit', () => { provider.dispose(); cancel() })
}

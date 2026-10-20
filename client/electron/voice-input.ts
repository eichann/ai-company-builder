import { app, ipcMain, systemPreferences, type WebContents } from 'electron'
import { spawnVoiceProcess } from './voice-process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { VoiceCapabilities } from '../shared/voice-input'
import { polishVoice } from './voice-polisher'

import { VoiceInputSession, type SpeechRecognitionProvider } from './voice-session'

class AppleSpeechProvider implements SpeechRecognitionProvider {
  constructor(private readonly binary: string) {}
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
  start(onEvent: (event: { type: string; text?: string; message?: string }) => void) {
    const child = spawnVoiceProcess(this.binary, [])
    let finished = false
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const data = JSON.parse(line)
        if (data.type === 'result' || data.type === 'error') finished = true
        onEvent(data)
      } catch { /* Never log transcript data. */ }
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => onEvent({ type: 'error', message: '音声認識を起動できませんでした' }))
    child.on('close', () => { if (!finished) onEvent({ type: 'error', message: '音声認識が終了しました。もう一度お試しください' }) })
    return { stop: () => child.stdin.end(), cancel: () => { finished = true; child.kill('SIGKILL') } }
  }
}
class UnavailableSpeechProvider implements SpeechRecognitionProvider {
  async capabilities() { return { available: false, reason: '音声入力は現在macOS 26以降に対応しています。Windows対応は準備中です' } }
  start(): never { throw new Error('このOSの音声認識は未対応です') }
}

export function registerVoiceInput(getCli: () => string, getEnv: () => NodeJS.ProcessEnv) {
  const provider: SpeechRecognitionProvider = process.platform === 'darwin'
    ? new AppleSpeechProvider(app.isPackaged ? path.join(process.resourcesPath, 'voice/acb-speech') : path.join(app.getAppPath(), 'native/bin/acb-speech'))
    : new UnavailableSpeechProvider()
  let check: Promise<VoiceCapabilities> | undefined
  const capabilities = () => check ??= provider.capabilities()
  let owner: WebContents | undefined
  const session = new VoiceInputSession(
    { capabilities, start: callback => provider.start(callback) },
    async () => process.platform !== 'darwin' || await systemPreferences.askForMediaAccess('microphone'),
    (text, signal) => {
      const cwd = path.join(app.getPath('userData'), 'voice-polisher')
      mkdirSync(cwd, { recursive: true })
      return polishVoice(getCli(), cwd, text, signal, getEnv())
    },
    event => { if (owner && !owner.isDestroyed()) owner.send('voice:event', event) },
  )
  const cancel = () => session.cancel()
  ipcMain.handle('voice:capabilities', capabilities)
  ipcMain.handle('voice:start', async (event, id: unknown) => {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('無効な音声入力IDです')
    if (session.busy) throw new Error('音声入力が既に動作中です')
    if (owner !== event.sender) {
      owner?.removeListener('destroyed', cancel)
      owner?.removeListener('did-start-navigation', cancel)
      owner = event.sender
      owner.once('destroyed', cancel)
      owner.on('did-start-navigation', cancel)
    }
    await session.start(id)
  })
  ipcMain.handle('voice:stop', (event, id: string) => { if (owner === event.sender) session.stop(id) })
  ipcMain.handle('voice:cancel', (event, id: string) => { if (owner === event.sender) session.cancel(id) })
  app.on('before-quit', cancel)
}

import type { VoiceDevice } from '../../shared/voice-input'
const KEY = 'acb.voice.microphone'
function readSelection() { try { return localStorage.getItem(KEY) } catch { return null } }
const savedSelection = readSelection()
let state: { selectedDevice: string; configured: boolean; devices?: VoiceDevice[]; deviceError: string } = { selectedDevice: savedSelection ?? '', configured: savedSelection !== null, deviceError: '' }
const listeners = new Set<() => void>()
let pending: Promise<void> | undefined
function update(value: Partial<typeof state>) { state = { ...state, ...value }; listeners.forEach(fn => fn()) }
export const microphoneSelection = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => state,
  select: (selectedDevice: string) => {
    update({ selectedDevice, configured: true })
    try { localStorage.setItem(KEY, selectedDevice) }
    catch { update({ deviceError: '選択を保存できませんでした。アプリを閉じるまではこのマイクを使用します' }) }
  },
  refresh: () => {
    if (pending) return pending
    pending = window.electronAPI.voiceInput.devices()
      .then(devices => update({ devices, deviceError: '' }))
      .catch(() => update({ deviceError: 'マイク一覧を取得できませんでした。「再取得」でお試しください' }))
      .finally(() => { pending = undefined })
    return pending
  },
}

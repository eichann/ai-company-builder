import type { VoiceDevice, VoiceDeviceList } from '../../shared/voice-input'
const KEY = 'acb.voice.microphone'
function readSelection() { try { return localStorage.getItem(KEY) } catch { return null } }
const savedSelection = readSelection()
export type DeviceFailure = 'timeout' | 'failed'
// Shown next to the 「もう一度確認」 button in VoiceInputControl, which is
// rendered whenever `deviceFailure` is set — so neither names another button.
export function deviceFailureMessage(failure: DeviceFailure) {
  return failure === 'timeout'
    ? 'マイク一覧の取得に時間がかかりすぎたため中断しました。Macの負荷が高いと時間がかかることがあります'
    : 'マイク一覧を取得できませんでした'
}
type State = {
  selectedDevice: string
  configured: boolean
  devices?: VoiceDevice[]
  // Why the last refresh failed. The previous list (if any) stays usable.
  deviceFailure?: DeviceFailure
  // Problems unrelated to fetching the list (saving the choice).
  deviceError: string
  refreshing: boolean
}
let state: State = { selectedDevice: savedSelection ?? '', configured: savedSelection !== null, deviceError: '', refreshing: false }
const listeners = new Set<() => void>()
let pending: Promise<void> | undefined
function update(value: Partial<State>) { state = { ...state, ...value }; listeners.forEach(fn => fn()) }
function apply(result: VoiceDeviceList) {
  if (result.ok) update({ devices: result.devices, deviceFailure: undefined, deviceError: '' })
  else update({ deviceFailure: result.error })
}
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
    update({ refreshing: true })
    pending = window.electronAPI.voiceInput.devices()
      .then(apply, () => apply({ ok: false, error: 'failed' }))
      .finally(() => { pending = undefined; update({ refreshing: false }) })
    return pending
  },
}

import type { VoiceCapabilities, VoiceDevice } from '../../shared/voice-input'
import { microphoneSelection, type DeviceFailure } from './microphoneSelection'

// Whether speech recognition can run on this Mac, shared by every chat input
// (like microphoneSelection) so all of them show the same state and a retry in
// one updates the others. The probe and the device list are independent IPC
// calls started together: a slow device list never delays the probe's answer.
type State = { caps?: VoiceCapabilities; checking: boolean }
let state: State = { checking: false }
const listeners = new Set<() => void>()
let pending: Promise<void> | undefined
function update(value: Partial<State>) { state = { ...state, ...value }; listeners.forEach(fn => fn()) }

function probe() {
  if (pending) return pending
  update({ checking: true })
  pending = window.electronAPI.voiceInput.capabilities()
    .then(caps => update({ caps }), () => update({ caps: { available: false, reason: '音声入力の状態を確認できませんでした', retryable: true } }))
    .finally(() => { pending = undefined; update({ checking: false }) })
  return pending
}

export const voiceAvailability = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => state,
  // First mount of any chat input: probe once and fetch the device list.
  load: () => Promise.all([
    state.caps ? undefined : probe(),
    microphoneSelection.getSnapshot().devices ? undefined : microphoneSelection.refresh(),
  ]).then(() => {}),
  // 「もう一度確認」: re-run both the probe and the enumeration. The main
  // process caches only a definitive probe answer, so this really re-probes
  // after a timeout or failure.
  recheck: () => Promise.all([probe(), microphoneSelection.refresh()]).then(() => {}),
}

export type RecheckView = {
  // Retry control visible (rendered as 「もう一度確認」, disabled while running).
  show: boolean
  running: boolean
  // Device-list problem to show beside the control, if any.
  deviceProblem?: 'timeout' | 'failed' | 'none-found'
}

// When to offer 「もう一度確認」:
// - speech is unavailable for a retryable reason (timeout, helper failure,
//   model not installed) — never for "not supported" (not macOS, macOS < 26,
//   no helper), where retrying can only repeat the same answer;
// - or speech is available / still being checked and the device list failed,
//   timed out, or came back empty (a microphone may be plugged in later).
// Device problems are not shown once speech is known to be unavailable: the
// capability reason is the one that matters then.
export function recheckView(input: { caps?: VoiceCapabilities; checking: boolean; devices?: VoiceDevice[]; deviceFailure?: DeviceFailure; refreshing: boolean }): RecheckView {
  const running = input.checking || input.refreshing
  const capsUnavailable = Boolean(input.caps && !input.caps.available)
  if (capsUnavailable) return { show: Boolean(input.caps?.retryable), running }
  const deviceProblem = input.deviceFailure ?? (input.devices?.length === 0 ? 'none-found' : undefined)
  return { show: Boolean(deviceProblem), running, deviceProblem }
}

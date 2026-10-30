// Voice input's access to the main process, as small ports over the IPC
// contract (src/shared/ipc/electron-api.ts), one per capability. Every function
// takes its port as the last parameter, defaulting to window.electronAPI.
import type { VoiceEvent } from '../../../shared/voice-input'
import type { VoiceInputPort } from '../../shared/ipc/electron-api'

/** Reading on this computer: whether speech recognition can run, the microphones. */
export type VoiceDeviceReads = VoiceInputPort<'capabilities' | 'devices'>
/** Reading the member's 「整え方の指示」 (this computer only). */
export type VoicePromptReads = VoiceInputPort<'getPrompt'>
/** Changing the member's 「整え方の指示」 (this computer only). */
export type VoicePromptWrites = VoiceInputPort<'setPrompt' | 'resetPrompt'>
/**
 * Recording: turns the microphone on, runs the recognizer and sends the
 * transcript to the member's AI to be tidied up, so it leaves the computer.
 */
export type VoiceOutbound = VoiceInputPort<'start' | 'stop' | 'cancel' | 'onEvent'>

export function getVoiceCapabilities(reads: VoiceDeviceReads = window.electronAPI) {
  return reads.voiceInput.capabilities()
}

export function listMicrophones(reads: VoiceDeviceReads = window.electronAPI) {
  return reads.voiceInput.devices()
}

export function getVoicePrompt(reads: VoicePromptReads = window.electronAPI) {
  return reads.voiceInput.getPrompt()
}

/** Rejects with a member-facing message (too long, not saved). */
export function setVoicePrompt(instructions: string, writes: VoicePromptWrites = window.electronAPI) {
  return writes.voiceInput.setPrompt(instructions)
}

export function resetVoicePrompt(writes: VoicePromptWrites = window.electronAPI) {
  return writes.voiceInput.resetPrompt()
}

/** Starts recording on the chosen microphone (the system default when none). */
export function startRecording(requestId: string, deviceId?: string, outbound: VoiceOutbound = window.electronAPI) {
  return outbound.voiceInput.start(requestId, deviceId)
}

/** Stops recording; the tidied-up text arrives as a `result` event. */
export function stopRecording(requestId: string, outbound: VoiceOutbound = window.electronAPI) {
  return outbound.voiceInput.stop(requestId)
}

export function cancelRecording(requestId: string, outbound: VoiceOutbound = window.electronAPI) {
  return outbound.voiceInput.cancel(requestId)
}

/** Level, phase, result and error events of every recording; returns the unsubscribe. */
export function onVoiceEvent(callback: (event: VoiceEvent) => void, outbound: VoiceOutbound = window.electronAPI) {
  return outbound.voiceInput.onEvent(callback)
}

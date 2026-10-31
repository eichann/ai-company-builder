import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { VoiceCapabilities, VoiceDeviceList } from '../../../shared/voice-input'

let probes = 0
let listings = 0
let probe: () => Promise<VoiceCapabilities> = async () => ({ available: false, reason: '日本語の音声認識の確認が30秒以内に終わりませんでした', retryable: true })
let list: () => Promise<VoiceDeviceList> = async () => ({ ok: false, error: 'timeout' })
Object.assign(globalThis, {
  localStorage: { getItem: () => '', setItem: () => {} },
  window: { electronAPI: { voiceInput: {
    capabilities: () => { probes++; return probe() },
    devices: () => { listings++; return list() },
  } } },
})

test('recheckView: when 「もう一度確認」 is offered', async () => {
  const { recheckView } = await import('./voiceAvailability')
  const base = { checking: false, refreshing: false }
  const usb = [{ id: 'usb', name: 'USB', isDefault: true }]
  // Transient probe failure: offered. Permanent "not supported": not offered.
  assert.deepEqual(recheckView({ ...base, caps: { available: false, reason: 't', retryable: true } }), { show: true, running: false })
  assert.deepEqual(recheckView({ ...base, caps: { available: false, reason: 'macOS 26以降' } }), { show: false, running: false })
  // A device failure under a permanently unsupported OS is not surfaced.
  assert.deepEqual(recheckView({ ...base, caps: { available: false, reason: 'x' }, deviceFailure: 'failed' }), { show: false, running: false })
  // Speech available (or still being checked) and the list failed / timed out / is empty.
  assert.deepEqual(recheckView({ ...base, caps: { available: true }, deviceFailure: 'timeout', devices: usb }), { show: true, running: false, deviceProblem: 'timeout' })
  assert.deepEqual(recheckView({ ...base, deviceFailure: 'failed' }), { show: true, running: false, deviceProblem: 'failed' })
  assert.deepEqual(recheckView({ ...base, caps: { available: true }, devices: [] }), { show: true, running: false, deviceProblem: 'none-found' })
  // Healthy, or still loading: nothing to retry.
  assert.deepEqual(recheckView({ ...base, caps: { available: true }, devices: usb }), { show: false, running: false, deviceProblem: undefined })
  assert.deepEqual(recheckView({ checking: true, refreshing: true }), { show: false, running: true, deviceProblem: undefined })
})

test('load probes once; recheck re-runs both the probe and the device list', async () => {
  const { voiceAvailability, recheckView } = await import('./voiceAvailability')
  const { microphoneSelection } = await import('./microphoneSelection')
  const view = () => recheckView({ ...voiceAvailability.getSnapshot(), ...microphoneSelection.getSnapshot() })

  // The probe answers before the slow device list: its result is visible
  // without waiting for the enumeration.
  let releaseList!: (value: VoiceDeviceList) => void
  list = () => new Promise(resolve => { releaseList = resolve })
  const loading = voiceAvailability.load()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(voiceAvailability.getSnapshot().caps?.retryable, true)
  assert.equal(microphoneSelection.getSnapshot().refreshing, true)
  assert.deepEqual(view(), { show: true, running: true })
  releaseList({ ok: false, error: 'timeout' })
  await loading
  assert.equal(probes, 1); assert.equal(listings, 1)
  assert.deepEqual(view(), { show: true, running: false })

  // A second chat input mounting does not re-probe a known answer, but does
  // fetch a device list that never arrived.
  list = async () => ({ ok: false, error: 'failed' })
  await voiceAvailability.load()
  assert.equal(probes, 1); assert.equal(listings, 2)
  assert.equal(microphoneSelection.getSnapshot().deviceFailure, 'failed')

  // The user presses 「もう一度確認」 after the Mac calms down.
  probe = async () => ({ available: true })
  list = async () => ({ ok: true, devices: [{ id: 'mic', name: 'Mic', isDefault: true }] })
  await voiceAvailability.recheck()
  assert.equal(probes, 2); assert.equal(listings, 3)
  assert.deepEqual(voiceAvailability.getSnapshot().caps, { available: true })
  assert.equal(microphoneSelection.getSnapshot().deviceFailure, undefined)
  assert.deepEqual(view(), { show: false, running: false, deviceProblem: undefined })

  // An IPC failure of the probe itself is offered a retry rather than "restart the app".
  probe = () => Promise.reject(new Error('ipc'))
  await voiceAvailability.recheck()
  assert.equal(voiceAvailability.getSnapshot().caps?.retryable, true)
  assert.doesNotMatch(voiceAvailability.getSnapshot().caps?.reason ?? '', /再起動/)
})

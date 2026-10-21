import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { VoiceDeviceList } from '../shared/voice-input'

const storage = new Map<string,string>()
let requests = 0
let next: () => Promise<VoiceDeviceList> = async () => ({ ok: true, devices: [{ id:'usb',name:'USB',isDefault:false }] })
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key,value) },
  window: { electronAPI: { voiceInput: { devices: () => { requests++; return next() } } } },
})

test('microphone selection and device inventory are shared across chat subscriptions', async () => {
  const { microphoneSelection: store } = await import('../src/lib/microphoneSelection')
  assert.equal(store.getSnapshot().configured,false)
  await Promise.all([store.refresh(),store.refresh()]); assert.equal(requests,1)
  store.select('')
  assert.equal(store.getSnapshot().configured,true)
  assert.equal(storage.get('acb.voice.microphone'),'')
  store.select('usb')
  const unsubscribe = store.subscribe(() => {})
  unsubscribe()
  const nextChat = store.subscribe(() => {})
  assert.equal(store.getSnapshot().selectedDevice,'usb')
  assert.equal(store.getSnapshot().devices?.[0].id,'usb')
  assert.equal(requests,1)
  await store.refresh()
  assert.equal(store.getSnapshot().selectedDevice,'usb')
  assert.equal(storage.get('acb.voice.microphone'),'usb')
  nextChat()
})

test('a timed-out device list is reported as a timeout, not a generic failure, and keeps the last list', async () => {
  const { microphoneSelection: store, deviceFailureMessage } = await import('../src/lib/microphoneSelection')
  let release!: (value: VoiceDeviceList) => void
  next = () => new Promise(resolve => { release = resolve })
  const run = store.refresh()
  assert.equal(store.getSnapshot().refreshing, true)
  release({ ok: false, error: 'timeout' })
  await run
  assert.equal(store.getSnapshot().refreshing, false)
  assert.equal(store.getSnapshot().deviceFailure, 'timeout')
  assert.equal(store.getSnapshot().devices?.[0].id, 'usb')
  assert.match(deviceFailureMessage('timeout'), /時間がかかりすぎた/)
  assert.doesNotMatch(deviceFailureMessage('timeout'), /再取得/)

  next = async () => ({ ok: false, error: 'failed' })
  await store.refresh()
  assert.equal(store.getSnapshot().deviceFailure, 'failed')
  assert.equal(deviceFailureMessage('failed'), 'マイク一覧を取得できませんでした')

  // An IPC rejection (main process threw) is a failure too.
  next = () => Promise.reject(new Error('ipc'))
  await store.refresh()
  assert.equal(store.getSnapshot().deviceFailure, 'failed')

  next = async () => ({ ok: true, devices: [] })
  await store.refresh()
  assert.equal(store.getSnapshot().deviceFailure, undefined)
  assert.deepEqual(store.getSnapshot().devices, [])
})

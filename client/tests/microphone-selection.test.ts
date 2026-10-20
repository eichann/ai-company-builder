import assert from 'node:assert/strict'
import { test } from 'node:test'
test('microphone selection and device inventory are shared across chat subscriptions', async () => {
  const storage = new Map<string,string>()
  let requests = 0
  Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key,value) },
    window: { electronAPI: { voiceInput: { devices: async () => { requests++; return [{ id:'usb',name:'USB',isDefault:false }] } } } },
  })
  const { microphoneSelection: store } = await import('../src/lib/microphoneSelection')
  await Promise.all([store.refresh(),store.refresh()]); assert.equal(requests,1)
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

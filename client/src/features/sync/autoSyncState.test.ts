// What survives an app restart in the stored automatic-sync state (autoSyncState.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('the open-file wait already told is read back after a restart (said once, not at every launch)', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } },
  })
  const { updateAutoSyncState } = await import('./autoSyncState')
  updateAutoSyncState('c1', s => ({ ...s, openFilesHeld: '営業部/見積.xlsx' }))
  // A fresh module (empty cache) reads what the last session stored.
  const fresh = await import(`./autoSyncState?restart=${Date.now()}`) as typeof import('./autoSyncState')
  assert.equal(fresh.readAutoSyncState('c1').openFilesHeld, '営業部/見積.xlsx')
})

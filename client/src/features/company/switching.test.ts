import { test } from 'node:test'
import assert from 'node:assert/strict'
import { switchCompany, type SwitchDeps } from './switching'

/** A world where every answer is "go ahead"; `log` records what happened, in order. */
function world(overrides: Partial<SwitchDeps> & { syncing?: () => boolean } = {}) {
  const log: string[] = []
  const deps: SwitchDeps = {
    syncRunning: overrides.syncing ?? (() => false),
    askDuringSync: async () => { log.push('ask-sync'); return true },
    whenSyncIdle: async () => { log.push('wait-sync'); return true },
    aiWorking: () => false,
    askDuringAi: async () => { log.push('ask-ai'); return true },
    saveTabs: async () => { log.push('save'); return true },
    prepareOpen: async () => { log.push('check'); return () => { log.push('open') } },
    ...overrides,
  }
  return { deps, log }
}

test('switching while a sync runs never opens the other company before that sync has ended', async () => {
  let syncing = true
  const { deps, log } = world({
    syncing: () => syncing,
    whenSyncIdle: async () => { log.push('wait-sync'); syncing = false; return true },
  })
  assert.equal(await switchCompany(deps), 'opened')
  assert.deepEqual(log, ['ask-sync', 'wait-sync', 'save', 'check', 'open'])
})

test('a sync that starts while the tabs are saved or the company is checked is waited for too', async () => {
  let syncing = false
  const { deps, log } = world({
    syncing: () => syncing,
    prepareOpen: async () => {
      log.push('check')
      if (!log.includes('wait-sync')) syncing = true
      return () => { log.push('open') }
    },
    whenSyncIdle: async () => { log.push('wait-sync'); syncing = false; return true },
  })
  assert.equal(await switchCompany(deps), 'opened')
  assert.deepEqual(log, ['save', 'check', 'ask-sync', 'wait-sync', 'save', 'check', 'open'])
})

test('not waiting for the sync, or giving up the wait, keeps the company open as it was', async () => {
  const refused = world({ syncing: () => true, askDuringSync: async () => false })
  assert.equal(await switchCompany(refused.deps), 'cancelled')
  assert.deepEqual(refused.log, [])

  const gaveUp = world({ syncing: () => true, whenSyncIdle: async () => false })
  assert.equal(await switchCompany(gaveUp.deps), 'cancelled')
  assert.deepEqual(gaveUp.log, ['ask-sync'])
})

test('an AI at work is asked about first: no means nothing is saved or opened, yes switches', async () => {
  const stay = world({ aiWorking: () => true, askDuringAi: async () => false })
  assert.equal(await switchCompany(stay.deps), 'cancelled')
  assert.deepEqual(stay.log, [])

  const go = world({ aiWorking: () => true })
  assert.equal(await switchCompany(go.deps), 'opened')
  assert.deepEqual(go.log, ['ask-ai', 'save', 'check', 'open'])
})

test('tabs that could not be saved and the member staying: the other company is not opened', async () => {
  const { deps, log } = world({ saveTabs: async () => { log.push('save'); return false } })
  assert.equal(await switchCompany(deps), 'cancelled')
  assert.deepEqual(log, ['save'])
})

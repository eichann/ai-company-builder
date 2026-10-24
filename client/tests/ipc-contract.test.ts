// IPC contract snapshot: every channel between the renderer and the main
// process, the handler parameters, what each preload function sends where,
// and the unmatched ends (dead-code candidates). Splitting main.ts into
// modules must not add, drop or re-wire any of it by accident.
//
// After an intended change, regenerate and review the JSON diff:
//   UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMain } from './ipc-harness/main-harness.ts'
import { buildInventory } from './ipc-harness/inventory.ts'

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc-harness', 'ipc-inventory.json')

test('IPC inventory matches ipc-inventory.json (UPDATE_IPC_INVENTORY=1 to regenerate)', async () => {
  const h = await loadMain()
  after(() => h.shutdown())
  // Handlers registered in app.whenReady (voice input) count too.
  await h.startApp()
  const inventory = await buildInventory({ handle: [...h.fake.handlers.keys()], on: [...h.fake.listeners.keys()] })
  // Every channel is in the contract (shared/ipc-contract.ts), and every
  // contract channel has its handler / listener in main and its caller /
  // listener in preload — whatever the golden file says.
  assert.deepEqual(inventory.unmatched.notInContract, [], 'Channels used but missing from shared/ipc-contract.ts')
  assert.deepEqual(inventory.unmatched.inContractButUnused, [], 'Contract channels without a main-process handler or a preload caller')
  const json = `${JSON.stringify(inventory, null, 2)}\n`
  if (process.env.UPDATE_IPC_INVENTORY) fs.writeFileSync(GOLDEN, json)
  assert.equal(json, fs.readFileSync(GOLDEN, 'utf-8'),
    'The IPC surface changed. If intended, run UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts and review the diff of tests/ipc-harness/ipc-inventory.json.')
})

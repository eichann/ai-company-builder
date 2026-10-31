// IPC contract snapshot: every channel between the renderer and the main
// process, the handler parameters, what each preload function sends where,
// and the unmatched ends (dead-code candidates). Splitting main.ts into
// modules must not add, drop or re-wire any of it by accident.
//
// The golden file holds one fact per line, sorted (inventoryLines), so PRs
// that add different channels change different lines and merge without a
// conflict. After an intended change, regenerate and review the diff:
//   UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMain } from './ipc-harness/main-harness.ts'
import { buildInventory, inventoryLines } from './ipc-harness/inventory.ts'

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc-harness', 'ipc-inventory.txt')
const REGENERATE = 'UPDATE_IPC_INVENTORY=1 npx tsx --test tests/ipc-contract.test.ts'

test('IPC inventory matches ipc-inventory.txt (UPDATE_IPC_INVENTORY=1 to regenerate)', async () => {
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
  const text = `${inventoryLines(inventory).join('\n')}\n`
  if (process.env.UPDATE_IPC_INVENTORY) fs.writeFileSync(GOLDEN, text)
  const golden = fs.existsSync(GOLDEN) ? fs.readFileSync(GOLDEN, 'utf-8') : ''
  if (text === golden) return
  // Compared as whole text (order and duplicates count, e.g. after a bad
  // merge); the message names the lines that differ.
  const now = new Set(text.split('\n').filter(Boolean))
  const recorded = new Set(golden.split('\n').filter(Boolean))
  const added = [...now].filter(l => !recorded.has(l)).map(l => `  + ${l}`)
  const removed = [...recorded].filter(l => !now.has(l)).map(l => `  - ${l}`)
  assert.fail([
    'The IPC surface differs from tests/ipc-harness/ipc-inventory.txt.',
    ...(added.length ? ['In the code, not recorded:', ...added] : []),
    ...(removed.length ? ['Recorded, no longer in the code:', ...removed] : []),
    ...(!added.length && !removed.length ? ['Same entries, but the file is out of order or has duplicates (a merge?).'] : []),
    `If intended, run (in client/): ${REGENERATE}`,
    'and review the diff of tests/ipc-harness/ipc-inventory.txt.',
  ].join('\n'))
})

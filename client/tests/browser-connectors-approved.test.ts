/**
 * The approved combinations of browser connectors (shared/browser-connectors/approved.json,
 * client/scripts/browser-connectors.ts; agent-browser.md "Plans, executions, permits and locks"):
 * the file must be exactly what the script writes for the current connector folders, so a changed
 * checker or declaration cannot be merged (or built) without its row — the server would refuse its
 * plans, never accept them under an old row's hashes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVED_FILE, CARRIED_FILE, CONNECTORS_DIR, approvedFileText, carriedFileText, currentRows, declarationHash, folderHash, mergeApproved } from '../scripts/browser-connectors'

test('approved.json is what the script writes for the connector folders now', async () => {
  const existing = readFileSync(APPROVED_FILE, 'utf8')
  assert.equal(await approvedFileText(existing), existing, 'run `cd client && npx tsx scripts/browser-connectors.ts` and review the new row')
})

// The app knows its own combination from carried.json (features/browser/combination.ts): a stale file
// would make the app register plans under another build's checker hash.
test('carried.json is what the script writes: exactly the combinations of the connector folders now', async () => {
  assert.equal(await carriedFileText(), readFileSync(CARRIED_FILE, 'utf8'), 'run `cd client && npx tsx scripts/browser-connectors.ts`')
})

test('every current declaration × checker folder has an approved row with its declaration text', async () => {
  const file = JSON.parse(readFileSync(APPROVED_FILE, 'utf8')) as { combinations: Array<Record<string, unknown>> }
  for (const row of await currentRows()) {
    assert.ok(file.combinations.some(r => r.declarationHash === row.declarationHash && r.checkerHash === row.checkerHash && r.declaration === row.declaration),
      `${row.connector}@${row.version} has no row`)
  }
})

test('one changed byte anywhere in a site folder is another checker hash, kept beside the old row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acb-connectors-'))
  try {
    cpSync(CONNECTORS_DIR, dir, { recursive: true })
    const before = folderHash(join(dir, 'lstep'))
    writeFileSync(join(dir, 'lstep', 'reminder-step.ts'), readFileSync(join(dir, 'lstep', 'reminder-step.ts'), 'utf8') + '\n')
    assert.notEqual(folderHash(join(dir, 'lstep')), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new checker hash is a new row next to the old one; a changed declaration under the same version is refused', async () => {
  const existing = readFileSync(APPROVED_FILE, 'utf8')
  const [row] = await currentRows()
  const count = (JSON.parse(existing) as { combinations: unknown[] }).combinations.length
  const newChecker = JSON.parse(mergeApproved(existing, [{ ...row, checkerHash: `sha256:${'0'.repeat(64)}` }])) as { combinations: unknown[] }
  assert.equal(newChecker.combinations.length, count + 1)
  // A new row is listed `pending`: the server accepts no plan for it until a reviewed edit approves it (design memo §33.5).
  assert.equal((newChecker.combinations as Array<{ checkerHash: string; status: string }>).find(r => r.checkerHash === `sha256:${'0'.repeat(64)}`)?.status, 'pending')
  const text = row.declaration.replace('label: リマインダの段にテンプレートを足す', 'label: 段にテンプレートを足す')
  assert.throws(() => mergeApproved(existing, [{ ...row, declaration: text, declarationHash: declarationHash(text) }]), /raise the version/)
})

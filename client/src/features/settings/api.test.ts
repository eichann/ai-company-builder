// The settings panel edits the company folder's .gitignore and no other file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readGitignore, writeGitignore, type GitignoreReads, type GitignoreWrites } from './api'

const ROOT = '/Users/m/会社'

test('the .gitignore is read and written at the company folder root, nowhere else', async () => {
  const calls: string[] = []
  const reads: GitignoreReads = { readFile: async p => { calls.push(`read ${p}`); return null } }
  const writes: GitignoreWrites = { writeFile: async (p, content) => { calls.push(`write ${p} ${content}`); return true } }
  assert.equal(await readGitignore(ROOT, reads), null)
  assert.equal(await writeGitignore(ROOT, 'node_modules\n', writes), true)
  assert.deepEqual(calls, [`read ${ROOT}/.gitignore`, `write ${ROOT}/.gitignore node_modules\n`])
})

// The settings' .gitignore and .env go to the company folder's root, each
// through its own port: a .gitignore port never reaches the .env's secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCompanyEnvStatus, readGitignore, updateCompanyEnv, writeGitignore, type CompanyEnvReads, type CompanyEnvWrites, type GitignoreReads, type GitignoreWrites } from './api'

const ROOT = '/Users/m/会社'

test('.gitignore is read from and written to the company folder root', async () => {
  const calls: string[] = []
  const reads: GitignoreReads = { readFile: async p => { calls.push(`read ${p}`); return null } }
  const writes: GitignoreWrites = { writeFile: async (p, content) => { calls.push(`write ${p} ${content}`); return true } }
  assert.equal(await readGitignore(ROOT, reads), null)
  assert.equal(await writeGitignore(ROOT, 'node_modules\n', writes), true)
  assert.deepEqual(calls, [`read ${ROOT}/.gitignore`, `write ${ROOT}/.gitignore node_modules\n`])
})

test('.env goes through the env ports with the company root, unchanged', async () => {
  const calls: unknown[] = []
  const reads: CompanyEnvReads = { getEnvStatus: async root => { calls.push(['status', root]); return { success: true, vars: { A: { set: true } } } } }
  const writes: CompanyEnvWrites = { updateEnv: async (root, changes) => { calls.push(['update', root, changes]); return { success: true } } }
  assert.deepEqual(await readCompanyEnvStatus(ROOT, reads), { success: true, vars: { A: { set: true } } })
  assert.deepEqual(await updateCompanyEnv(ROOT, { A: '2', B: null }, writes), { success: true })
  assert.deepEqual(calls, [['status', ROOT], ['update', ROOT, { A: '2', B: null }]])
})

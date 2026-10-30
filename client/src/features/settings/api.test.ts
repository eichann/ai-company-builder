// The settings' .gitignore and .env go to the company folder's root, each
// through its own port: a .gitignore port never reaches the .env's secrets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCompanyEnv, readGitignore, writeCompanyEnv, writeGitignore, type CompanyEnvReads, type CompanyEnvWrites, type GitignoreReads, type GitignoreWrites } from './api'

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
  const reads: CompanyEnvReads = { readEnv: async root => { calls.push(['read', root]); return { success: true, vars: { A: '1' } } } }
  const writes: CompanyEnvWrites = { writeEnv: async (root, vars) => { calls.push(['write', root, vars]); return { success: true } } }
  assert.deepEqual(await readCompanyEnv(ROOT, reads), { success: true, vars: { A: '1' } })
  assert.deepEqual(await writeCompanyEnv(ROOT, { A: '2' }, writes), { success: true })
  assert.deepEqual(calls, [['read', ROOT], ['write', ROOT, { A: '2' }]])
})

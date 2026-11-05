// The app's git wrapper (electron/sync/git-factory.ts, `.claude/rules/sync-guards.md`)
// on simple-git 4: the app's own guard settings (hooks path, no-op editor,
// credential helper) must work, a member's ambient GIT_* variables must not
// break or steer sync, and a caller-supplied code-running option stays refused.
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ambientEnv, createConfiguredGit } from '../electron/sync/git-factory'

describe('createConfiguredGit with simple-git 4', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-git-factory-'))
  const saved = { ...process.env }
  before(() => {
    fs.mkdirSync(path.join(tmp, 'repo'))
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const make = (envOverrides?: Record<string, string>) =>
    createConfiguredGit(path.join(tmp, 'repo'), {
      binary: 'git',
      askPassPath: path.join(tmp, 'askpass'),
      token: 't',
      appGitDir: path.join(tmp, 'app'),
      envOverrides,
    })

  it("runs with the bundled git's GIT_EXEC_PATH override (app-git.ts)", async () => {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    const git = make({ GIT_EXEC_PATH: execPath })
    await git.init()
    assert.ok((await git.raw(['rev-parse', '--git-dir'])).trim())
  })

  it("drops a member's PREFIX and keeps GIT_SSL_CAINFO / GIT_SSL_CAPATH", async () => {
    process.env.PREFIX = '/usr/local'
    process.env.GIT_SSL_CAINFO = path.join(tmp, 'ca.pem')
    process.env.GIT_SSL_CAPATH = path.join(tmp, 'cadir')
    const git = make()
    await git.init()
    assert.ok((await git.raw(['rev-parse', '--git-dir'])).trim())
    const env = ambientEnv()
    assert.equal(env.PREFIX, undefined)
    assert.equal(env.GIT_SSL_CAINFO, process.env.GIT_SSL_CAINFO)
    assert.equal(env.GIT_SSL_CAPATH, process.env.GIT_SSL_CAPATH)
    assert.equal(env.GIT_SSH_COMMAND, undefined)
  })

  it('runs with the app guard settings despite a member environment full of guarded variables', async () => {
    process.env.GIT_SSH_COMMAND = 'ssh -o Foo=bar'
    process.env.GIT_PAGER = 'less'
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'someone-elses-config')
    process.env.PAGER = 'less'
    const git = make()
    await git.init()
    assert.equal((await git.raw(['config', '--get', 'core.hooksPath'])).trim(), path.join(tmp, 'app', 'hooks').replace(/\\/g, '/'))
  })

  it('still refuses a code-running option a caller supplies', async () => {
    await assert.rejects(make().raw(['-c', 'core.sshCommand=touch /tmp/pwned', 'status']), /not permitted|blocked/i)
  })
})

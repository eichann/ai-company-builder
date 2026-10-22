// The app's git never runs the member's own git hooks or templates.
//
// Found 2026-10-22: a developer machine had a global init.templateDir
// (git-secrets) that installs .git/hooks/pre-commit into every new
// repository. In a partial clone that hook fetched thousands of missing blobs
// one by one and a commit hung for 10+ minutes — in the app the 5-minute
// watchdog would have killed sync. The git factory (electron/sync/
// git-factory.ts appGitDirs) points core.hooksPath at an app-owned empty
// directory and GIT_TEMPLATE_DIR at an empty template directory, for every
// binary (the bundled git and the system-git fallback alike).
//
// The hooks below fail (exit 1) and leave a mark, so a hook that runs either
// breaks the sync or shows up in the marker file. Each scenario ends with
// settleAndCheck(world).

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

/** Every hook a sync could trigger (commit, rebase, checkout, push, ref updates). */
const HOOKS = [
  'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-rewrite',
  'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'pre-auto-gc', 'post-index-change',
]

/** A directory of failing hooks that append their name to `marker`. */
function failingHooks(dir: string, marker: string): string {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of HOOKS) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name}" >> '${marker}'\nexit 1\n`, { mode: 0o755 })
  }
  return dir
}

function ran(marker: string): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').split('\n').filter(Boolean) : []
}

describe('git:sync ignores the member\'s own git hooks and templates', { concurrency: CONCURRENCY }, () => {
  scenario('a global init.templateDir with a failing pre-commit: first setup copies nothing, sync succeeds, no hook runs', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], departments: ['営業部', '開発部'], seed: { '営業部/a.md': 'a\n', '開発部/b.md': 'b\n' } })
    const marker = path.join(world.root, 'hooks-ran.log')
    const template = path.join(world.root, 'user-template')
    failingHooks(path.join(template, 'hooks'), marker)
    world.appendGlobalConfig(`[init]\n\ttemplateDir = ${template}\n`)

    // The fixture works: a plain `git init` with this global config installs the hooks.
    // (Its failing reference-transaction hook makes that init itself fail.)
    try { world.git(world.root, ['init', '-q', 'probe']) } catch { /* expected */ }
    assert.ok(fs.existsSync(path.join(world.root, 'probe', '.git', 'hooks', 'pre-commit')), 'fixture: template not applied by plain git')
    fs.rmSync(marker, { force: true })

    // First setup (partial clone) with the app's git: no template copied.
    const p = await world.addPartialMember('p', { departments: ['営業部'] })
    for (const name of HOOKS) {
      assert.equal(fs.existsSync(path.join(p.dir, '.git', 'hooks', name)), false, `${name} copied from the member's template`)
    }

    const a = world.member('a')
    a.write('営業部/a.md', 'a2\n')
    ok(await a.sync(), 'a')
    p.write('営業部/a.md', 'p\n').write('営業部/new.md', 'new\n')
    ok(await p.sync(), 'p') // conflict with a: rebase, server version wins
    assert.equal(world.serverFile('営業部/new.md')?.toString(), 'new\n')

    await settleAndCheck(world)
    assert.deepEqual(ran(marker), [])
  })

  scenario('an existing install with failing hooks in .git/hooks and a global core.hooksPath: sync succeeds, no hook runs', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } })
    const [a, b] = world.members
    const marker = path.join(world.root, 'hooks-ran.log')
    failingHooks(path.join(a.dir, '.git', 'hooks'), marker)
    // The fixture works: plain git in a's clone runs the failing pre-commit.
    assert.throws(() => world.git(a.dir, ['commit', '-q', '--allow-empty', '-m', 'probe']))
    assert.ok(ran(marker).includes('pre-commit'), 'fixture: repository hook did not run under plain git')
    fs.rmSync(marker)

    // Also a core.hooksPath in the member's global config. The local
    // transport runs the server's receive-pack with the member's global
    // config too, which a real server never reads: pin the server's own.
    world.git(world.bare, ['config', 'core.hooksPath', path.join(world.bare, 'hooks')])
    world.appendGlobalConfig(`[core]\n\thooksPath = ${failingHooks(path.join(world.root, 'global-hooks'), marker)}\n`)

    b.write('x.md', 'b\n').write('b.md', 'b\n')
    ok(await b.sync(), 'b')
    a.write('x.md', 'a\n').write('a.md', 'a\n')
    ok(await a.sync(), 'a') // rebase over b's commit, conflict on x.md, rebase --continue, push
    a.write('a.md', 'a2\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile('a.md')?.toString(), 'a2\n')

    await settleAndCheck(world)
    assert.deepEqual(ran(marker), [])
  })
})

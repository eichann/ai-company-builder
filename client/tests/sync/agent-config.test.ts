// Default-deny in the agents' folders (2026-11-05): beyond the named config,
// everything in `.claude/` and Codex's `.agents/` is owner/admin only, except
// skill files and instruction files. The server refuses a member's change in
// the [PROTECTED_CONFIG] section old apps already recover from; sync must keep
// the member's version in .backups/, share their other work, and never stop
// on what running a tool leaves there. See .claude/rules/sync-guards.md,
// push-check.md.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { World, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const backupsOf = (m: Member) => m.backups().filter(b => b.metadata.reason === 'protected_config')

const STYLE = '.claude/output-styles/terse.md'
const STATUS = '.claude/statusline.sh'
const seed = { [STYLE]: 'v1\n', [STATUS]: 'echo v1\n' }

describe('git:sync agent config (default-deny)', { concurrency: CONCURRENCY }, () => {
  test('a member\'s change, a new file and a Codex marketplace go back to the server\'s; theirs is in .backups, other work is shared', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write(STYLE, 'mine\n').write('.agents/plugins/marketplace.json', '{}\n').write('notes.md', 'notes\n')

    const out = ok(await a.sync(), 'a')

    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.deepEqual([...(out.result.restoredProtectedFiles ?? [])].sort(), ['.agents/plugins/marketplace.json', STYLE])
    assert.equal(a.readText(STYLE), 'v1\n')
    assert.equal(a.exists('.agents/plugins/marketplace.json'), false)
    assert.equal(world.serverFile(STYLE)?.toString(), 'v1\n')
    assert.equal(world.serverFile('.agents/plugins/marketplace.json'), null)
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    const [backup] = backupsOf(a)
    assert.ok(backup, 'the member\'s version is kept')
    assert.equal(a.readText(`.backups/${backup.folder}/${STYLE}`), 'mine\n')
    assert.equal(a.readText(`.backups/${backup.folder}/.agents/plugins/marketplace.json`), '{}\n')
    assert.deepEqual(ok(await a.sync(), 'a').dialogs, [], 'and the next sync asks nothing')
    await settleAndCheck(world)
  })

  test('an owner shares it with no question; a member receives it', async t => {
    const world = World.create(t, { members: [{ name: 'o', role: 'owner' }, { name: 'b' }], seed })
    const [o, b] = world.members
    o.write(STATUS, 'echo v2\n')
    assert.deepEqual(ok(await o.sync(), 'o').dialogs, [])
    ok(await b.sync(), 'b')
    assert.equal(b.readText(STATUS), 'echo v2\n')
  })

  test('what running a tool leaves anywhere in .claude/, .agents/ or .codex/ is never shared and asks nothing; automatic sync would otherwise stop', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write('.claude/scripts/__pycache__/run.cpython-312.pyc', Buffer.from([0, 1, 2, 255]))
      .write('.claude/.DS_Store', Buffer.from([0, 1]))
      .write('営業部/.agents/skills/x/scripts/__pycache__/a.pyc', Buffer.from([0, 1]))
      .write('.codex/node_modules/x/index.js', 'x\n')
      .write('notes.md', 'notes\n')
    a.hasWindow = false
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    assert.equal(world.serverFile('.claude/.DS_Store'), null)
    assert.ok(a.exists('.claude/scripts/__pycache__/run.cpython-312.pyc'), 'it stays where it was')
  })

  test('Codex skills follow the skill rule: someone on 「Skill を直せる人」 shares one, a member\'s change goes back', async t => {
    const SKILL = '.agents/skills/report/run.py'
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed: { ...seed, [SKILL]: 'print(1)\n' } })
    const [a, b] = world.members
    world.setSkillEditing('a', { everywhere: true, folders: [] })
    a.write(SKILL, 'print(2)\n')
    assert.deepEqual(ok(await a.sync(), 'a').dialogs, [])
    assert.equal(world.serverFile(SKILL)?.toString(), 'print(2)\n')

    ok(await b.sync(), 'b')
    b.write(SKILL, 'print(3)\n')
    const out = ok(await b.sync(), 'b')
    assert.deepEqual(out.result.restoredProtectedFiles, [SKILL])
    assert.match(String(out.dialogs[0].options.detail), /Skill を直せる人/)
    assert.equal(b.readText(SKILL), 'print(2)\n')
    await settleAndCheck(world)
  })
})

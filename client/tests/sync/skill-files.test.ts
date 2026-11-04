// A member who may not change skill files: the server refuses the push
// ([PROTECTED_CONFIG], the sub-list for everything under
// .claude/skills|agents|commands, every file type) and sync's existing
// recovery must hold for what is new here — a script, a new file, a deletion,
// a rename. Nothing of theirs may be lost: their version goes to .backups/,
// their other work is shared. See .claude/rules/sync-guards.md, push-check.md.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { World, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const backupsOf = (m: Member) => m.backups().filter(b => b.metadata.reason === 'protected_config')

const backupText = (m: Member, folder: string, rel: string) => m.readText(`.backups/${folder}/${rel}`)

const SCRIPT = '.claude/skills/report/make.py'
const SKILL = '.claude/skills/report/SKILL.md'
const V1 = 'print("v1")\n'
const MINE = 'print("mine")\n'
const seed = { [SCRIPT]: V1, [SKILL]: '---\nname: report\n---\nbody\n' }

describe('git:sync skill files', { concurrency: CONCURRENCY }, () => {
  test('a member\'s change to a script: the dialog names the skill rule, the server version returns, theirs is in .backups, other work is shared', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write(SCRIPT, MINE).write('notes.md', 'notes\n')

    const out = ok(await a.sync(), 'a')

    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.match(String(out.dialogs[0].options.detail), /Skill を直せる人/)
    assert.deepEqual(out.result.restoredProtectedFiles, [SCRIPT])
    assert.match(String(out.result.message), /変更できないスキルの|スキル/)
    assert.equal(a.readText(SCRIPT), V1)
    assert.equal(world.serverFile(SCRIPT)?.toString(), V1)
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    const [backup] = backupsOf(a)
    assert.ok(backup, 'the member\'s version is kept')
    assert.deepEqual(backup.files, [SCRIPT])
    assert.equal(backupText(a, backup.folder, SCRIPT), MINE)
    await settleAndCheck(world)
  })

  test('cancelling changes nothing: the member\'s script stays on this computer', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write(SCRIPT, MINE).willAnswer('protectedConfig', 'cancel')
    const out = await a.sync()
    assert.equal(out.result.success, false)
    assert.equal(out.result.errorType, 'protected_config')
    assert.equal(a.readText(SCRIPT), MINE)
    assert.equal(world.serverFile(SCRIPT)?.toString(), V1)
  })

  test('a new skill file leaves the folder but not the member\'s hands', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write('.claude/skills/fresh/run.sh', 'echo mine\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.restoredProtectedFiles, ['.claude/skills/fresh/run.sh'])
    assert.equal(a.exists('.claude/skills/fresh/run.sh'), false)
    assert.equal(world.serverFile('.claude/skills/fresh/run.sh'), null)
    const [backup] = backupsOf(a)
    assert.equal(backupText(a, backup.folder, '.claude/skills/fresh/run.sh'), 'echo mine\n')
    await settleAndCheck(world)
  })

  test('a deleted script comes back; a renamed one is back under its old name, the new name in .backups', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.remove(SKILL).rename(SCRIPT, '.claude/skills/report/renamed.py')
    a.willAnswer('deletedFiles', 'sync-deletions')
    ok(await a.sync(), 'a')
    assert.equal(a.readText(SCRIPT), V1)
    assert.ok(a.exists(SKILL))
    assert.equal(a.exists('.claude/skills/report/renamed.py'), false)
    assert.equal(world.serverFile('.claude/skills/report/renamed.py'), null)
    const [backup] = backupsOf(a)
    assert.equal(backupText(a, backup.folder, '.claude/skills/report/renamed.py'), V1)
    await settleAndCheck(world)
  })

  test('someone on 「Skill を直せる人」 shares the script with no question; a teammate receives it', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed })
    const [a, b] = world.members
    world.setSkillEditing('a', { everywhere: true, folders: [] })
    a.write(SCRIPT, MINE)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(world.serverFile(SCRIPT)?.toString(), MINE)
    ok(await b.sync(), 'b')
    assert.equal(b.readText(SCRIPT), MINE)
  })

  test('a chmod +x alone is refused like any change: it goes back, the loop ends, other work is shared', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    fs.chmodSync(a.path(SCRIPT), 0o755)
    a.write('notes.md', 'notes\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.restoredProtectedFiles, [SCRIPT])
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    assert.equal(fs.statSync(a.path(SCRIPT)).mode & 0o111, 0, 'the mode is the server\'s again')
    assert.equal(a.readText(SCRIPT), V1)
    assert.deepEqual(ok(await a.sync(), 'a').dialogs, [], 'and the next sync asks nothing')
    await settleAndCheck(world)
  })

  test('a chmod +x with nothing else to share also ends: no commit is left behind', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    fs.chmodSync(a.path(SCRIPT), 0o755)
    ok(await a.sync(), 'a')
    assert.equal(a.git(['rev-list', '--count', 'origin/main..HEAD']).trim(), '0')
    await settleAndCheck(world)
  })

  test('what running a skill leaves in its folder is never shared and asks nothing; automatic sync would otherwise stop', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write('.claude/skills/report/__pycache__/make.cpython-312.pyc', Buffer.from([0, 1, 2, 255]))
      .write('.claude/skills/report/.DS_Store', Buffer.from([0, 1]))
      .write('営業部/.claude/skills/x/tools/app/package-lock.json', '{}\n')
      .write('営業部/.claude/skills/x/tools/app/dist/index.html', '<html>\n')
      .write('営業部/.claude/skills/x/tools/app/.next/cache/a', 'x\n')
      .write('notes.md', 'notes\n')
    a.hasWindow = false
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(world.serverFile('notes.md')?.toString(), 'notes\n')
    assert.equal(world.serverFile('.claude/skills/report/.DS_Store'), null)
    assert.ok(a.exists('.claude/skills/report/__pycache__/make.cpython-312.pyc'), 'it stays where it was')
  })

  test('a lock file the company already shares stays tracked: changing it does not delete it for everyone', async t => {
    const LOCK = '.claude/skills/report/tools/app/package-lock.json'
    const world = World.create(t, { members: [{ name: 'a' }], seed: { ...seed, [LOCK]: '{"v":1}\n' } })
    const [a] = world.members
    world.setSkillEditing('a', { everywhere: true, folders: [] })
    a.write(LOCK, '{"v":2}\n')
    ok(await a.sync(), 'a')
    assert.equal(world.serverFile(LOCK)?.toString(), '{"v":2}\n')
  })

  test('a pull that fails is not a finished sync: the member is told, nothing of theirs moved, the next sync catches up', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], seed })
    const [a, b] = world.members
    a.write('from-a.md', 'a\n')
    ok(await a.sync(), 'a')
    b.write('from-b.md', 'b\n').failNextPull()
    const failed = await b.sync()
    assert.equal(failed.result.success, false)
    assert.equal(failed.result.errorType, 'pull_failed')
    assert.match(String(failed.result.error), /受け取れなかった/)
    assert.equal(b.readText('from-b.md'), 'b\n')
    ok(await b.sync(), 'b')
    assert.equal(b.readText('from-a.md'), 'a\n')
    assert.equal(world.serverFile('from-b.md')?.toString(), 'b\n')
  })

  test('a member with an existing skill and no change of it syncs as ever', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], seed })
    const [a] = world.members
    a.write('notes.md', 'notes\n')
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.dialogs, [])
    assert.equal(a.readText(SCRIPT), V1)
  })
})

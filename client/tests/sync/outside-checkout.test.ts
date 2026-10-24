// Files created inside a department the member excluded from their checkout
// (settings panel, or not picked at first setup — a partial clone). The
// folder is absent on disk, so the member — or the chat AI — cannot see what
// teammates keep there; a file written at e.g. 営業部/提案書.md lands on the
// path of a teammate's file the member never had. Sync must never share such
// a file over the teammate's: it is held back in .backups/<ts>_outside_checkout/
// (reason `outside_checkout`) and reported. See .claude/rules/sync-guards.md.
//
// Every scenario runs for a full clone with the department excluded in
// settings and for a partial-clone member who did not pick it, and ends with
// settleAndCheck(world).

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { World, Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const SEED: Record<string, string> = {
  '営業部/提案書.md': 'sales v0\n',
  '営業部/顧客/A社.md': 'A社 v0\n',
  '開発部/設計.md': 'dev v0\n',
  'shared/規程.md': 'rules v0\n',
}

type Kind = 'full clone, department excluded in settings' | 'partial clone, department not picked'
const KINDS: Kind[] = ['full clone, department excluded in settings', 'partial clone, department not picked']

/** Teammate `a` (everything checked out) and member `x` who does not have 営業部. */
async function create(t: TestContext, kind: Kind): Promise<{ world: World; a: Member; x: Member }> {
  const world = World.create(t, {
    members: [{ name: 'a' }],
    departments: ['営業部', '開発部'],
    seed: SEED,
  })
  let x: Member
  if (kind === 'partial clone, department not picked') {
    x = await world.addPartialMember('x', { departments: ['開発部'] })
  } else {
    x = new Member(world, 'x', 'member')
    world.members.push(x)
    const res = await x.removeDepartment('営業部')
    assert.equal(res.success, true, JSON.stringify(res))
  }
  assert.equal(x.exists('営業部'), false, 'precondition: 営業部 is not on x\'s disk')
  return { world, a: world.member('a'), x }
}

function outsideCheckoutBackup(m: Member) {
  return m.backups().filter(b => b.metadata.reason === 'outside_checkout').at(-1)
}

/** The held-back file is in .backups/<ts>_outside_checkout/ byte for byte, and gone from the excluded folder. */
function assertHeldBack(m: Member, out: SyncOutcome, files: Record<string, string>): void {
  const backup = outsideCheckoutBackup(m)
  assert.ok(backup, `no outside_checkout backup; result: ${JSON.stringify(out.result)}`)
  assert.match(backup.folder, /_outside_checkout$/)
  for (const [rel, content] of Object.entries(files)) {
    assert.ok(backup.files.includes(rel), `${rel} not in ${backup.folder}: ${backup.files.join(', ')}`)
    assert.equal(fs.readFileSync(m.path(`.backups/${backup.folder}/${rel}`), 'utf-8'), content)
    assert.equal(m.exists(rel), false, `${rel} should have been moved out of the excluded folder`)
  }
  assert.deepEqual([...(backup.metadata.files as string[])].sort(), Object.keys(files).sort())
  assert.deepEqual([...(out.result.outsideCheckoutFiles ?? [])].sort(), Object.keys(files).sort())
  assert.match(out.result.message ?? '', /ダウンロードしていないフォルダ（営業部）にファイルが作られていたため、共有せずに \.backups に保存しました/)
  assert.equal(out.dialogs.filter(d => d.kind === 'deletedFiles').length, 0, 'no deletion warning')
}

describe('git:sync files created in a department outside the checkout', { concurrency: CONCURRENCY }, () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      scenario('a file over a teammate\'s file it never had is not shared; it is kept in .backups', async t => {
        const { world, x } = await create(t, kind)
        x.write('営業部/提案書.md', 'AI draft\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v0\n', 'the teammate\'s file was replaced on the server')
        assertHeldBack(x, out, { '営業部/提案書.md': 'AI draft\n' })
        assert.deepEqual(outsideCheckoutBackup(x)!.metadata.serverFiles, ['営業部/提案書.md'])
        await settleAndCheck(world)
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v0\n')
        assert.equal(x.exists('営業部'), false)
        if (x.partial) {
          // Checking the file against the index never downloads the teammate's version.
          assert.ok(x.missingObjects().has(world.serverTree().get('営業部/提案書.md')!), 'x downloaded 営業部/提案書.md')
        }
      })

      scenario('a new file and a new subfolder in the excluded department are held back too', async t => {
        const { world, x } = await create(t, kind)
        x.write('営業部/新規.md', 'new\n').write('営業部/新フォルダ/メモ.md', 'memo\n').write('営業部/顧客/B社.md', 'B社\n')
        const out = ok(await x.sync(), 'x')
        for (const f of ['営業部/新規.md', '営業部/新フォルダ/メモ.md', '営業部/顧客/B社.md']) {
          assert.equal(world.serverFile(f), null, `${f} was shared into a department x does not have`)
        }
        assertHeldBack(x, out, { '営業部/新規.md': 'new\n', '営業部/新フォルダ/メモ.md': 'memo\n', '営業部/顧客/B社.md': 'B社\n' })
        assert.deepEqual(outsideCheckoutBackup(x)!.metadata.serverFiles, [])
        await settleAndCheck(world)
        assert.equal(world.serverFile('営業部/顧客/A社.md')?.toString(), 'A社 v0\n')
        assert.equal(x.exists('営業部'), false)
      })

      scenario('a file at the path of a teammate\'s file the server deleted meanwhile', async t => {
        const { world, a, x } = await create(t, kind)
        a.remove('営業部/提案書.md')
        ok(await a.sync(), 'a')
        x.write('営業部/提案書.md', 'AI draft\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile('営業部/提案書.md'), null)
        assertHeldBack(x, out, { '営業部/提案書.md': 'AI draft\n' })
        await settleAndCheck(world)
      })

      scenario('a teammate edits the same file concurrently: their version stays, the member\'s is kept', async t => {
        const { world, a, x } = await create(t, kind)
        a.write('営業部/提案書.md', 'sales v1 by a\n')
        ok(await a.sync(), 'a')
        x.write('営業部/提案書.md', 'AI draft\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v1 by a\n')
        assertHeldBack(x, out, { '営業部/提案書.md': 'AI draft\n' })
        await settleAndCheck(world)
      })

      scenario('files in downloaded folders are shared as usual and never deleted; ignored files stay put', async t => {
        const { world, x } = await create(t, kind)
        x.write('開発部/新規.md', 'dev new\n').write('開発部/設計.md', 'dev v1\n').write('root.md', 'root\n')
          .write('営業部/提案書.md', 'AI draft\n')
          .write('営業部/.personal/memo.md', 'private\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile('開発部/新規.md')?.toString(), 'dev new\n')
        assert.equal(world.serverFile('開発部/設計.md')?.toString(), 'dev v1\n')
        assert.equal(world.serverFile('root.md')?.toString(), 'root\n')
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v0\n')
        assert.equal(world.serverFile('営業部/.personal/memo.md'), null)
        assertHeldBack(x, out, { '営業部/提案書.md': 'AI draft\n' })
        // Local-only content stays where the member put it.
        assert.equal(x.readText('営業部/.personal/memo.md'), 'private\n')
        assert.equal(x.readText('開発部/新規.md'), 'dev new\n')
        await settleAndCheck(world)
        // Neither folder protection nor the sparse reconcile removed anything of the member's.
        assert.equal(x.readText('開発部/新規.md'), 'dev new\n')
        assert.equal(x.readText('開発部/設計.md'), 'dev v1\n')
        assert.equal(x.readText('root.md'), 'root\n')
        assert.equal(x.readText('営業部/.personal/memo.md'), 'private\n')
      })

      scenario('excluding a department keeps its local-only (ignored) files on disk, across syncs', async t => {
        const { world, x } = await create(t, kind)
        x.write('開発部/.personal/memo.md', 'private\n').write('開発部/.env.local', 'TOKEN=local\n').write('開発部/.personal/sub/a.md', 'a\n')
        ok(await x.sync(), 'x')
        const res = await x.removeDepartment('開発部')
        assert.equal(res.success, true, JSON.stringify(res))
        // `sparse-checkout set` deletes ignored files in tracked folders that leave the cone.
        assert.equal(x.readText('開発部/.personal/memo.md'), 'private\n')
        assert.equal(x.readText('開発部/.personal/sub/a.md'), 'a\n')
        assert.equal(x.readText('開発部/.env.local'), 'TOKEN=local\n')
        assert.equal(fs.existsSync(x.path('.git/acb-sparse-keep')), false)
        const out = ok(await x.sync(), 'x')
        assert.equal(out.result.outsideCheckoutFiles, undefined)
        await settleAndCheck(world)
        assert.equal(x.readText('開発部/.personal/memo.md'), 'private\n')
        assert.equal(x.readText('開発部/.env.local'), 'TOKEN=local\n')
        assert.equal(world.serverFile('開発部/.personal/memo.md'), null)
      })

      scenario('files staged by an older app\'s preview (`git add --sparse .`) are held back all the same', async t => {
        const { world, a, x } = await create(t, kind)
        a.write('営業部/提案書.md', 'sales v1 by a\n')
        ok(await a.sync(), 'a')
        x.write('営業部/提案書.md', 'AI draft\n').write('営業部/新規.md', 'new\n').write('営業部/新フォルダ/メモ.md', 'memo\n')
          .write('開発部/設計.md', 'dev v1\n')
        // What git:preview did before it became read-only: the files are in
        // the index, so they no longer read as new or as differing from it.
        x.git(['add', '--sparse', '.'])
        assert.match(x.git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only']), /営業部\/新規\.md/, 'precondition: staged')
        const out = ok(await x.sync(), 'x')
        for (const f of ['営業部/新規.md', '営業部/新フォルダ/メモ.md']) {
          assert.equal(world.serverFile(f), null, `${f} was shared into a department x does not have`)
        }
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v1 by a\n', 'the teammate\'s file was replaced on the server')
        assert.equal(world.serverFile('開発部/設計.md')?.toString(), 'dev v1\n', 'the rest is shared')
        assertHeldBack(x, out, { '営業部/提案書.md': 'AI draft\n', '営業部/新規.md': 'new\n', '営業部/新フォルダ/メモ.md': 'memo\n' })
        assert.equal(x.exists('営業部'), false)
        await settleAndCheck(world)
        assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v1 by a\n')
        assert.equal(x.exists('営業部'), false)
      })

      scenario('nothing created outside the checkout: no backup, no note', async t => {
        const { world, x } = await create(t, kind)
        x.write('開発部/設計.md', 'dev v1\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(out.result.outsideCheckoutFiles, undefined)
        assert.equal(outsideCheckoutBackup(x), undefined)
        assert.doesNotMatch(out.result.message ?? '', /ダウンロードしていないフォルダ/)
        await settleAndCheck(world)
      })
    })
  }

  scenario('an edit the member made before excluding the department is held back too (cannot be told apart)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'x' }], departments: ['営業部', '開発部'], seed: SEED })
    const x = world.member('x')
    x.write('営業部/提案書.md', 'x edit before excluding\n')
    const res = await x.removeDepartment('営業部')
    assert.equal(res.success, true, JSON.stringify(res))
    // git keeps a modified file when its folder leaves the cone.
    assert.equal(x.readText('営業部/提案書.md'), 'x edit before excluding\n')
    const out = ok(await x.sync(), 'x')
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v0\n')
    assertHeldBack(x, out, { '営業部/提案書.md': 'x edit before excluding\n' })
    await settleAndCheck(world)
  })
})

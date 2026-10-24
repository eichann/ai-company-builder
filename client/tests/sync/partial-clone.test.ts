// Partial-clone members: a member who set the company up for the first time
// and picked departments has only those departments' blobs (plus the root
// files, dotfolders such as .claude, and non-department folders). Everything
// else exists as commits and trees only and is fetched lazily when git needs
// it. Every sync guard has to keep working with blobs missing locally, and a
// member must never end up downloading the departments they did not pick
// just by syncing. See .claude/rules/download-choices.md and sync-guards.md.
//
// Partial members are created with World.addPartialMember, which runs the
// app's own first setup (electron/sync/first-setup.ts) over file:// (git
// ignores --filter for a plain local path). Each scenario ends with
// settleAndCheck(world).

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, DEFAULT_SCOPES, type HarnessScope, type Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'
import { DOWNLOAD_NEEDS_NETWORK_MESSAGE, readSparseConfig } from '../../electron/sync/sparse'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const BIG = Buffer.alloc(64 * 1024, 7) // the pptx / mp4 a department is mostly made of
const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, seed, 0x00, 0x10, 0x80, seed ^ 0xff])

const SEED: Record<string, string | Buffer> = {
  '営業部/提案書.md': 'sales v0\n',
  '営業部/図.png': PNG(1),
  '開発部/設計.md': 'dev v0\n',
  '開発部/demo.mp4': BIG,
  '開発部/old.md': 'old\n',
  '経理部/予算.md': '予算 v0\n',
  '.claude/skills/s/SKILL.md': '---\nname: s\n---\nbody\n',
  '.mcp.json': '{"mcpServers":{}}\n',
  'shared/規程.md': 'rules v0\n',
}

/** A world with full members a + admin and partial member p (picked: `picked`). */
async function create(t: TestContext, picked = ['営業部']): Promise<{ world: World; a: Member; admin: Member; p: Member }> {
  const world = World.create(t, {
    members: [{ name: 'a' }, { name: 'admin', role: 'admin' }],
    departments: ['営業部', '開発部', '経理部'],
    seed: SEED,
  })
  const p = await world.addPartialMember('p', { departments: picked })
  return { world, a: world.member('a'), admin: world.member('admin'), p }
}

/**
 * Blobs of the server's current tree under `prefix` that `m` must not have
 * downloaded (ignoring blobs that also occur inside its cone, e.g. the
 * empty .gitkeep).
 */
function assertNotDownloaded(world: World, m: Member, prefix: string): void {
  const tree = world.serverTree()
  const coneOids = new Set([...tree].filter(([f]) => !f.startsWith(prefix)).map(([, oid]) => oid))
  const missing = m.missingObjects()
  const downloaded = [...tree].filter(([f, oid]) => f.startsWith(prefix) && !coneOids.has(oid) && !missing.has(oid))
  assert.deepEqual(downloaded.map(([f]) => f), [], `${m.name} downloaded files outside its departments`)
}

describe('git:sync partial-clone members', { concurrency: CONCURRENCY }, () => {
  scenario('first setup downloads only the picked departments plus shared files', async t => {
    const { world, p } = await create(t)
    for (const f of ['営業部/提案書.md', '営業部/図.png', 'README.md', '.gitignore', '.mcp.json', '.claude/skills/s/SKILL.md', 'shared/規程.md']) {
      assert.ok(p.exists(f), `${f} should be downloaded`)
    }
    assert.equal(p.exists('開発部'), false)
    assert.equal(p.exists('経理部'), false)
    assert.deepEqual(readSparseConfig(p.dir).excluded.sort(), ['経理部', '開発部'])
    assert.equal(p.git(['config', 'remote.origin.promisor']).trim(), 'true')
    assertNotDownloaded(world, p, '開発部/')
    assertNotDownloaded(world, p, '経理部/')
    assert.equal(p.git(['status', '--porcelain']).trim(), '')
    ok(await p.sync(), 'p')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('own department edits while teammates edit other departments and root files', async t => {
    const { world, a, p } = await create(t)
    a.write('開発部/設計.md', 'dev v1\n').write('開発部/new.bin', Buffer.concat([BIG, Buffer.from('new')]))
      .append('README.md', 'a was here\n').write('shared/規程.md', 'rules v1\n')
    p.write('営業部/提案書.md', 'sales v1\n').write('営業部/新規.md', 'new\n')
    ok(await a.sync(), 'a')
    ok(await p.sync(), 'p') // rebases onto a's commit
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v1\n')
    assert.equal(world.serverFile('営業部/新規.md')?.toString(), 'new\n')
    assert.match(p.readText('README.md'), /a was here/)
    assert.equal(p.readText('shared/規程.md'), 'rules v1\n')
    assertNotDownloaded(world, p, '開発部/')

    // The other way round: p pushes first, a rebases onto it.
    p.append('営業部/提案書.md', 'p again\n')
    a.append('開発部/設計.md', 'a again\n').append('README.md', 'a again\n')
    ok(await p.sync(), 'p')
    ok(await a.sync(), 'a')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'sales v1\np again\n')
  })

  scenario('conflict in its own department: server version wins, the local version (text and binary) is backed up', async t => {
    const { world, a, p } = await create(t)
    a.write('営業部/提案書.md', 'a version\n').write('営業部/図.png', PNG(2))
    ok(await a.sync(), 'a')
    p.write('営業部/提案書.md', 'p version\n').write('営業部/図.png', PNG(3))
    const out = ok(await p.sync(), 'p')
    assert.equal(out.result.hadConflicts, true)
    assert.deepEqual([...(out.result.conflictFiles ?? [])].sort(), ['営業部/図.png', '営業部/提案書.md'])
    const backup = p.backups().filter(b => b.metadata.reason === 'conflict').at(-1)!
    assert.equal(fs.readFileSync(path.join(p.dir, '.backups', backup.folder, '営業部/提案書.md'), 'utf-8'), 'p version\n')
    assert.ok(fs.readFileSync(path.join(p.dir, '.backups', backup.folder, '営業部/図.png')).equals(PNG(3)))
    assert.equal(p.readText('営業部/提案書.md'), 'a version\n')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('teammate renames, rewrites and deletes files outside the cone, and moves one into it', async t => {
    const { world, a, p } = await create(t)
    // p has an unpushed commit to replay (it was offline).
    p.offline().write('営業部/提案書.md', 'p offline\n')
    const offline = await p.sync()
    assert.equal(offline.result.errorType, 'push_failed')
    p.online()

    // Rename + rewrite (below the similarity threshold), delete, and a move
    // of a big file into p's department.
    a.rename('開発部/設計.md', '開発部/docs/設計-改.md').write('開発部/docs/設計-改.md', 'completely different\n')
    a.remove('開発部/old.md').rename('開発部/demo.mp4', '営業部/demo.mp4')
    ok(await a.sync(), 'a')

    ok(await p.sync(), 'p')
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p offline\n')
    assert.ok(p.read('営業部/demo.mp4').equals(BIG), 'the file moved into p\'s department is downloaded')
    assert.equal(p.exists('開発部'), false)
    assert.equal(world.serverFile('開発部/old.md'), null)
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('adding a department later downloads it; removing it again keeps today\'s behaviour', async t => {
    const { world, a, p } = await create(t)
    a.write('開発部/設計.md', 'dev v1\n')
    ok(await a.sync(), 'a')
    ok(await p.sync(), 'p')
    assertNotDownloaded(world, p, '開発部/')

    const added = await p.addDepartment('開発部')
    assert.deepEqual(added, { success: true, enabled: true, excluded: ['経理部'] })
    assert.equal(p.readText('開発部/設計.md'), 'dev v1\n')
    assert.ok(p.read('開発部/demo.mp4').equals(BIG))
    assert.equal(p.git(['status', '--porcelain']).trim(), '')

    p.write('開発部/設計.md', 'dev v2 by p\n')
    ok(await p.sync(), 'p')
    assert.equal(world.serverFile('開発部/設計.md')?.toString(), 'dev v2 by p\n')

    const removed = await p.removeDepartment('開発部')
    assert.equal(removed.success, true)
    assert.equal(p.exists('開発部'), false)
    assert.equal(p.git(['status', '--porcelain']).trim(), '')
    await settleAndCheck(world)
    assert.equal(p.exists('開発部'), false, 'a removed department stays removed across syncs')
  })

  scenario('reopening the company keeps the partial clone: a department added afterwards downloads just that department', async t => {
    const { world, a, p } = await create(t)
    a.write('開発部/設計.md', 'dev v1\n').write('経理部/予算.md', '予算 v1\n')
    ok(await a.sync(), 'a')
    const url = p.git(['config', 'remote.origin.url']).trim()
    // Company selector → the same folder again (the URL unchanged, changed, back).
    const warnings = [...await p.reopen()]
    // Reopening pulled a's commit; the excluded departments stayed excluded.
    assert.equal(p.head(), world.serverHead())
    warnings.push(...await p.reopen(`${url}/`))
    assert.equal(p.git(['config', 'remote.origin.url']).trim(), `${url}/`)
    warnings.push(...await p.reopen(url))
    // Kept, not repaired: nothing had to be restored.
    assert.deepEqual(warnings.filter(w => /promisor/.test(w)), [])
    assert.equal(p.git(['config', 'remote.origin.promisor']).trim(), 'true')
    assert.equal(p.git(['config', 'remote.origin.partialclonefilter']).trim(), 'blob:none')
    assertNotDownloaded(world, p, '開発部/')
    assertNotDownloaded(world, p, '経理部/')

    // ダウンロードして同期を開始 on 開発部 (the bug: "unable to read sha1 file").
    const added = await p.addDepartment('開発部')
    assert.deepEqual(added, { success: true, enabled: true, excluded: ['経理部'] })
    assert.equal(p.readText('開発部/設計.md'), 'dev v1\n')
    assert.ok(p.read('開発部/demo.mp4').equals(BIG))
    assertNotDownloaded(world, p, '経理部/')
    ok(await p.sync(), 'p')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '経理部/')
  })

  scenario('a partial clone that lost its promisor config (old remote remove + add) heals itself', async t => {
    const { world, a, p } = await create(t)
    const config = (key: string) => { try { return p.git(['config', '--get', key]).trim() } catch { return '' } }
    const breakIt = () => {
      // What git:setupCompanyRemote did on every reopen before the fix.
      const url = p.git(['config', 'remote.origin.url']).trim()
      p.git(['remote', 'remove', 'origin'])
      p.git(['remote', 'add', 'origin', url])
      p.git(['fetch', '-q', 'origin'])
      assert.equal(config('remote.origin.promisor'), '')
      assert.equal(config('remote.origin.partialclonefilter'), '')
    }
    a.write('開発部/設計.md', 'dev v1\n')
    ok(await a.sync(), 'a')

    // Before a sparse change (settings panel / download button).
    breakIt()
    assert.throws(() => world.git(p.dir, ['sparse-checkout', 'set', '--no-cone', '/*', '!/経理部/']),
      /unable to read|invalid object|missing/i, 'the broken state: missing blobs cannot be fetched')
    const added = await p.addDepartment('開発部')
    assert.deepEqual(added, { success: true, enabled: true, excluded: ['経理部'] })
    assert.equal(config('remote.origin.promisor'), 'true')
    assert.equal(config('remote.origin.partialclonefilter'), 'blob:none')
    assert.equal(p.readText('開発部/設計.md'), 'dev v0\n') // HEAD; a's v1 arrives with the next sync
    assertNotDownloaded(world, p, '経理部/')

    // Before sync: a teammate's rename outside the cone needs a blob p never had.
    breakIt()
    a.rename('経理部/予算.md', '経理部/予算2026.md').append('開発部/設計.md', 'a again\n')
    ok(await a.sync(), 'a')
    p.write('営業部/提案書.md', 'p after heal\n')
    ok(await p.sync(), 'p')
    assert.equal(config('remote.origin.promisor'), 'true')
    assert.equal(config('remote.origin.partialclonefilter'), 'blob:none')
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p after heal\n')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '経理部/')
  })

  scenario('offline: adding a department changes nothing and says why; sync fails like a full clone\'s', async t => {
    const { world, a, p } = await create(t)
    p.offline()
    const sparseBefore = p.git(['sparse-checkout', 'list'])
    const added = await p.addDepartment('開発部')
    assert.deepEqual(added, { success: false, offline: true, error: DOWNLOAD_NEEDS_NETWORK_MESSAGE })
    assert.equal(DOWNLOAD_NEEDS_NETWORK_MESSAGE, 'インターネットにつながっているときにダウンロードできます')
    assert.deepEqual(readSparseConfig(p.dir).excluded.sort(), ['経理部', '開発部'])
    assert.equal(p.git(['sparse-checkout', 'list']), sparseBefore)
    assert.equal(p.exists('開発部'), false)
    assert.equal(p.git(['status', '--porcelain']).trim(), '')

    // Sync while offline: the same clean failure a full clone gets.
    p.write('営業部/提案書.md', 'p offline edit\n')
    a.offline().write('shared/規程.md', 'a offline edit\n')
    const pOut = await p.sync()
    const aOut = await a.sync()
    assert.equal(pOut.result.success, false)
    assert.equal(pOut.result.errorType, 'push_failed')
    assert.equal(pOut.result.error, aOut.result.error)
    assert.equal(p.hasPendingPush(), true)

    await settleAndCheck(world) // online again
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p offline edit\n')
    assertNotDownloaded(world, p, '開発部/')
    assert.equal((await p.addDepartment('開発部')).success, true)
    assert.equal(p.readText('開発部/設計.md'), 'dev v0\n')
  })

  scenario('a department a teammate creates later appears automatically (the exclusion model)', async t => {
    const { world, a, p } = await create(t)
    a.write('新部署/メモ.md', 'new department\n')
    ok(await a.sync(), 'a')
    ok(await p.sync(), 'p')
    assert.equal(p.readText('新部署/メモ.md'), 'new department\n')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('PROTECTED_CONFIG recovery for a partial member', async t => {
    const { world, admin, p } = await create(t)
    admin.write('開発部/設計.md', 'admin edit outside p\'s cone\n')
    ok(await admin.sync(), 'admin')
    p.write('.mcp.json', '{"mcpServers":{"evil":{"command":"x"}}}\n').write('営業部/提案書.md', 'p edit\n')
    const out = ok(await p.sync(), 'p')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['protectedConfig', 'restore']])
    assert.deepEqual(out.result.restoredProtectedFiles, ['.mcp.json'])
    assert.equal(world.serverFile('.mcp.json')?.toString(), SEED['.mcp.json'])
    assert.equal(p.readText('.mcp.json'), SEED['.mcp.json'])
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p edit\n')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('WRITE_DENIED recovery for a partial member', async t => {
    const { world, a, p } = await create(t, ['営業部', '経理部'])
    const deny: HarnessScope = {
      id: 'scope-keiri', path: '経理部', kind: 'folder', departmentId: null, repoId: null,
      rules: [
        { id: 'r-everyone', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true },
        { id: 'r-p', subjectType: 'user', subjectId: 'user-p', canRead: true, canWrite: false },
      ],
    }
    world.setScopes([...DEFAULT_SCOPES, deny])
    a.write('開発部/設計.md', 'a edit outside p\'s cone\n')
    ok(await a.sync(), 'a')
    p.write('経理部/予算.md', '予算 by p\n').write('営業部/提案書.md', 'p edit\n')
    const out = ok(await p.sync(), 'p')
    assert.deepEqual(out.dialogs.map(d => [d.kind, d.answer]), [['writeDenied', 'restore']])
    assert.deepEqual(out.result.restoredWriteDeniedFiles, ['経理部/予算.md'])
    assert.equal(world.serverFile('経理部/予算.md')?.toString(), '予算 v0\n')
    assert.equal(p.readText('経理部/予算.md'), '予算 v0\n')
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p edit\n')
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  scenario('department folder protection restores its own department, never an excluded one', async t => {
    const { world, p } = await create(t)
    p.remove('営業部')
    const out = ok(await p.sync(), 'p')
    assert.deepEqual(out.result.restoredFolders, ['営業部'])
    assert.equal(p.readText('営業部/提案書.md'), 'sales v0\n')
    assert.equal(p.exists('開発部'), false)
    assert.equal(p.exists('経理部'), false)
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })

  // Found by the mixed soak (seed 107): a root folder the server did not have
  // when the cone was set is outside the cone, so resolving or untracking a
  // path in it needs --sparse — without it every sync failed at that pick.
  scenario('paths in a root folder created after the cone was set: conflict and protected-config restore', async t => {
    const { world, a, p } = await create(t)
    a.write('新しい場所/logo.png', PNG(4))
    ok(await a.sync(), 'a')
    // p creates the same new folder before its next sync (its cone predates it).
    p.write('新しい場所/logo.png', PNG(5))
      .write('別の場所/.personal/メモ.md', 'private\n')
      .write('別の場所/.mcp.json', '{"mcpServers":{"x":{"command":"x"}}}\n')
      .write('営業部/提案書.md', 'p edit\n')
    const out = ok(await p.sync(), 'p')
    assert.equal(out.result.hadConflicts, true)
    assert.deepEqual(out.result.conflictFiles, ['新しい場所/logo.png'])
    assert.ok(p.read('新しい場所/logo.png').equals(PNG(4)))
    const backup = p.backups().filter(b => b.metadata.reason === 'conflict').at(-1)!
    assert.ok(fs.readFileSync(path.join(p.dir, '.backups', backup.folder, '新しい場所/logo.png')).equals(PNG(5)))
    assert.equal(world.serverFile('別の場所/.personal/メモ.md'), null)
    assert.equal(p.readText('別の場所/.personal/メモ.md'), 'private\n')
    assert.deepEqual(out.result.restoredProtectedFiles, ['別の場所/.mcp.json'])
    assert.equal(world.serverFile('別の場所/.mcp.json'), null)
    assert.equal(world.serverFile('営業部/提案書.md')?.toString(), 'p edit\n')
    await settleAndCheck(world)
  })

  scenario('nested repository and .gitignore union merge in a partial clone', async t => {
    const { world, a, p } = await create(t)
    // Both change the root .gitignore (union merge), p adds a nested repo in
    // its department, a edits a department .gitignore outside p's cone.
    a.append('.gitignore', '*.a-tmp\n').write('開発部/.gitignore', '*.log\n')
    ok(await a.sync(), 'a')
    p.append('.gitignore', '*.p-tmp\n').initNestedRepo('営業部/外部ツール')
    const out = ok(await p.sync(), 'p')
    assert.deepEqual(out.result.excludedNestedRepos, ['営業部/外部ツール'])
    const gitignore = world.serverFile('.gitignore')?.toString() ?? ''
    for (const line of ['*.a-tmp', '*.p-tmp', '/営業部/外部ツール/']) assert.ok(gitignore.split('\n').includes(line), `.gitignore lacks ${line}`)
    await settleAndCheck(world)
    assertNotDownloaded(world, p, '開発部/')
  })
})

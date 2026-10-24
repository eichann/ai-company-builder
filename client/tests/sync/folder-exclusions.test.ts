// Folder-level download choices: a member can leave any folder — not only a
// whole department — undownloaded (settings → ダウンロードするフォルダ).
// Everything else is downloaded, including folders teammates create later;
// the sparse checkout is non-cone (`/*` + `!/<folder>/`, see
// electron/sync/sparse.ts and shared/sparse-paths.ts).
//
// Every scenario in the first block runs for a full clone and for a
// partial-clone member (first setup with the department picked), and ends
// with settleAndCheck(world). See .claude/rules/download-choices.md and
// the sparse guards in .claude/rules/sync-guards.md.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, Member, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'
import { DOWNLOAD_NEEDS_NETWORK_MESSAGE, appliedExclusions, readSparseConfig, uncommittedChangesIn } from '../../electron/sync/sparse'
import { notDownloadedFolderFor, notDownloadedFolders } from '../../electron/sync/not-downloaded'
import { decideToolWrite } from '../../electron/write-guard'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) =>
  test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const BIG = Buffer.alloc(48 * 1024, 7)
const VIDEO = 'コンテンツ/動画'

const SEED: Record<string, string | Buffer> = {
  'コンテンツ/top.md': 'top v0\n',
  'コンテンツ/動画/intro.mp4': BIG,
  'コンテンツ/動画/編集/cut.md': 'cut v0\n',
  'コンテンツ/動画/台本.md': 'script v0\n',
  'コンテンツ/記事/a.md': 'article v0\n',
  '営業部/提案書.md': 'sales v0\n',
  'shared/規程.md': 'rules v0\n',
}

type Kind = 'full clone' | 'partial clone'
const KINDS: Kind[] = ['full clone', 'partial clone']

/** Teammate `a` (everything) and member `x` who excludes コンテンツ/動画 in settings. */
async function create(t: TestContext, kind: Kind, exclude: string | null = VIDEO): Promise<{ world: World; a: Member; x: Member }> {
  const world = World.create(t, { members: [{ name: 'a' }], departments: ['コンテンツ', '営業部'], seed: SEED })
  let x: Member
  if (kind === 'partial clone') {
    x = await world.addPartialMember('x', { departments: ['コンテンツ'] })
  } else {
    x = new Member(world, 'x', 'member')
    world.members.push(x)
  }
  if (exclude) {
    const res = await x.excludeFolder(exclude)
    assert.equal(res.success, true, JSON.stringify(res))
  }
  return { world, a: world.member('a'), x }
}

/** Every file of the checkout on disk (no .git, no .backups). */
function filesOnDisk(m: Member): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(m.path(rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === '.git' || r === '.backups') continue
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk('')
  return out.sort()
}

/** Server blobs under `prefix` that `m` downloaded although they occur nowhere else in the tree. */
function downloadedUnder(world: World, m: Member, prefix: string): string[] {
  const tree = world.serverTree()
  const elsewhere = new Set([...tree].filter(([f]) => !f.startsWith(prefix)).map(([, oid]) => oid))
  const missing = m.missingObjects()
  return [...tree].filter(([f, oid]) => f.startsWith(prefix) && !elsewhere.has(oid) && !missing.has(oid)).map(([f]) => f)
}

function outsideCheckoutBackup(m: Member) {
  return m.backups().filter(b => b.metadata.reason === 'outside_checkout').at(-1)
}

describe('git:sync folder-level download choices', { concurrency: CONCURRENCY }, () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      scenario('excluding a sub-folder of a downloaded department removes just that folder; sync keeps it that way', async t => {
        const { world, x } = await create(t, kind)
        assert.equal(x.exists(VIDEO), false)
        for (const f of ['コンテンツ/top.md', 'コンテンツ/記事/a.md', 'shared/規程.md']) assert.ok(x.exists(f), `${f} should stay`)
        assert.deepEqual(readSparseConfig(x.dir).excluded.filter(e => e.startsWith('コンテンツ')), [VIDEO])
        assert.equal(x.git(['config', '--get', 'core.sparseCheckoutCone']).trim(), 'false')
        assert.match(fs.readFileSync(x.path('.git/info/sparse-checkout'), 'utf-8'), /^\/\*\n(.*\n)*!\/コンテンツ\/動画\/\n/)
        assert.deepEqual(notDownloadedFolders(x.dir).filter(f => f.startsWith('コンテンツ')), [VIDEO])
        ok(await x.sync(), 'x')
        assert.equal(x.exists(VIDEO), false)
        assert.ok(x.exists('コンテンツ/記事/a.md'))
        await settleAndCheck(world)
        assert.equal(x.exists(VIDEO), false)
      })

      scenario('a teammate edits, adds, deletes and renames inside the excluded folder: x never gets (or downloads) them', async t => {
        const { world, a, x } = await create(t, kind)
        a.write(`${VIDEO}/編集/cut.md`, 'cut v1 by a\n').write(`${VIDEO}/新規.md`, 'new by a\n').write(`${VIDEO}/new.mp4`, Buffer.alloc(32 * 1024, 9))
          .remove(`${VIDEO}/台本.md`).rename(`${VIDEO}/intro.mp4`, `${VIDEO}/編集/intro.mp4`)
        ok(await a.sync(), 'a')
        x.write('コンテンツ/記事/a.md', 'article v1 by x\n')
        ok(await x.sync(), 'x')
        assert.equal(x.exists(VIDEO), false)
        assert.equal(world.serverFile('コンテンツ/記事/a.md')?.toString(), 'article v1 by x\n')
        assert.equal(world.serverFile(`${VIDEO}/編集/cut.md`)?.toString(), 'cut v1 by a\n')
        if (x.partial) assert.deepEqual(downloadedUnder(world, x, `${VIDEO}/`).filter(f => f !== `${VIDEO}/編集/intro.mp4`), [], 'x downloaded the teammate\'s files')
        await settleAndCheck(world)
        assert.equal(x.exists(VIDEO), false)
      })

      scenario('a folder a teammate creates next to (or inside a downloaded part of) the department downloads automatically', async t => {
        const { world, a, x } = await create(t, kind)
        a.write('コンテンツ/新企画/plan.md', 'plan\n').write('コンテンツ/記事/2026/b.md', 'b\n')
        ok(await a.sync(), 'a')
        ok(await x.sync(), 'x')
        assert.equal(x.readText('コンテンツ/新企画/plan.md'), 'plan\n')
        assert.equal(x.readText('コンテンツ/記事/2026/b.md'), 'b\n')
        assert.equal(x.exists(VIDEO), false)
        await settleAndCheck(world)
      })

      scenario('the member\'s own new folder in the department is shared and stays on disk', async t => {
        const { world, x } = await create(t, kind)
        x.write('コンテンツ/自分の企画/memo.md', 'mine\n')
        ok(await x.sync(), 'x')
        assert.equal(world.serverFile('コンテンツ/自分の企画/memo.md')?.toString(), 'mine\n')
        await settleAndCheck(world)
        assert.equal(x.readText('コンテンツ/自分の企画/memo.md'), 'mine\n')
      })

      scenario('a write into the excluded folder is refused by the app and the chat guard; sync holds it back if it happens anyway', async t => {
        const { world, x } = await create(t, kind)
        // Layer 1 (the app's file operations) and layer 2 (the chat's PreToolUse guard).
        assert.equal(notDownloadedFolderFor(x.path(`${VIDEO}/編集/cut.md`)), VIDEO)
        assert.equal(notDownloadedFolderFor(x.path(`${VIDEO}`)), VIDEO)
        assert.equal(notDownloadedFolderFor(x.path('コンテンツ/記事/a.md')), null)
        const guard = { root: x.dir, getAccess: () => undefined, getNotDownloaded: () => notDownloadedFolders(x.dir) }
        const d = decideToolWrite(guard, 'Write', { file_path: x.path(`${VIDEO}/編集/cut.md`) }, x.dir)
        assert.equal(d.deny, true)
        if (d.deny) assert.equal(d.message, 'このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。')
        assert.equal(decideToolWrite(guard, 'Bash', { command: `echo x > '${VIDEO}/a.md'` }, x.dir).deny, true)
        assert.equal(decideToolWrite(guard, 'Write', { file_path: x.path('コンテンツ/記事/new.md') }, x.dir).deny, false)

        // Layer 3: written anyway (a Bash `cp`, another tool) over a teammate's file and as a new file.
        x.write(`${VIDEO}/編集/cut.md`, 'AI draft\n').write(`${VIDEO}/新規/メモ.md`, 'memo\n')
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile(`${VIDEO}/編集/cut.md`)?.toString(), 'cut v0\n', 'the teammate\'s file was overwritten')
        assert.equal(world.serverFile(`${VIDEO}/新規/メモ.md`), null)
        const backup = outsideCheckoutBackup(x)
        assert.ok(backup, JSON.stringify(out.result))
        assert.deepEqual(backup.metadata.folders, [VIDEO])
        assert.deepEqual(backup.metadata.serverFiles, [`${VIDEO}/編集/cut.md`])
        assert.equal(fs.readFileSync(x.path(`.backups/${backup.folder}/${VIDEO}/編集/cut.md`), 'utf-8'), 'AI draft\n')
        assert.equal(fs.readFileSync(x.path(`.backups/${backup.folder}/${VIDEO}/新規/メモ.md`), 'utf-8'), 'memo\n')
        assert.match(out.result.message ?? '', /ダウンロードしていないフォルダ（コンテンツ\/動画）にファイルが作られていたため、共有せずに \.backups に保存しました（2件）。必要ならそのフォルダをダウンロードしてから保存し直してください。/)
        assert.equal(x.exists(VIDEO), false)
        if (x.partial) assert.deepEqual(downloadedUnder(world, x, `${VIDEO}/`).filter(f => !f.endsWith('cut.md') && !f.endsWith('intro.mp4') && !f.endsWith('台本.md')), [])
        await settleAndCheck(world)
      })

      scenario('excluding a folder with local edits: they are listed first, nothing is lost (held back to .backups)', async t => {
        const { world, x } = await create(t, kind, null)
        x.write(`${VIDEO}/編集/cut.md`, 'x edit\n').write(`${VIDEO}/x-new.md`, 'x new\n').write('コンテンツ/記事/a.md', 'article by x\n')
        const git = x.createGit(x.dir)
        assert.deepEqual(await uncommittedChangesIn(git, [VIDEO]), [`${VIDEO}/x-new.md`, `${VIDEO}/編集/cut.md`])
        assert.deepEqual(await uncommittedChangesIn(git, ['コンテンツ/記事']), ['コンテンツ/記事/a.md'])
        assert.deepEqual(await uncommittedChangesIn(git, ['営業部']), [])
        const res = await x.excludeFolder(VIDEO)
        assert.equal(res.success, true, JSON.stringify(res))
        // git leaves edited and new files where they are.
        assert.equal(x.readText(`${VIDEO}/編集/cut.md`), 'x edit\n')
        assert.equal(x.readText(`${VIDEO}/x-new.md`), 'x new\n')
        assert.equal(x.exists(`${VIDEO}/台本.md`), false)
        const out = ok(await x.sync(), 'x')
        assert.equal(world.serverFile('コンテンツ/記事/a.md')?.toString(), 'article by x\n')
        assert.equal(world.serverFile(`${VIDEO}/編集/cut.md`)?.toString(), 'cut v0\n')
        assert.equal(world.serverFile(`${VIDEO}/x-new.md`), null)
        assert.deepEqual([...(out.result.outsideCheckoutFiles ?? [])].sort(), [`${VIDEO}/x-new.md`, `${VIDEO}/編集/cut.md`])
        const backup = outsideCheckoutBackup(x)!
        assert.equal(fs.readFileSync(x.path(`.backups/${backup.folder}/${VIDEO}/編集/cut.md`), 'utf-8'), 'x edit\n')
        assert.equal(fs.readFileSync(x.path(`.backups/${backup.folder}/${VIDEO}/x-new.md`), 'utf-8'), 'x new\n')
        assert.equal(x.exists(VIDEO), false)
        await settleAndCheck(world)
      })

      scenario('downloading the folder again brings the teammates\' latest files', async t => {
        const { world, a, x } = await create(t, kind)
        a.write(`${VIDEO}/編集/cut.md`, 'cut v1 by a\n').write(`${VIDEO}/新規.md`, 'new by a\n')
        ok(await a.sync(), 'a')
        ok(await x.sync(), 'x')
        const res = await x.includeFolder(VIDEO)
        assert.equal(res.success, true, JSON.stringify(res))
        assert.equal(x.readText(`${VIDEO}/編集/cut.md`), 'cut v1 by a\n')
        assert.equal(x.readText(`${VIDEO}/新規.md`), 'new by a\n')
        assert.ok(x.exists(`${VIDEO}/intro.mp4`))
        assert.deepEqual(notDownloadedFolders(x.dir).filter(f => f.startsWith('コンテンツ')), [])
        x.write(`${VIDEO}/新規.md`, 'edited by x\n')
        ok(await x.sync(), 'x')
        assert.equal(world.serverFile(`${VIDEO}/新規.md`)?.toString(), 'edited by x\n')
        await settleAndCheck(world)
      })

      scenario('ignored files (.personal, .env.local) inside the excluded folder survive excluding, syncing and re-including', async t => {
        const { world, x } = await create(t, kind, null)
        x.write(`${VIDEO}/.personal/memo.md`, 'private\n').write(`${VIDEO}/編集/.env.local`, 'TOKEN=local\n')
        ok(await x.sync(), 'x')
        assert.equal((await x.excludeFolder(VIDEO)).success, true)
        assert.equal(x.readText(`${VIDEO}/.personal/memo.md`), 'private\n')
        assert.equal(x.readText(`${VIDEO}/編集/.env.local`), 'TOKEN=local\n')
        assert.equal(x.exists(`${VIDEO}/台本.md`), false)
        assert.equal(fs.existsSync(x.path('.git/acb-sparse-keep')), false)
        const out = ok(await x.sync(), 'x')
        assert.equal(out.result.outsideCheckoutFiles, undefined)
        assert.equal(x.readText(`${VIDEO}/.personal/memo.md`), 'private\n')
        assert.equal((await x.includeFolder(VIDEO)).success, true)
        assert.equal(x.readText(`${VIDEO}/.personal/memo.md`), 'private\n')
        assert.equal(x.readText(`${VIDEO}/編集/.env.local`), 'TOKEN=local\n')
        assert.equal(world.serverFile(`${VIDEO}/.personal/memo.md`), null)
        await settleAndCheck(world)
        assert.equal(x.readText(`${VIDEO}/.personal/memo.md`), 'private\n')
      })

      scenario('nested choices: a deeper exclusion works on its own; one inside an excluded folder is folded into it', async t => {
        const { world, a, x } = await create(t, kind, null)
        assert.equal((await x.excludeFolder(`${VIDEO}/編集`)).success, true)
        assert.equal(x.exists(`${VIDEO}/編集`), false)
        assert.ok(x.exists(`${VIDEO}/台本.md`))
        a.write(`${VIDEO}/編集/sub/new.md`, 'deep\n').write(`${VIDEO}/別/new.md`, 'sibling\n')
        ok(await a.sync(), 'a')
        ok(await x.sync(), 'x')
        assert.equal(x.exists(`${VIDEO}/編集`), false)
        assert.equal(x.readText(`${VIDEO}/別/new.md`), 'sibling\n')
        // Excluding the parent too: the list keeps just the parent.
        assert.equal((await x.excludeFolder(VIDEO)).success, true)
        assert.deepEqual(readSparseConfig(x.dir).excluded.filter(e => e.startsWith('コンテンツ')), [VIDEO])
        assert.equal(x.exists(VIDEO), false)
        await settleAndCheck(world)
      })
    })
  }

  scenario('partial clone, offline: downloading a folder changes nothing and says why', async t => {
    const { world, a, x } = await create(t, 'partial clone')
    // Content x never downloaded (the folder's first files came with first setup).
    a.write(`${VIDEO}/later.mp4`, Buffer.alloc(16 * 1024, 5))
    ok(await a.sync(), 'a')
    ok(await x.sync(), 'x')
    x.offline()
    const res = await x.includeFolder(VIDEO)
    assert.deepEqual(res, { success: false, offline: true, error: DOWNLOAD_NEEDS_NETWORK_MESSAGE })
    assert.ok(readSparseConfig(x.dir).excluded.includes(VIDEO))
    assert.equal(x.exists(VIDEO), false)
    assert.deepEqual(notDownloadedFolders(x.dir).filter(f => f.startsWith('コンテンツ')), [VIDEO])
    x.online()
    assert.equal((await x.includeFolder(VIDEO)).success, true)
    assert.ok(x.exists(`${VIDEO}/later.mp4`))
    await settleAndCheck(world)
  })

  scenario('first setup with departments picked still works, and a folder inside a picked department can then be left out', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], departments: ['コンテンツ', '営業部'], seed: SEED })
    const p = await world.addPartialMember('p', { departments: ['コンテンツ'] })
    assert.deepEqual(readSparseConfig(p.dir).excluded, ['営業部'])
    assert.equal(p.git(['config', '--get', 'core.sparseCheckoutCone']).trim(), 'false')
    assert.equal(fs.readFileSync(p.path('.git/info/sparse-checkout'), 'utf-8'), '/*\n!/営業部/\n')
    assert.equal(p.exists('営業部'), false)
    assert.ok(p.exists(`${VIDEO}/intro.mp4`))
    assert.deepEqual(downloadedUnder(world, p, '営業部/'), [])
    assert.equal((await p.excludeFolder(VIDEO)).success, true)
    assert.deepEqual(readSparseConfig(p.dir).excluded.sort(), ['コンテンツ/動画', '営業部'].sort())
    assert.equal(p.exists(VIDEO), false)
    world.member('a').write(`${VIDEO}/later.mp4`, Buffer.alloc(16 * 1024, 3))
    ok(await world.member('a').sync(), 'a')
    ok(await p.sync(), 'p')
    assert.deepEqual(downloadedUnder(world, p, `${VIDEO}/later`), [])
    await settleAndCheck(world)
  })

  for (const kind of KINDS) {
    scenario(`migration (${kind}): an existing department exclusion on the old cone mode switches to non-cone without downloading or deleting anything`, async t => {
      const world = World.create(t, { members: [{ name: 'a' }], departments: ['コンテンツ', '営業部'], seed: SEED })
      const x = new Member(world, 'x', 'member', { partial: kind === 'partial clone' })
      world.members.push(x)
      const git = (args: string[]) => world.git(x.dir, args)
      // What the previous app version did (cone mode, department exclusions).
      if (kind === 'partial clone') {
        git(['init', '-q', '-b', 'main'])
        git(['remote', 'add', 'origin', `file://${world.bare}`])
        git(['config', 'user.name', 'x'])
        git(['config', 'user.email', 'x@example.com'])
        git(['fetch', '-q', '--filter=blob:none', 'origin'])
      }
      fs.writeFileSync(x.path('.git/acb-sparse-config.json'), JSON.stringify({ excluded: ['営業部'] }, null, 2))
      const roots = git(['ls-tree', '-d', '-z', '--name-only', 'origin/main']).split('\0').filter(d => d && d !== '営業部')
      git(['sparse-checkout', 'set', '--cone', ...roots])
      if (kind === 'partial clone') git(['checkout', '-q', '-b', 'main', 'origin/main'])
      x.write('営業部/.personal/memo.md', 'private\n') // local-only file in the excluded department
      assert.equal(git(['config', '--get', 'core.sparseCheckoutCone']).trim(), 'true')
      const before = filesOnDisk(x)
      const missingBefore = x.partial ? x.missingObjects() : new Set<string>()
      assert.deepEqual(await appliedExclusions(x.createGit(x.dir), x.dir), ['営業部'])
      assert.deepEqual(notDownloadedFolders(x.dir), ['営業部'])

      const out = ok(await x.sync(), 'x')
      assert.equal(out.result.outsideCheckoutFiles, undefined)
      assert.equal(git(['config', '--get', 'core.sparseCheckoutCone']).trim(), 'false')
      assert.equal(fs.readFileSync(x.path('.git/info/sparse-checkout'), 'utf-8'), '/*\n!/営業部/\n')
      assert.deepEqual(filesOnDisk(x), before, 'the migration changed files on disk')
      if (x.partial) {
        const missingAfter = x.missingObjects()
        assert.deepEqual([...missingBefore].filter(o => !missingAfter.has(o)), [], 'the migration downloaded something')
      }
      assert.deepEqual(notDownloadedFolders(x.dir), ['営業部'])
      assert.equal(x.readText('営業部/.personal/memo.md'), 'private\n')
      // The old department choice keeps working, and a folder can now be left out too.
      assert.equal((await x.excludeFolder(VIDEO)).success, true)
      assert.equal(x.exists(VIDEO), false)
      await settleAndCheck(world)
      assert.equal(x.readText('営業部/.personal/memo.md'), 'private\n')
    })
  }

  scenario('a folder a teammate deletes is no longer "not downloaded": the member can create it again and share it', async t => {
    const { world, a, x } = await create(t, 'full clone')
    for (const f of ['intro.mp4', '編集/cut.md', '台本.md']) a.remove(`${VIDEO}/${f}`)
    ok(await a.sync(), 'a')
    // The first sync pulls the deletion (HEAD still had the folder); the next drops the exclusion.
    ok(await x.sync(), 'x')
    ok(await x.sync(), 'x')
    assert.deepEqual(readSparseConfig(x.dir).excluded, [])
    assert.deepEqual(notDownloadedFolders(x.dir), [])
    x.write(`${VIDEO}/再開.md`, 'again\n')
    ok(await x.sync(), 'x')
    assert.equal(world.serverFile(`${VIDEO}/再開.md`)?.toString(), 'again\n')
    await settleAndCheck(world)
  })

  // Found by the mixed soak (seed 104): a department had been excluded as a
  // nested repository by a teammate (`/営業部/` in .gitignore, its files
  // untracked), and listing the ignored files below it with `ls-files
  // --directory` made git fail with "directory entry not superset of prefix"
  // — leaving out a sub-folder there failed.
  scenario('leaving out a sub-folder of a folder that is untracked and ignored as a whole works', async t => {
    const { world, x } = await create(t, 'full clone', null)
    x.append('.gitignore', '/ローカル/\n')
    ok(await x.sync(), 'x')
    x.write('ローカル/sub/a.md', 'local only\n')
    const res = await x.excludeFolder('ローカル/sub')
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal(x.readText('ローカル/sub/a.md'), 'local only\n')
    ok(await x.sync(), 'x')
    // Nobody has that folder: the exclusion is dropped again.
    ok(await x.sync(), 'x')
    assert.deepEqual(readSparseConfig(x.dir).excluded, [])
    await settleAndCheck(world)
    assert.equal(x.readText('ローカル/sub/a.md'), 'local only\n')
  })

  scenario('an A–Z case variant of an excluded folder is treated as the excluded folder', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'x' }], departments: ['Media'], seed: { 'Media/Raw/take1.md': 'take1\n', 'Media/edit.md': 'edit\n' } })
    const x = world.member('x')
    const probe = path.join(x.dir, 'CASE-PROBE')
    fs.writeFileSync(probe, '')
    const caseInsensitive = fs.existsSync(path.join(x.dir, 'case-probe'))
    fs.rmSync(probe)
    if (!caseInsensitive) return t.skip('case-sensitive file system')
    assert.equal((await x.excludeFolder('Media/Raw')).success, true)
    assert.equal(notDownloadedFolderFor(x.path('media/raw/take1.md')), 'Media/Raw')
    x.write('Media/raw/take1.md', 'overwrite attempt\n')
    const out = ok(await x.sync(), 'x')
    assert.equal(world.serverFile('Media/Raw/take1.md')?.toString(), 'take1\n')
    assert.deepEqual((out.result.outsideCheckoutFiles ?? []).map(f => f.toLowerCase()), ['media/raw/take1.md'])
    await settleAndCheck(world)
  })
})

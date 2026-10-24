// Step 4 of git:sync: files over the size limit are kept out of what sync
// shares by an anchored, literal line in the root .gitignore. The scan only
// looks at what git lists (index entries + untracked files no rule ignores)
// and asks git whether a path is already ignored. See
// client/electron/sync/large-files.ts and step 4 in
// .claude/rules/sync.md. The threshold is lowered per world (largeFileThreshold) so no
// scenario writes 100 MB.

import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { World, privateMarker, type SyncOutcome } from '../sync-harness/world'
import { settleAndCheck } from '../sync-harness/invariants'
import { largeFilePattern } from '../../electron/sync/large-files'

const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const SCENARIO_TIMEOUT_MS = Number(process.env.SYNC_HARNESS_SCENARIO_TIMEOUT_MS) || 10 * 60_000
const scenario = (name: string, fn: (t: TestContext) => Promise<void>) => test(name, { timeout: SCENARIO_TIMEOUT_MS }, fn)

const LIMIT = 4096
const LARGE = Buffer.alloc(LIMIT + 1, 7)
const SMALL = 'small\n'

function ok(outcome: SyncOutcome, who = ''): SyncOutcome {
  assert.equal(outcome.result.success, true, `${who} sync failed: ${JSON.stringify(outcome.result)}`)
  return outcome
}

const serverIgnore = (world: World) => world.serverFile('.gitignore')?.toString('utf-8') ?? ''
const lines = (text: string) => text.split('\n')

describe('largeFilePattern', () => {
  test('anchored, literal, unchanged for a plain path with a folder', () => {
    assert.equal(largeFilePattern('media/huge.mov'), 'media/huge.mov', 'the form the old scan wrote (a slash anchors it)')
    assert.equal(largeFilePattern('huge.mov'), '/huge.mov')
    assert.equal(largeFilePattern('[draft] v?.mov'), '/\\[draft] v\\?.mov')
    assert.equal(largeFilePattern('a/*b\\c.mov'), 'a/\\*b\\\\c.mov')
    assert.equal(largeFilePattern('#tag.mov'), '/\\#tag.mov')
    assert.equal(largeFilePattern('!bang/x.mov'), '\\!bang/x.mov')
    assert.equal(largeFilePattern('trail.mov  '), '/trail.mov\\ \\ ')
    assert.equal(largeFilePattern('営業部/動画.mp4'), '営業部/動画.mp4')
  })
})

describe('git:sync large files', { concurrency: CONCURRENCY }, () => {
  scenario('a new large file is ignored (anchored) and never pushed; small files next to it are shared', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], largeFileThreshold: LIMIT, seed: { 'x.md': 'x\n' } })
    const [a, b] = world.members
    a.write('big.bin', LARGE).write('media/huge.mov', LARGE).write('media/small.txt', SMALL).write('sub/big.bin', SMALL)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.ignoredLargeFiles, ['big.bin', 'media/huge.mov'])
    assert.match(out.result.message ?? '', /（2個の大容量ファイルを同期対象外にしました）/)
    const ignore = lines(serverIgnore(world))
    assert.ok(ignore.includes('# Auto-ignored: Large files (>100MB)'))
    assert.ok(ignore.includes('/big.bin'), 'a root file is anchored')
    assert.ok(ignore.includes('media/huge.mov'))
    assert.equal(world.serverFile('big.bin'), null)
    assert.equal(world.serverFile('media/huge.mov'), null)
    assert.equal(world.serverFile('media/small.txt')?.toString(), SMALL)
    assert.equal(world.serverFile('sub/big.bin')?.toString(), SMALL, 'the anchored line does not ignore the same name deeper down')
    assert.ok(a.exists('big.bin') && a.exists('media/huge.mov'), 'kept on disk')
    // Already ignored now: nothing is added again.
    a.write('media/small.txt', 'small v2\n')
    const again = ok(await a.sync(), 'a')
    assert.deepEqual(again.result.ignoredLargeFiles, [])
    assert.equal(lines(serverIgnore(world)).filter(l => l === '/big.bin').length, 1)
    ok(await b.sync(), 'b')
    assert.equal(b.exists('media/huge.mov'), false)
    await settleAndCheck(world)
  })

  scenario('a line that merely contains the path (or a department name) does not count as ignoring it', async t => {
    const gitignore = '.backups/\n.workspace/\nnode_modules/\n.env\n.env.*\n!.env.example\n!.env.sample\n**/.personal/*\n!**/.personal/.gitignore\n' +
      '# data.mp4 lives on the NAS\n/a.mp4\n営業部/old/video.mp4\n'
    const world = World.create(t, { members: [{ name: 'a' }], largeFileThreshold: LIMIT, gitignore, seed: { '営業部/提案.md': '提案\n' } })
    const [a] = world.members
    a.write('data.mp4', LARGE).write('営業部/new.mp4', LARGE).write('営業部/memo.md', SMALL)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.ignoredLargeFiles, ['data.mp4', '営業部/new.mp4'])
    assert.equal(world.serverFile('data.mp4'), null)
    assert.equal(world.serverFile('営業部/new.mp4'), null, 'the old substring test skipped every file under 営業部')
    assert.equal(world.serverFile('営業部/memo.md')?.toString(), SMALL)
    const ignore = lines(serverIgnore(world))
    assert.ok(ignore.includes('/data.mp4') && ignore.includes('営業部/new.mp4'))
    await settleAndCheck(world)
  })

  scenario('glob and comment characters in a name are written literally', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], largeFileThreshold: LIMIT, seed: { 'x.md': 'x\n' } })
    const [a] = world.members
    const names = ['[draft] v?.mov', '#tag.mov', '!bang.mov', 'sub/a*b.mov', 'trail.mov ']
    for (const n of names) a.write(n, LARGE)
    // What the unescaped patterns would have matched instead:
    a.write('d vx.mov', SMALL).write('sub/aXYZb.mov', SMALL)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.ignoredLargeFiles, [...names].sort())
    for (const n of names) {
      // --no-index: a pathspec with glob characters would otherwise match the tracked sibling
      assert.equal(a.git(['check-ignore', '--no-index', '--', n]).replace(/\n$/, ''), n, `${n} ignored`)
      assert.equal(world.serverFile(n), null, `${n} not pushed`)
    }
    assert.equal(world.serverFile('d vx.mov')?.toString(), SMALL)
    assert.equal(world.serverFile('sub/aXYZb.mov')?.toString(), SMALL)
    await settleAndCheck(world)
  })

  scenario('a tracked large file gets its line once and stays shared (as before)', async t => {
    const world = World.create(t, { members: [{ name: 'a' }, { name: 'b' }], largeFileThreshold: LIMIT, seed: { '営業部/動画.mp4': LARGE, 'x.md': 'x\n' } })
    const [a, b] = world.members
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.ignoredLargeFiles, ['営業部/動画.mp4'])
    assert.ok(lines(serverIgnore(world)).includes('営業部/動画.mp4'))
    assert.ok(world.serverFile('営業部/動画.mp4')?.equals(LARGE), 'still tracked on the server')
    a.write('x.md', 'x2\n')
    assert.deepEqual(ok(await a.sync(), 'a').result.ignoredLargeFiles, [], 'not added twice')
    // b scans before it pulls a's line (step 4 precedes the fetch), as before;
    // the union merge keeps one copy.
    ok(await b.sync(), 'b')
    assert.deepEqual(ok(await b.sync(), 'b').result.ignoredLargeFiles, [])
    assert.equal(lines(serverIgnore(world)).filter(l => l === '営業部/動画.mp4').length, 1)
    assert.ok(b.read('営業部/動画.mp4').equals(LARGE))
    await settleAndCheck(world)
  })

  scenario('a large file in a shared folder that has a stray .git ("keep sharing") is still ignored', async t => {
    const world = World.create(t, { members: [{ name: 'a' }], largeFileThreshold: LIMIT, seed: { 'shared/a.md': 'a\n' } })
    const [a] = world.members
    a.initNestedRepo('shared', { 'inner.md': 'inner\n' })
    a.write('shared/big.bin', LARGE)
    const out = ok(await a.sync(), 'a')
    assert.deepEqual(out.result.ignoredLargeFiles, ['shared/big.bin'])
    assert.equal(a.exists('shared/.git'), false, 'default answer: keep sharing')
    assert.equal(world.serverFile('shared/big.bin'), null)
    assert.equal(world.serverFile('shared/inner.md')?.toString(), 'inner\n')
    await settleAndCheck(world)
  })

  scenario('.workspace, .backups, node_modules and a private folder are never scanned into the company .gitignore', async t => {
    const world = World.create(t, {
      members: [{ name: 'reader' }, { name: 'other' }],
      largeFileThreshold: LIMIT,
      departments: ['人事'],
      seed: { '人事/規程.md': '規程\n' },
    })
    const HR = '人事/評価'
    world.createPrivateFolder(HR, { viewers: ['reader'], files: { '評価表.md': `${privateMarker('scope-private-1')}\n` } })
    const reader = world.member('reader')
    ok(await reader.sync(), 'reader')
    for (const rel of ['.workspace/big.bin', '.backups/big.bin', '人事/.workspace/big.bin', 'node_modules/big.bin']) {
      fs.mkdirSync(reader.path(rel.replace(/\/[^/]+$/, '')), { recursive: true })
      fs.writeFileSync(reader.path(rel), LARGE)
    }
    reader.write(`${HR}/big.bin`, LARGE)
    const out = ok(await reader.sync(), 'reader')
    assert.deepEqual(out.result.ignoredLargeFiles, [])
    const ignore = serverIgnore(world)
    assert.doesNotMatch(ignore, /big\.bin|評価|Auto-ignored: Large/)
    assert.ok(lines(world.scopeFile(HR, '.gitignore')?.toString() ?? '').includes('/big.bin'), 'ignored inside the scope repository instead')
    assert.equal(world.scopeFile(HR, 'big.bin'), null)
    await settleAndCheck(world)
  })

  scenario('partial-clone member: the scan downloads nothing', async t => {
    const world = World.create(t, {
      members: [{ name: 'a' }],
      largeFileThreshold: LIMIT,
      departments: ['営業部', '開発部'],
      seed: { '営業部/提案書.md': 'sales\n', '開発部/設計.md': 'dev\n', '開発部/demo.mp4': LARGE },
    })
    const p = await world.addPartialMember('p', { departments: ['営業部'] })
    const missingBefore = p.missingObjects()
    assert.ok(missingBefore.size > 0, 'the partial member lacks 開発部\'s blobs')
    p.write('営業部/huge.bin', LARGE).write('営業部/memo.md', SMALL).write('開発部/new-huge.bin', LARGE)
    const out = ok(await p.sync(), 'p')
    assert.deepEqual(out.result.ignoredLargeFiles, ['営業部/huge.bin', '開発部/new-huge.bin'])
    const missingAfter = p.missingObjects()
    assert.deepEqual([...missingBefore].filter(o => !missingAfter.has(o)), [], 'no blob was fetched')
    assert.equal(world.serverFile('営業部/huge.bin'), null)
    assert.equal(world.serverFile('開発部/new-huge.bin'), null)
    assert.equal(world.serverFile('営業部/memo.md')?.toString(), SMALL)
    assert.ok(p.exists('開発部/new-huge.bin'), 'ignored, so left where it is (as before)')
    await settleAndCheck(world)
  })
})

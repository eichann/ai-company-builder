import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FileTreeModel,
  planTreeRefresh,
  viewOfListing,
  type FileTreeIO,
  type RawDirEntry,
} from './fileTreeModel'
import { clearKnownFolders, folderExistsFor, rememberFolderExists } from '../../shared/lib/folderExists'

const R = '/co/営業部'

test('plan: a new file in an expanded folder re-reads that folder only', () => {
  const plan = planTreeRefresh(
    [{ type: 'add', path: `${R}/a/new.md` }],
    { root: R, loaded: new Set([R, `${R}/a`, `${R}/b`]), expanded: new Set([`${R}/a`]), active: true },
  )
  assert.deepEqual(plan, { reread: [`${R}/a`], stale: [], drop: [] })
})

test('plan: the root is always on screen; a top-level change re-reads it', () => {
  const plan = planTreeRefresh(
    [{ type: 'addDir', path: `${R}/新しいフォルダ` }, { type: 'unlink', path: `${R}/old.txt` }],
    { root: R, loaded: new Set([R]), expanded: new Set(), active: true },
  )
  assert.deepEqual(plan.reread, [R])
  assert.deepEqual(plan.drop, [`${R}/old.txt`])
})

test('plan: a collapsed loaded folder is marked stale; a never-read folder is ignored', () => {
  const plan = planTreeRefresh(
    [
      { type: 'add', path: `${R}/b/x.md` }, // b loaded, collapsed
      { type: 'add', path: `${R}/c/deep/y.md` }, // c/deep never read
    ],
    { root: R, loaded: new Set([R, `${R}/b`, `${R}/c`]), expanded: new Set([`${R}/c`]), active: true },
  )
  assert.deepEqual(plan, { reread: [], stale: [`${R}/b`], drop: [] })
})

test('plan: content changes re-read nothing; events outside the tree are ignored', () => {
  const plan = planTreeRefresh(
    [
      { type: 'change', path: `${R}/a/doc.md` },
      { type: 'add', path: '/co/経理部/x.md' },
      { type: 'add', path: '/co/営業部2/x.md' },
    ],
    { root: R, loaded: new Set([R, `${R}/a`]), expanded: new Set([`${R}/a`]), active: true },
  )
  assert.deepEqual(plan, { reread: [], stale: [], drop: [] })
})

test('plan: an inactive tree (another department on screen) only marks folders stale', () => {
  const plan = planTreeRefresh(
    [{ type: 'add', path: `${R}/a/new.md` }, { type: 'add', path: `${R}/top.md` }],
    { root: R, loaded: new Set([R, `${R}/a`]), expanded: new Set([`${R}/a`]), active: false },
  )
  assert.deepEqual(plan.reread, [])
  assert.deepEqual(new Set(plan.stale), new Set([R, `${R}/a`]))
})

test('plan: a removed folder drops its subtree and is not re-read itself', () => {
  const plan = planTreeRefresh(
    [{ type: 'unlinkDir', path: `${R}/a` }, { type: 'add', path: `${R}/a/sub/x.md` }],
    { root: R, loaded: new Set([R, `${R}/a`, `${R}/a/sub`]), expanded: new Set([`${R}/a`, `${R}/a/sub`]), active: true },
  )
  assert.deepEqual(plan.drop, [`${R}/a`])
  assert.deepEqual(plan.reread, [R])
})

test('plan: Windows paths compare with forward slashes', () => {
  const plan = planTreeRefresh(
    [{ type: 'add', path: 'C:\\co\\営業部\\a\\new.md' }],
    { root: 'C:\\co/営業部', loaded: new Set(['C:/co/営業部', 'C:/co/営業部/a']), expanded: new Set(['C:/co/営業部/a']), active: true },
  )
  assert.deepEqual(plan.reread, ['C:/co/営業部/a'])
})

// ── the model, with a fake disk ───────────────────────────────────────────

function fakeDisk(tree: Record<string, string[]>) {
  const reads: string[] = []
  let treeReads = 0
  const entries = (dir: string): RawDirEntry[] => (tree[dir] ?? []).map(name => {
    const isDirectory = name.endsWith('/')
    const clean = isDirectory ? name.slice(0, -1) : name
    return { name: clean, isDirectory, path: `${dir}/${clean}` }
  })
  const io: FileTreeIO = {
    readDirectory: async dir => { reads.push(dir); return entries(dir) },
    readDirectoryTree: async (dir, depth) => {
      treeReads++
      assert.equal(depth, 1, 'the first view reads two levels, not five')
      return entries(dir).map(e => (e.isDirectory ? { ...e, children: entries(e.path) } : e))
    },
  }
  return { io, reads, tree, get treeReads() { return treeReads } }
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('model: first view reads two levels and opens the first-level folders; deeper folders load on expand', async () => {
  const disk = fakeDisk({ [R]: ['a/', 'b/', 'top.md'], [`${R}/a`]: ['sub/', 'x.md'], [`${R}/b`]: [], [`${R}/a/sub`]: ['deep.md'] })
  const model = new FileTreeModel(R, disk.io)
  await model.activate()
  assert.equal(disk.treeReads, 1)
  assert.deepEqual(disk.reads, [])
  assert.ok(model.isExpanded(`${R}/a`) && model.isExpanded(`${R}/b`))
  assert.equal(model.isLoaded(`${R}/a/sub`), false)
  assert.ok(model.isDirectory(`${R}/a/sub`), 'folders are known from their parent listing (O(1))')
  assert.equal(model.isDirectory(`${R}/a/x.md`), false)
  await model.toggle(`${R}/a/sub`)
  assert.deepEqual(disk.reads, [`${R}/a/sub`])
  assert.deepEqual(model.listing(`${R}/a/sub`)?.map(e => e.name), ['deep.md'])
})

test('model: a file the AI creates in an open folder appears after one re-read of that folder', async () => {
  const disk = fakeDisk({ [R]: ['a/'], [`${R}/a`]: ['x.md'] })
  const model = new FileTreeModel(R, disk.io)
  await model.activate()
  disk.tree[`${R}/a`] = ['x.md', 'new.md']
  model.applyEvents([{ type: 'add', path: `${R}/a/new.md` }])
  await tick(); await tick()
  assert.deepEqual(disk.reads, [`${R}/a`])
  assert.deepEqual(model.listing(`${R}/a`)?.map(e => e.name), ['x.md', 'new.md'])
  // editing it is not a listing change
  model.applyEvents([{ type: 'change', path: `${R}/a/new.md` }])
  await tick()
  assert.deepEqual(disk.reads, [`${R}/a`])
})

test('model: a change inside a collapsed folder re-reads it when it is opened again', async () => {
  const disk = fakeDisk({ [R]: ['a/'], [`${R}/a`]: ['x.md'] })
  const model = new FileTreeModel(R, disk.io)
  await model.activate()
  await model.toggle(`${R}/a`) // collapse
  disk.tree[`${R}/a`] = ['x.md', 'y.md']
  model.applyEvents([{ type: 'add', path: `${R}/a/y.md` }])
  await tick()
  assert.deepEqual(disk.reads, [], 'not on screen: nothing read yet')
  assert.ok(model.isStale(`${R}/a`))
  await model.toggle(`${R}/a`) // expand
  assert.deepEqual(disk.reads, [`${R}/a`])
  assert.deepEqual(model.listing(`${R}/a`)?.map(e => e.name), ['x.md', 'y.md'])
  assert.equal(model.isStale(`${R}/a`), false)
})

test('model: a department not on screen catches up when shown again (cached, only what changed)', async () => {
  const disk = fakeDisk({ [R]: ['a/', 'b/'], [`${R}/a`]: ['x.md'], [`${R}/b`]: ['y.md'] })
  const model = new FileTreeModel(R, disk.io)
  await model.activate()
  model.deactivate()
  disk.tree[`${R}/a`] = ['x.md', 'z.md']
  model.applyEvents([{ type: 'add', path: `${R}/a/z.md` }])
  await tick()
  assert.deepEqual(disk.reads, [])
  await model.activate()
  assert.equal(disk.treeReads, 1, 'no cold re-read of the whole tree')
  assert.deepEqual(new Set(disk.reads), new Set([R, `${R}/a`]), 'the root (cheap check) and the changed folder')
  assert.deepEqual(model.listing(`${R}/a`)?.map(e => e.name), ['x.md', 'z.md'])
})

test('model: a removed folder is forgotten with everything below it', async () => {
  const disk = fakeDisk({ [R]: ['a/'], [`${R}/a`]: ['sub/'], [`${R}/a/sub`]: ['deep.md'] })
  const model = new FileTreeModel(R, disk.io)
  await model.activate()
  await model.toggle(`${R}/a/sub`)
  disk.tree[R] = []
  model.applyEvents([{ type: 'unlink', path: `${R}/a` }])
  await tick(); await tick()
  assert.equal(model.isLoaded(`${R}/a`), false)
  assert.equal(model.isLoaded(`${R}/a/sub`), false)
  assert.equal(model.isExpanded(`${R}/a/sub`), false)
  assert.deepEqual(model.listing(R), [])
  assert.equal(model.isDirectory(`${R}/a`), false)
})

test('model: events during a read run the read again (the newest state wins)', async () => {
  let release: (() => void) | null = null
  let reads = 0
  let names = ['x.md']
  const io: FileTreeIO = {
    readDirectoryTree: async () => [{ name: 'a', isDirectory: true, path: `${R}/a`, children: [] }],
    readDirectory: async (dir) => {
      reads++
      const snapshot = names.map(n => ({ name: n, isDirectory: false, path: `${dir}/${n}` }))
      if (reads === 1) await new Promise<void>(r => { release = r })
      return snapshot
    },
  }
  const model = new FileTreeModel(R, io)
  await model.activate()
  model.applyEvents([{ type: 'add', path: `${R}/a/x.md` }])
  await tick()
  names = ['x.md', 'y.md']
  model.applyEvents([{ type: 'add', path: `${R}/a/y.md` }]) // while the first read is running
  release!()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(reads, 2)
  assert.deepEqual(model.listing(`${R}/a`)?.map(e => e.name), ['x.md', 'y.md'])
})

test('view: sorted folders first, hidden names filtered, memoised per listing', () => {
  const raw: RawDirEntry[] = [
    { name: 'b.md', isDirectory: false, path: '/x/b.md' },
    { name: '.claude', isDirectory: true, path: '/x/.claude' },
    { name: 'a', isDirectory: true, path: '/x/a' },
    { name: '.DS_Store', isDirectory: false, path: '/x/.DS_Store' },
    { name: 'node_modules', isDirectory: true, path: '/x/node_modules' },
    { name: 'b.md.review.abc.json', isDirectory: false, path: '/x/b.md.review.abc.json' },
  ]
  const sidecar = (n: string) => n.includes('.review.')
  const withDots = viewOfListing(raw, true, sidecar)
  assert.deepEqual(withDots.map(e => e.name), ['.claude', 'a', 'b.md'])
  assert.deepEqual(viewOfListing(raw, false, sidecar).map(e => e.name), ['a', 'b.md'])
  assert.equal(viewOfListing(raw, true, sidecar), withDots, 'same listing → same entry objects')
})

test('folder existence is keyed by folder: another department\'s answer never applies', () => {
  clearKnownFolders()
  const a = '/co/営業部'
  const b = '/co/経理部'
  assert.equal(folderExistsFor(null, null), true)
  assert.equal(folderExistsFor({ path: a, exists: false }, a), false)
  // switched to b; the check for b has not answered yet → not "missing"
  assert.equal(folderExistsFor({ path: a, exists: false }, b), true)
  rememberFolderExists(b, false)
  assert.equal(folderExistsFor({ path: a, exists: true }, b), false, 'remembered per folder')
  assert.equal(folderExistsFor({ path: b, exists: true }, b), true, 'the latest check wins')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CompanyWatcher,
  classifyChange,
  coveringRoot,
  isIgnoredRelative,
  type FileChange,
  type RawEventType,
} from '../electron/company-watcher'

const quiet = { warn: () => {}, log: () => {} }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('ignore rules: inside .git (any depth, any case), node_modules, .workspace, .backups; .DS_Store', () => {
  for (const rel of [
    '.git/index',
    '.git/objects/ab/cdef',
    '営業部/顧客/.git/HEAD', // a private folder clone's own .git
    'a/b/.GIT/config',
    'node_modules/x/index.js',
    'tools/app/node_modules/y.js',
    '.workspace/chrome/SingletonSocket',
    'コンテンツ/.workspace/tmp.txt',
    '.backups/2026-01-01/営業部/a.md',
    '.DS_Store',
    'コンテンツ/.DS_Store',
    'win\\.git\\index',
  ]) assert.equal(isIgnoredRelative(rel), true, rel)
  for (const rel of [
    '.git', // the directory entry itself still shows in the tree
    '.gitignore',
    '営業部/.gitignore',
    '.github/workflows/ci.yml',
    'コンテンツ/動画/a.mp4',
    '.claude/skills/x/SKILL.md',
    '.personal/.gitignore',
    'a.git/x', // only an exact segment
    'backups/x',
    '',
  ]) assert.equal(isIgnoredRelative(rel), false, rel)
})

test('classification by what is on disk at the end of the window', () => {
  // 'rename' + exists → add / addDir (a create, or a replace by rename-over)
  assert.equal(classifyChange({ rename: true, change: false }, { isDirectory: false }, false), 'add')
  assert.equal(classifyChange({ rename: true, change: true }, { isDirectory: false }, false), 'add')
  assert.equal(classifyChange({ rename: true, change: false }, { isDirectory: true }, false), 'addDir')
  // 'change' only → change; a directory's own metadata → nothing
  assert.equal(classifyChange({ rename: false, change: true }, { isDirectory: false }, false), 'change')
  assert.equal(classifyChange({ rename: false, change: true }, { isDirectory: true }, true), null)
  // gone → unlink, unlinkDir when it was seen as a directory
  assert.equal(classifyChange({ rename: true, change: false }, null, false), 'unlink')
  assert.equal(classifyChange({ rename: true, change: false }, null, true), 'unlinkDir')
  assert.equal(classifyChange({ rename: false, change: true }, null, false), 'unlink')
})

function fakeWatcher(opts: { windowMs?: number; maxBatch?: number; disk: Map<string, 'file' | 'dir'>; root?: string }) {
  const root = opts.root ?? path.resolve('/company')
  let emit: ((type: RawEventType, rel: string | null) => void) | null = null
  const batches: FileChange[][] = []
  let stats = 0
  const watcher = new CompanyWatcher({
    root,
    windowMs: opts.windowMs ?? 20,
    maxBatch: opts.maxBatch,
    logger: quiet,
    onChanges: c => batches.push(c),
    watchRecursive: (_root, onRaw) => { emit = onRaw; return { close: () => { emit = null } } },
    lstat: async abs => {
      stats++
      const kind = opts.disk.get(path.relative(root, abs))
      return kind ? { isDirectory: kind === 'dir' } : null
    },
  })
  watcher.start()
  return {
    watcher,
    batches,
    root,
    emit: (type: RawEventType, rel: string | null) => emit?.(type, rel),
    get stats() { return stats },
  }
}

test('events are coalesced per path within the window and sent as one batch', async () => {
  const disk = new Map<string, 'file' | 'dir'>([['a.md', 'file'], ['新しいフォルダ', 'dir'], ['img.png', 'file']])
  const w = fakeWatcher({ disk })
  w.emit('rename', 'a.md')
  w.emit('change', 'a.md')
  w.emit('change', 'a.md')
  w.emit('rename', '新しいフォルダ')
  w.emit('rename', 'tmp-123.png') // temp file written then renamed away: gone at the end
  w.emit('rename', 'img.png') // the rename's target: replaced
  w.emit('change', '.git/index') // ignored
  w.emit('change', '.DS_Store') // ignored
  assert.equal(w.batches.length, 0, 'nothing is sent before the window ends')
  await sleep(60)
  assert.equal(w.batches.length, 1)
  assert.deepEqual(w.batches[0], [
    { type: 'add', path: path.join(w.root, 'a.md') },
    { type: 'addDir', path: path.join(w.root, '新しいフォルダ') },
    { type: 'unlink', path: path.join(w.root, 'tmp-123.png') },
    { type: 'add', path: path.join(w.root, 'img.png') },
  ])
  // A later content change of the same file is a 'change'; a removed folder it saw is unlinkDir.
  disk.delete('新しいフォルダ')
  w.emit('change', 'a.md')
  w.emit('rename', '新しいフォルダ')
  await sleep(60)
  assert.deepEqual(w.batches[1], [
    { type: 'change', path: path.join(w.root, 'a.md') },
    { type: 'unlinkDir', path: path.join(w.root, '新しいフォルダ') },
  ])
  w.watcher.close()
})

test('a burst is split into batches of at most maxBatch paths, none lost', async () => {
  const disk = new Map<string, 'file' | 'dir'>()
  for (let i = 0; i < 25; i++) disk.set(`f${i}.txt`, 'file')
  const w = fakeWatcher({ disk, maxBatch: 10, windowMs: 5 })
  for (let i = 0; i < 25; i++) w.emit('rename', `f${i}.txt`)
  await sleep(120)
  assert.deepEqual(w.batches.map(b => b.length), [10, 10, 5])
  assert.equal(new Set(w.batches.flat().map(c => c.path)).size, 25)
  w.watcher.close()
})

test('an event without a file name re-reads the root; nothing is sent after close', async () => {
  const disk = new Map<string, 'file' | 'dir'>([['', 'dir']])
  const w = fakeWatcher({ disk })
  w.emit('rename', null)
  await sleep(60)
  assert.deepEqual(w.batches[0], [{ type: 'addDir', path: w.root }])
  w.emit('rename', 'x')
  w.watcher.close()
  await sleep(60)
  assert.equal(w.batches.length, 1)
})

test('falls back when recursive fs.watch is unavailable on the platform', () => {
  let fallbackRoot = ''
  const watcher = new CompanyWatcher({
    root: '/company',
    logger: quiet,
    onChanges: () => {},
    watchRecursive: () => { throw Object.assign(new Error('no recursive'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }) },
    fallback: (root) => { fallbackRoot = root; return { close: () => {} } },
  })
  watcher.start()
  assert.equal(watcher.mode, 'fallback')
  assert.equal(fallbackRoot, path.resolve('/company'))
  watcher.close()
})

test('a watcher error reopens the watcher after a pause', async () => {
  let opens = 0
  let fail: ((e: unknown) => void) | null = null
  const watcher = new CompanyWatcher({
    root: '/company',
    logger: quiet,
    onChanges: () => {},
    lstat: async () => ({ isDirectory: true }),
    watchRecursive: (_r, _raw, onError) => { opens++; fail = onError; return { close: () => {} } },
  })
  watcher.start()
  assert.equal(opens, 1)
  fail!(new Error('EPERM'))
  await sleep(1100)
  assert.equal(opens, 2)
  watcher.close()
})

test('coveringRoot: a company folder covers itself and everything inside it', () => {
  const root = path.resolve('/Users/me/Company')
  assert.equal(coveringRoot([root], root), root)
  assert.equal(coveringRoot([root], path.join(root, '営業部')), root)
  assert.equal(coveringRoot([root], path.resolve('/Users/me/Company2')), null)
  assert.equal(coveringRoot([root], path.resolve('/Users/me')), null)
})

// ── live: the real recursive fs.watch on a scratch folder ──────────────────

function liveWatcher(root: string) {
  const changes: Array<FileChange & { at: number }> = []
  const watcher = new CompanyWatcher({ root, logger: quiet, onChanges: c => { const at = Date.now(); for (const x of c) changes.push({ ...x, at }) } })
  watcher.start()
  return { watcher, changes }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<number> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await sleep(10)
  }
  return Date.now() - start
}

test('live: create / modify / replace-by-rename / delete files and images, nested folders; .git ignored', { timeout: 30000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-watch-')))
  const { watcher, changes } = liveWatcher(root)
  await sleep(150) // let FSEvents start
  const has = (type: string, rel: string) => () => changes.some(c => c.type === type && c.path === path.join(root, rel))
  const latencies: Record<string, number> = {}
  try {
    // create a nested folder with a file
    fs.mkdirSync(path.join(root, '部署/資料'), { recursive: true })
    fs.writeFileSync(path.join(root, '部署/資料/メモ.md'), 'one')
    latencies.create = await waitFor(has('add', '部署/資料/メモ.md'))
    assert.ok(changes.some(c => c.type === 'addDir' && c.path === path.join(root, '部署')), 'addDir for the new folder')

    // modify in place
    changes.length = 0
    await sleep(150)
    fs.appendFileSync(path.join(root, '部署/資料/メモ.md'), ' two')
    latencies.modify = await waitFor(() => changes.some(c => (c.type === 'change' || c.type === 'add') && c.path === path.join(root, '部署/資料/メモ.md')))

    // an image replaced by write-temp-then-rename (how editors and the AI save atomically)
    fs.writeFileSync(path.join(root, '部署/図.png'), Buffer.from([1, 2, 3]))
    await waitFor(has('add', '部署/図.png'))
    changes.length = 0
    await sleep(150)
    fs.writeFileSync(path.join(root, '部署/.図.png.tmp'), Buffer.from([4, 5, 6]))
    fs.renameSync(path.join(root, '部署/.図.png.tmp'), path.join(root, '部署/図.png'))
    latencies.replace = await waitFor(has('add', '部署/図.png'))
    assert.ok(!changes.some(c => c.type === 'unlink' && c.path === path.join(root, '部署/図.png')), 'the replaced file is never reported as deleted')

    // delete a file, then a whole folder
    changes.length = 0
    fs.unlinkSync(path.join(root, '部署/資料/メモ.md'))
    latencies.delete = await waitFor(has('unlink', '部署/資料/メモ.md'))
    fs.rmSync(path.join(root, '部署/資料'), { recursive: true })
    latencies.deleteDir = await waitFor(() => changes.some(c => (c.type === 'unlinkDir' || c.type === 'unlink') && c.path === path.join(root, '部署/資料')))

    // git internals never reach the renderer
    changes.length = 0
    fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true })
    await sleep(200)
    changes.length = 0
    fs.writeFileSync(path.join(root, '.git/objects/x'), 'x')
    fs.writeFileSync(path.join(root, '部署/after-git.txt'), 'x')
    await waitFor(has('add', '部署/after-git.txt'))
    assert.ok(!changes.some(c => c.path.includes(`${path.sep}.git${path.sep}`)), JSON.stringify(changes))

    for (const [name, ms] of Object.entries(latencies)) {
      assert.ok(ms < 1000, `${name} arrived after ${ms} ms`)
    }
    if (process.env.ACB_WATCH_VERBOSE) console.log('latencies (ms)', latencies)
  } finally {
    watcher.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('live: opening and closing a recursive watcher is fast', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-watch-')))
  try {
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(root, `d${i}/e`), { recursive: true })
    const t0 = performance.now()
    const watcher = new CompanyWatcher({ root, logger: quiet, onChanges: () => {} })
    watcher.start()
    const opened = performance.now() - t0
    const t1 = performance.now()
    watcher.close()
    const closed = performance.now() - t1
    assert.ok(opened < 200, `open took ${opened} ms`)
    assert.ok(closed < 200, `close took ${closed} ms`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

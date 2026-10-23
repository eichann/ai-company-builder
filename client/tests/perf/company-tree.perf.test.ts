// Performance baselines for #151 at company size (15k files): one recursive
// watcher per company, and a lazy file tree whose first view is one small
// read. Behaviour at small size is covered by tests/company-watcher.test.ts
// and tests/file-tree-model.test.ts; these add the scale and the numbers.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CompanyWatcher } from '../../electron/company-watcher'
import { FileTreeModel, type FileTreeIO, type RawDirEntry } from '../../src/lib/fileTreeModel'
import { budget, generateCompanyTree, scratch, timeMs } from './perf'

const tree = scratch('tree')
after(() => tree.cleanup())
const root = path.join(tree.dir, 'company')
fs.mkdirSync(root)
const fileCount = generateCompanyTree(root)

test('perf #151: one recursive watch handle for a 15k-file company; open + close stay fast', async () => {
  assert.equal(fileCount, 15_000)
  // Count every fs.watch the watcher's default implementation makes.
  const realWatch = fs.watch
  let handles = 0
  ;(fs as { watch: typeof fs.watch }).watch = ((...args: unknown[]) => {
    handles++
    return (realWatch as (...a: unknown[]) => fs.FSWatcher)(...args)
  }) as typeof fs.watch
  const watcher = new CompanyWatcher({ root, onChanges: () => {}, logger: { warn: () => {}, log: () => {} } })
  try {
    const { ms } = await timeMs(() => { watcher.start(); watcher.close() })
    assert.equal(watcher.mode, 'recursive')
    budget('watcher.handles', handles, 'handles', 1)
    budget('watcher.openClose', ms, 'ms', 500)
  } finally {
    watcher.close()
    ;(fs as { watch: typeof fs.watch }).watch = realWatch
  }
})

// The renderer's IO, answering like main.ts's fs:readDirectory /
// fs:readDirectoryTree handlers (same algorithm, without IPC and the
// allowed-root check; those handlers live inside main.ts).
const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '.backups', '.workspace', '__pycache__', '.next', '.nuxt', 'dist', '.venv', 'venv'])
async function readDirectoryTree(dir: string, maxDepth: number, depth = 0): Promise<RawDirEntry[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  return Promise.all(entries.map(async (entry) => {
    const node: RawDirEntry = { name: entry.name, isDirectory: entry.isDirectory(), path: path.join(dir, entry.name) }
    if (node.isDirectory && depth < maxDepth && !TREE_SKIP_DIRS.has(entry.name)) node.children = await readDirectoryTree(node.path, maxDepth, depth + 1)
    return node
  }))
}

test('perf #151: the first file-tree view of a 15k-file company is one small IPC payload', async () => {
  const payloads: number[] = []
  const io: FileTreeIO = {
    async readDirectory(dir) {
      const out = await readDirectoryTree(dir, 0)
      payloads.push(Buffer.byteLength(JSON.stringify(out)))
      return out
    },
    async readDirectoryTree(dir, maxDepth) {
      const out = await readDirectoryTree(dir, maxDepth)
      payloads.push(Buffer.byteLength(JSON.stringify(out)))
      return out
    },
  }
  const model = new FileTreeModel(root, io)
  const { ms } = await timeMs(() => model.activate())
  assert.equal(payloads.length, 1, 'the first view is one IPC call')
  // The whole tree would be ~2 MB; two levels are ~55 KB.
  budget('fileTree.firstView.payload', payloads[0], 'bytes', 400_000)
  budget('fileTree.firstView.time', ms, 'ms', 1_000)
})

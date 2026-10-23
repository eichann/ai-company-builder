// IPC characterization: the file-system handlers of electron/main.ts
// (fs:*, editor:backupBeforeOverwrite, env:*, dialog:selectDirectory,
// privateFolders:reservedPathRefusal) and the local-file:// protocol, called
// through the real registrations with a fake Electron (tests/ipc-harness).
//
// The logic one level down is tested elsewhere (not-downloaded.ts and
// sparse-paths in sparse-paths.test.ts, the path checker in
// private-folders-sync.test.ts, the backup plan in editor-disk-state.test.ts,
// localFileTarget in local-file-url.test.ts, the watcher in
// company-watcher.test.ts). These tests pin what lives in main.ts itself —
// the allowed-roots check, which refusal each handler applies, and each
// handler's result shape — so splitting main.ts cannot change them silently.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadMain, writeFiles, type MainHarness } from './ipc-harness/main-harness.ts'
import { notDownloadedUserMessage } from '../shared/sparse-paths'

let h: MainHarness
let root: string
let outside: string

before(async () => {
  h = await loadMain()
  outside = h.companyDir('outside')
  writeFiles(outside, { 'secret.txt': 'outside' })
  root = h.companyDir('acme')
  // A sibling whose name starts with the root's: must not count as inside.
  writeFiles(`${root}-other`, { 'x.txt': 'sibling' })
  h.fake.openDialogResults.push({ canceled: false, filePaths: [root] })
  // The folder picker is one of the two ways a root becomes allowed.
  assert.equal(await h.invoke('dialog:selectDirectory'), root)
  assert.equal(await h.invoke('dialog:selectDirectory'), null) // cancelled
})
after(() => h.shutdown())

const DENIED = 'Access denied: path is outside allowed directories'

test('every path-taking fs handler refuses paths outside the allowed roots, with its own failure value', async () => {
  writeFiles(root, { 'in.txt': 'inside' })
  const secret = path.join(outside, 'secret.txt')
  const targets = [secret, path.join(root, '..', 'outside', 'secret.txt'), path.join(`${root}-other`, 'x.txt')]
  const inside = path.join(root, 'in.txt')
  const err = { success: false, error: DENIED }
  // [channel, args for an outside target t, expected result]
  const table: Array<[string, (t: string) => unknown[], unknown]> = [
    ['fs:readDirectory', t => [path.dirname(t)], []],
    ['fs:readDirectoryTree', t => [path.dirname(t)], []],
    ['fs:readFile', t => [t], null],
    ['fs:readFileBinary', t => [t], null],
    ['fs:writeFile', t => [t, 'pwned'], false],
    ['fs:createDirectory', t => [path.join(path.dirname(t), 'new-dir')], false],
    ['fs:exists', t => [t], false],
    ['fs:stat', t => [t], { success: false }],
    ['fs:delete', t => [t], err],
    ['fs:rename', t => [t, path.join(root, 'stolen.txt')], err],
    ['fs:rename', t => [inside, t], err],
    ['fs:move', t => [t, path.join(root, 'stolen.txt')], err],
    ['fs:move', t => [inside, t], err],
    ['fs:copy', t => [t, path.join(root, 'stolen.txt')], err],
    ['fs:copy', t => [inside, t], err],
    // The source of a Finder drop is outside by design; only the destination is checked.
    ['fs:moveFromExternal', t => [inside, t], err],
    ['fs:watch', t => [path.dirname(t)], err],
    ['fs:unwatch', t => [path.dirname(t)], err],
    ['env:read', t => [path.dirname(t)], err],
    ['env:write', t => [path.dirname(t), { A: '1' }], err],
    ['editor:backupBeforeOverwrite', t => [path.dirname(t), t], err],
    ['editor:backupBeforeOverwrite', t => [root, t], err],
    ['privateFolders:reservedPathRefusal', t => [t], null],
  ]
  for (const t of targets) {
    for (const [channel, args, expected] of table) {
      assert.deepEqual(await h.invoke(channel, ...args(t)), expected, `${channel} ${path.relative(h.base, t)}`)
    }
    assert.throws(() => h.send('fs:startDrag', t), new RegExp(DENIED))
  }
  // Nothing outside was touched, nothing was pulled in.
  assert.equal(fs.readFileSync(secret, 'utf-8'), 'outside')
  assert.equal(fs.readFileSync(path.join(`${root}-other`, 'x.txt'), 'utf-8'), 'sibling')
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
  assert.equal(fs.existsSync(path.join(root, 'stolen.txt')), false)
  assert.equal(fs.readFileSync(inside, 'utf-8'), 'inside')
})

test('registering a root: fs:registerAllowedRoot accepts only a non-empty string', async () => {
  const later = h.companyDir('later')
  writeFiles(later, { 'a.txt': 'a' })
  assert.equal(await h.invoke('fs:readFile', path.join(later, 'a.txt')), null)
  for (const bad of [undefined, '', 42]) assert.deepEqual(await h.invoke('fs:registerAllowedRoot', bad), { success: true })
  assert.equal(await h.invoke('fs:readFile', path.join(later, 'a.txt')), null)
  assert.deepEqual(await h.invoke('fs:registerAllowedRoot', later), { success: true })
  assert.equal(await h.invoke('fs:readFile', path.join(later, 'a.txt')), 'a')
})

test('FINDING (not refused today): the roots check is lexical, so a symlink inside a root reaches outside it', async () => {
  // Reported for a later fix; this pins today's behaviour so a refactor does
  // not change it unnoticed. A fix should flip these assertions.
  fs.symlinkSync(outside, path.join(root, 'link-out'))
  assert.equal(await h.invoke('fs:readFile', path.join(root, 'link-out', 'secret.txt')), 'outside')
  assert.equal(await h.invoke('fs:writeFile', path.join(root, 'link-out', 'written.txt'), 'x'), true)
  assert.equal(fs.readFileSync(path.join(outside, 'written.txt'), 'utf-8'), 'x')
  fs.rmSync(path.join(outside, 'written.txt'))
  fs.rmSync(path.join(root, 'link-out'))
})

test('fs handlers inside a root: result shapes', async () => {
  const dir = path.join(root, 'shapes')
  writeFiles(dir, {
    'a.md': '# a',
    'bin.dat': Buffer.from([0, 1, 2, 255]),
    'sub/deeper/deepest/x.md': 'x',
    'node_modules/pkg/index.js': '',
    '.backups/old/f.md': '',
  })
  const entries = await h.invoke<Array<{ name: string; isDirectory: boolean; path: string }>>('fs:readDirectory', dir)
  assert.deepEqual(entries.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: '.backups', isDirectory: true, path: path.join(dir, '.backups') },
    { name: 'a.md', isDirectory: false, path: path.join(dir, 'a.md') },
    { name: 'bin.dat', isDirectory: false, path: path.join(dir, 'bin.dat') },
    { name: 'node_modules', isDirectory: true, path: path.join(dir, 'node_modules') },
    { name: 'sub', isDirectory: true, path: path.join(dir, 'sub') },
  ])
  assert.deepEqual(await h.invoke('fs:readDirectory', path.join(dir, 'missing')), [])

  // Tree: maxDepth levels of children (default 2 from preload), skipped dirs listed without children.
  type Node = { name: string; isDirectory: boolean; path: string; children?: Node[] }
  const strip = (nodes: Node[]): unknown[] => nodes.sort((a, b) => a.name.localeCompare(b.name))
    .map(n => (n.children ? { name: n.name, children: strip(n.children) } : n.name))
  assert.deepEqual(strip(await h.invoke<Node[]>('fs:readDirectoryTree', dir, 2)), [
    '.backups', 'a.md', 'bin.dat', 'node_modules',
    { name: 'sub', children: [{ name: 'deeper', children: ['deepest'] }] },
  ])
  assert.deepEqual(strip(await h.invoke<Node[]>('fs:readDirectoryTree', dir, 0)), ['.backups', 'a.md', 'bin.dat', 'node_modules', 'sub'])

  assert.equal(await h.invoke('fs:readFile', path.join(dir, 'a.md')), '# a')
  assert.equal(await h.invoke('fs:readFile', path.join(dir, 'missing.md')), null)
  const binary = await h.invoke<ArrayBuffer>('fs:readFileBinary', path.join(dir, 'bin.dat'))
  assert.ok(binary instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(binary)], [0, 1, 2, 255])

  assert.equal(await h.invoke('fs:writeFile', path.join(dir, 'w.md'), 'written'), true)
  assert.equal(fs.readFileSync(path.join(dir, 'w.md'), 'utf-8'), 'written')
  assert.equal(await h.invoke('fs:writeFile', path.join(dir, 'no-such-dir', 'w.md'), 'x'), false) // no mkdir -p
  assert.equal(await h.invoke('fs:createDirectory', path.join(dir, 'n1', 'n2')), true) // recursive
  assert.equal(await h.invoke('fs:exists', path.join(dir, 'n1', 'n2')), true)

  const stat = await h.invoke<{ success: boolean; data: Record<string, unknown> }>('fs:stat', path.join(dir, 'a.md'))
  assert.deepEqual(Object.keys(stat.data).sort(), ['ctime', 'isDirectory', 'isFile', 'mtime', 'size'])
  assert.deepEqual({ ...stat, data: { ...stat.data, mtime: 0, ctime: 0 } }, { success: true, data: { isDirectory: false, isFile: true, size: 3, mtime: 0, ctime: 0 } })
  assert.match(String(stat.data.mtime), /^\d{4}-\d\d-\d\dT.*Z$/)

  assert.deepEqual(await h.invoke('fs:rename', path.join(dir, 'w.md'), path.join(dir, 'r.md')), { success: true, newPath: path.join(dir, 'r.md') })
  assert.deepEqual(await h.invoke('fs:move', path.join(dir, 'r.md'), path.join(dir, 'sub', 'r.md')), { success: true })
  assert.deepEqual(await h.invoke('fs:copy', path.join(dir, 'sub'), path.join(dir, 'sub-copy')), { success: true }) // recursive
  assert.equal(fs.readFileSync(path.join(dir, 'sub-copy', 'deeper', 'deepest', 'x.md'), 'utf-8'), 'x')
  const dropped = path.join(h.companyDir('finder'), 'drop.md')
  fs.writeFileSync(dropped, 'dropped')
  assert.deepEqual(await h.invoke('fs:moveFromExternal', dropped, path.join(dir, 'drop.md')), { success: true })
  assert.equal(fs.existsSync(dropped), false)
  assert.deepEqual(await h.invoke('fs:delete', path.join(dir, 'sub-copy')), { success: true }) // a folder, recursively
  assert.deepEqual(await h.invoke('fs:delete', path.join(dir, 'drop.md')), { success: true })
  const missing = await h.invoke<{ success: boolean; error: string }>('fs:delete', path.join(dir, 'drop.md'))
  assert.equal(missing.success, false)
  assert.match(missing.error, /ENOENT/)

  h.send('fs:startDrag', path.join(dir, 'a.md'))
  assert.equal((h.renderer().drags.at(-1) as { file: string }).file, path.join(dir, 'a.md'))
})

test('writes into a not-downloaded folder or at a reserved folder name are refused; reads and existing paths are not', async () => {
  const company = h.companyDir('sparse-co')
  await h.invoke('fs:registerAllowedRoot', company)
  // A checkout with 営業部 left out (what sync writes; read by sync/not-downloaded.ts) ...
  writeFiles(company, {
    '.git/acb-sparse-config.json': JSON.stringify({ excluded: ['営業部'] }),
    '.git/config': '[core]\n\tsparseCheckout = true\n',
    '.git/info/sparse-checkout': '/*\n!/営業部/\n',
    // ... and a private-folder cache, so new paths are checked with the server.
    '.git/acb-private-scopes.json': JSON.stringify({ companyId: 'co-1', version: '1', fetchedAt: '', scopes: [] }),
    'docs/existing.md': 'e',
    '人事/existing.md': 'already here',
    'src.md': 'source',
  })
  h.server.on('POST', '/api/companies/co-1/paths/check', req => {
    const { paths } = JSON.parse(req.body ?? '{}') as { paths: string[] }
    return { json: { success: true, data: { results: paths.map(p => ({ path: p, usable: !p.startsWith('評価') })) } } }
  })
  const notDownloaded = notDownloadedUserMessage('営業部')
  const reserved = '『評価』というフォルダ名は使えません。別の名前にしてください。'
  const src = path.join(company, 'src.md')
  for (const [target, message] of [[path.join(company, '営業部', 'a.md'), notDownloaded], [path.join(company, '評価', 'a.md'), reserved]] as const) {
    assert.equal(await h.invoke('fs:writeFile', target, 'x'), false)
    assert.equal(await h.invoke('fs:createDirectory', path.dirname(target)), false)
    for (const channel of ['fs:rename', 'fs:move', 'fs:copy', 'fs:moveFromExternal']) {
      assert.deepEqual(await h.invoke(channel, src, target), { success: false, error: message }, channel)
    }
    assert.equal(await h.invoke('privateFolders:reservedPathRefusal', target), message === reserved ? reserved : null)
    assert.equal(fs.existsSync(path.dirname(target)), false)
  }
  assert.equal(fs.readFileSync(src, 'utf-8'), 'source')

  // Writing an existing file never asks the server (an editor save does not wait on it).
  const asked = h.server.requests.length
  assert.equal(await h.invoke('fs:writeFile', path.join(company, '人事', 'existing.md'), 'edited'), true)
  assert.equal(await h.invoke('fs:writeFile', path.join(company, 'docs', 'existing.md'), 'edited'), true)
  assert.equal(h.server.requests.length, asked)
  // Unknown (server unreachable) never blocks.
  h.server.offline = true
  assert.equal(await h.invoke('fs:createDirectory', path.join(company, '評価-offline')), true)
  h.server.offline = false
})

test('editor:backupBeforeOverwrite: the disk version, byte for byte, in .backups or (private folder / nested repo) in .git', async () => {
  const company = h.companyDir('backup-co')
  await h.invoke('fs:registerAllowedRoot', company)
  writeFiles(company, {
    '.git/acb-private-scopes.json': JSON.stringify({
      companyId: 'co-2', version: '1', fetchedAt: '',
      scopes: [{ scopeId: 's1', path: '人事/評価', cloneUrl: 'x', clonePath: 'x', canWrite: true }],
    }),
    '営業/a.bin': Buffer.from([0, 200, 1]),
    '人事/評価/b.md': 'private',
    'tools/nested/.git/HEAD': 'ref: refs/heads/main\n',
    'tools/nested/c.md': 'nested',
  })
  type Backup = { success: boolean; backupPath?: string; skipped?: string }
  const pub = await h.invoke<Backup>('editor:backupBeforeOverwrite', company, path.join(company, '営業', 'a.bin'))
  assert.equal(pub.success, true)
  assert.match(path.relative(company, pub.backupPath!), /^\.backups[/\\]\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}_editor_overwrite$/)
  assert.deepEqual([...fs.readFileSync(path.join(pub.backupPath!, '営業', 'a.bin'))], [0, 200, 1])
  const metadata = JSON.parse(fs.readFileSync(path.join(pub.backupPath!, '_metadata.json'), 'utf-8'))
  assert.deepEqual({ ...metadata, timestamp: typeof metadata.timestamp }, { timestamp: 'string', reason: 'editor_overwrite', files: ['営業/a.bin'], privateFolder: false })

  for (const rel of ['人事/評価/b.md', 'tools/nested/c.md']) {
    const priv = await h.invoke<Backup>('editor:backupBeforeOverwrite', company, path.join(company, ...rel.split('/')))
    assert.match(path.relative(company, priv.backupPath!).split(path.sep).join('/'), /^\.git\/acb-private-backups\/.*_editor_overwrite$/, rel)
    assert.ok(fs.existsSync(path.join(priv.backupPath!, ...rel.split('/'))), rel)
  }
  assert.deepEqual(await h.invoke('editor:backupBeforeOverwrite', company, path.join(company, 'gone.md')), { success: true, skipped: 'missing' })
  writeFiles(company, { '.backups/x/y.md': 'y' })
  assert.deepEqual(await h.invoke('editor:backupBeforeOverwrite', company, path.join(company, '.backups', 'x', 'y.md')), { success: true, skipped: 'internal' })
})

test('env:read / env:write: the .env format, and .gitignore always keeps .env local', async () => {
  const company = h.companyDir('env-co')
  await h.invoke('fs:registerAllowedRoot', company)
  assert.deepEqual(await h.invoke('env:read', company), { success: true, vars: {} })
  fs.writeFileSync(path.join(company, '.env'), '# comment\n\nA=1\n B = "two words" \nC=\'q\'\nnoequals\n=empty\nD=x=y\n')
  assert.deepEqual(await h.invoke('env:read', company), { success: true, vars: { A: '1', B: 'two words', C: 'q', D: 'x=y' } })

  fs.writeFileSync(path.join(company, '.gitignore'), 'node_modules/\n.env')
  assert.deepEqual(await h.invoke('env:write', company, { KEY: 'plain', SPACED: 'a b', HASH: 'a#b', EQ: 'a=b' }), { success: true })
  assert.equal(fs.readFileSync(path.join(company, '.env'), 'utf-8'), 'KEY=plain\nSPACED="a b"\nHASH="a#b"\nEQ="a=b"\n')
  const healed = 'node_modules/\n.env\n# Secrets — never sync (local only)\n.env.*\n!.env.example\n!.env.sample\n'
  assert.equal(fs.readFileSync(path.join(company, '.gitignore'), 'utf-8'), healed)
  await h.invoke('env:write', company, { KEY: 'again' })
  assert.equal(fs.readFileSync(path.join(company, '.gitignore'), 'utf-8'), healed) // idempotent
})

test('local-file:// serves files inside the allowed roots only, never cached', async () => {
  await h.startApp()
  assert.deepEqual(h.fake.privilegedSchemes, [{ scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } }])
  const serve = h.fake.protocolHandlers.get('local-file')!
  writeFiles(root, { '画像/図 1.png': 'png-bytes' })
  const ok = await serve(new Request(`local-file://${encodeURI(path.join(root, '画像', '図 1.png'))}?v=3`))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('Cache-Control'), 'no-store')
  assert.equal(await ok.text(), 'png-bytes')
  // The root set is the one the fs handlers use: a root registered later is served too.
  const later = h.companyDir('served-later')
  writeFiles(later, { 'a.txt': 'later' })
  assert.equal((await serve(new Request(`local-file://${later}/a.txt`))).status, 403)
  await h.invoke('fs:registerAllowedRoot', later)
  assert.equal((await serve(new Request(`local-file://${later}/a.txt`))).status, 200)
  for (const url of [`local-file://${outside}/secret.txt`, `local-file://${root}/../outside/secret.txt`, `local-file://${root}-other/x.txt`]) {
    const res = await serve(new Request(url))
    assert.equal(res.status, 403, url)
    assert.equal(await res.text(), 'Forbidden: path is outside allowed directories')
  }
  assert.equal((await serve(new Request('local-file://'))).status, 400)
})

test('fs:watch sends the watcher batches to the window as fs:changes; fs:unwatch stops them', async () => {
  await h.startApp()
  const company = h.companyDir('watched')
  await h.invoke('fs:registerAllowedRoot', company)
  assert.deepEqual(await h.invoke('fs:watch', company), { success: true })
  assert.deepEqual(await h.invoke('fs:watch', path.join(company, 'inner')), { success: true }) // covered by the parent
  const window = h.renderer()
  window.clearSent()
  const file = path.join(company, 'new.md')
  const deadline = Date.now() + 15_000
  // Live file events; retried, since a loaded machine can be slow to report.
  while (!window.sentOn('fs:changes').flat(2).some(c => (c as { path: string }).path === file)) {
    if (Date.now() > deadline) assert.fail(`no fs:changes for ${file}: ${JSON.stringify(window.sent)}`)
    fs.writeFileSync(file, String(Date.now()))
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  assert.deepEqual(await h.invoke('fs:unwatch', company), { success: true })
  await new Promise(resolve => setTimeout(resolve, 300))
  window.clearSent()
  fs.writeFileSync(path.join(company, 'after.md'), 'x')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.deepEqual(window.sentOn('fs:changes'), [])
})

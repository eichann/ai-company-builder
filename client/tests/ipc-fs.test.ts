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
const LINK_ESCAPE = 'このファイル（またはフォルダ）は会社フォルダの外を指すリンク（シンボリックリンク）のため、アプリでは開いたり変更したりできません。'

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
    ['env:status', t => [path.dirname(t)], err],
    ['env:update', t => [path.dirname(t), { A: '1' }], err],
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

test('symbolic links: judged by their real location — a link leading out of the company folder is refused, one inside works', async () => {
  // A teammate can commit a link; the member must not read or overwrite
  // ~/.zshrc (or another company's folder) through it.
  const company = h.companyDir('links-co')
  const sibling = h.companyDir('links-sibling') // another registered company
  await h.invoke('fs:registerAllowedRoot', company)
  await h.invoke('fs:registerAllowedRoot', sibling)
  writeFiles(company, { 'docs/a.md': 'inside' })
  writeFiles(sibling, { 'b.md': 'sibling' })
  const at = (...p: string[]) => path.join(company, ...p)
  fs.symlinkSync(outside, at('link-out'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), at('secret-link.md'))
  fs.symlinkSync(sibling, at('link-sibling'))
  fs.symlinkSync(path.join('..', '..', 'outside', 'secret.txt'), at('docs', 'relative-out.md')) // relative target
  fs.symlinkSync(path.join(outside, 'not-yet.txt'), at('dangling-out.md')) // writing would create it outside
  fs.symlinkSync('a.md', at('docs', 'link-in.md'))
  fs.symlinkSync(at('docs'), at('docs-link'))
  const nfdLink = at('リンク'.normalize('NFD'))
  fs.symlinkSync(outside, nfdLink)

  const escaping = [
    at('link-out', 'secret.txt'), at('secret-link.md'), at('link-sibling', 'b.md'), at('docs', 'relative-out.md'),
    at('dangling-out.md'), at('link-out', 'new', 'deeper.md'), path.join(nfdLink, 'secret.txt'),
    // Normalization-insensitive volume: the NFC spelling reaches the NFD-named link too.
    ...(process.platform === 'darwin' ? [at('リンク'.normalize('NFC'), 'secret.txt')] : []),
  ]
  const err = { success: false, error: LINK_ESCAPE }
  for (const t of escaping) {
    const where = path.relative(company, t)
    assert.equal(await h.invoke('fs:readFile', t), null, where)
    assert.equal(await h.invoke('fs:readFileBinary', t), null, where)
    assert.equal(await h.invoke('fs:writeFile', t, 'pwned'), false, where)
    assert.equal(await h.invoke('fs:exists', t), false, where)
    assert.deepEqual(await h.invoke('fs:stat', t), { success: false }, where)
    assert.equal(await h.invoke('fs:createDirectory', path.join(t, 'dir')), false, where)
    assert.deepEqual(await h.invoke('fs:copy', t, at('stolen.md')), err, where)
    assert.deepEqual(await h.invoke('fs:copy', at('docs', 'a.md'), t), err, where)
    assert.deepEqual(await h.invoke('fs:move', at('docs', 'a.md'), t), err, where)
    assert.deepEqual(await h.invoke('fs:moveFromExternal', path.join(h.companyDir('finder-links'), 'x.md'), t), err, where)
    assert.deepEqual(await h.invoke('editor:backupBeforeOverwrite', company, t), err, where)
    assert.throws(() => h.send('fs:startDrag', t), { message: LINK_ESCAPE }, where)
  }
  assert.deepEqual(await h.invoke('fs:readDirectory', at('link-out')), [])
  assert.deepEqual(await h.invoke('fs:delete', at('link-out', 'secret.txt')), err) // through the link: refused
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8'), 'outside')
  assert.equal(fs.readFileSync(path.join(sibling, 'b.md'), 'utf-8'), 'sibling')
  assert.deepEqual(fs.readdirSync(outside).sort(), ['secret.txt'])
  assert.equal(fs.existsSync(at('stolen.md')), false)

  // Links that stay inside behave like the files they point to.
  assert.equal(await h.invoke('fs:readFile', at('docs', 'link-in.md')), 'inside')
  assert.equal(await h.invoke('fs:writeFile', at('docs-link', 'b.md'), 'via link'), true)
  assert.equal(fs.readFileSync(at('docs', 'b.md'), 'utf-8'), 'via link')
  if (process.platform === 'darwin') {
    // Case- and normalization-insensitive volume: another spelling of an existing folder is the same folder.
    assert.equal(await h.invoke('fs:readFile', at('DOCS', 'a.md')), 'inside')
  }

  // The tree lists links without descending into them (a Dirent is not followed).
  type Node = { name: string; isDirectory: boolean; children?: unknown[] }
  const tree = await h.invoke<Node[]>('fs:readDirectoryTree', company, 3)
  assert.deepEqual(tree.find(n => n.name === 'link-out'), { name: 'link-out', isDirectory: false, path: at('link-out') })

  // The link itself lives inside: it can be renamed and deleted, and deleting never touches the target.
  assert.deepEqual(await h.invoke('fs:rename', at('link-out'), at('link-out-2')), { success: true, newPath: at('link-out-2') })
  assert.deepEqual(await h.invoke('fs:delete', at('link-out-2')), { success: true })
  assert.deepEqual(await h.invoke('fs:delete', at('secret-link.md')), { success: true })
  assert.deepEqual(await h.invoke('fs:delete', at('link-sibling')), { success: true })
  assert.equal(fs.existsSync(at('link-out-2')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8'), 'outside')
  assert.equal(fs.readFileSync(path.join(sibling, 'b.md'), 'utf-8'), 'sibling')

  // The registered root may itself be reached through a link (e.g. /tmp → /private/tmp).
  const viaLink = path.join(h.base, 'company-alias')
  fs.symlinkSync(company, viaLink)
  await h.invoke('fs:registerAllowedRoot', viaLink)
  assert.equal(await h.invoke('fs:readFile', path.join(viaLink, 'docs', 'a.md')), 'inside')
  assert.equal(await h.invoke('fs:readFile', path.join(viaLink, 'docs', 'relative-out.md')), null)
})

const shapes = (name: string) => {
  const dir = path.join(root, name)
  writeFiles(dir, {
    'a.md': '# a',
    'bin.dat': Buffer.from([0, 1, 2, 255]),
    'sub/deeper/deepest/x.md': 'x',
    'node_modules/pkg/index.js': '',
    '.backups/old/f.md': '',
  })
  return dir
}

test('the file tree shows node_modules and .backups but never walks into them, and stops at the depth asked for', async () => {
  const dir = shapes('tree')
  type Node = { name: string; isDirectory: boolean; path: string; children?: Node[] }
  const strip = (nodes: Node[]): unknown[] => nodes.sort((a, b) => a.name.localeCompare(b.name))
    .map(n => (n.children ? { name: n.name, children: strip(n.children) } : n.name))
  assert.deepEqual(strip(await h.invoke<Node[]>('fs:readDirectoryTree', dir, 2)), [
    '.backups', 'a.md', 'bin.dat', 'node_modules',
    { name: 'sub', children: [{ name: 'deeper', children: ['deepest'] }] },
  ])
  assert.deepEqual(strip(await h.invoke<Node[]>('fs:readDirectoryTree', dir, 0)), ['.backups', 'a.md', 'bin.dat', 'node_modules', 'sub'])
})

test('a binary file reaches the renderer byte for byte; a missing file or folder reads as nothing, not an error', async () => {
  const dir = shapes('read')
  const binary = await h.invoke<ArrayBuffer>('fs:readFileBinary', path.join(dir, 'bin.dat'))
  assert.deepEqual([...new Uint8Array(binary)], [0, 1, 2, 255])
  assert.equal(await h.invoke('fs:readFile', path.join(dir, 'missing.md')), null)
  assert.deepEqual(await h.invoke('fs:readDirectory', path.join(dir, 'missing')), [])
})

test('a save into a folder that no longer exists fails instead of creating the folder again', async () => {
  const dir = shapes('write')
  assert.equal(await h.invoke('fs:writeFile', path.join(dir, 'w.md'), 'written'), true)
  assert.equal(fs.readFileSync(path.join(dir, 'w.md'), 'utf-8'), 'written')
  assert.equal(await h.invoke('fs:writeFile', path.join(dir, 'no-such-dir', 'w.md'), 'x'), false)
  assert.equal(fs.existsSync(path.join(dir, 'no-such-dir')), false)
})

test('rename, move and copy bring the whole content along; a file dropped in from outside is moved (the original is gone)', async () => {
  const dir = shapes('move')
  fs.writeFileSync(path.join(dir, 'w.md'), 'written')
  await h.invoke('fs:rename', path.join(dir, 'w.md'), path.join(dir, 'r.md'))
  await h.invoke('fs:move', path.join(dir, 'r.md'), path.join(dir, 'sub', 'r.md'))
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'r.md'), 'utf-8'), 'written')
  assert.equal(fs.existsSync(path.join(dir, 'w.md')) || fs.existsSync(path.join(dir, 'r.md')), false)
  await h.invoke('fs:copy', path.join(dir, 'sub'), path.join(dir, 'sub-copy'))
  assert.equal(fs.readFileSync(path.join(dir, 'sub-copy', 'deeper', 'deepest', 'x.md'), 'utf-8'), 'x')
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'deeper', 'deepest', 'x.md'), 'utf-8'), 'x')
  const dropped = path.join(h.companyDir('finder'), 'drop.md')
  fs.writeFileSync(dropped, 'dropped')
  await h.invoke('fs:moveFromExternal', dropped, path.join(dir, 'drop.md'))
  assert.equal(fs.readFileSync(path.join(dir, 'drop.md'), 'utf-8'), 'dropped')
  assert.equal(fs.existsSync(dropped), false)
})

test('a new file, rename, move, copy or Finder drop never replaces what is already there; saving still does', async () => {
  // 新規ファイル with an existing name emptied that file, and a rename onto a
  // taken name silently replaced it — the next sync spread the loss.
  const dir = shapes('taken')
  writeFiles(dir, { 'keep.md': 'keep me', 'other.md': 'other', 'folder/inner.md': 'inner', 'sub-copy/x.md': 'mine' })
  const at = (...p: string[]) => path.join(dir, ...p)
  const taken = { success: false, error: '同じ名前のファイルまたはフォルダがすでにあります。別の名前にしてください。', code: 'name_taken' }
  assert.deepEqual(await h.invoke('fs:createFile', at('keep.md'), ''), taken)
  assert.deepEqual(await h.invoke('fs:rename', at('other.md'), at('keep.md')), taken)
  assert.deepEqual(await h.invoke('fs:rename', at('other.md'), at('folder')), taken)
  assert.deepEqual(await h.invoke('fs:move', at('other.md'), at('keep.md')), taken)
  assert.deepEqual(await h.invoke('fs:copy', at('other.md'), at('keep.md')), taken)
  assert.deepEqual(await h.invoke('fs:copy', at('sub'), at('sub-copy')), taken)
  const dropped = path.join(h.companyDir('finder-taken'), 'keep.md')
  fs.writeFileSync(dropped, 'from finder')
  assert.deepEqual(await h.invoke('fs:moveFromExternal', dropped, at('keep.md')), taken)
  assert.equal(fs.readFileSync(at('keep.md'), 'utf-8'), 'keep me')
  assert.equal(fs.readFileSync(at('other.md'), 'utf-8'), 'other')
  assert.equal(fs.readFileSync(at('folder', 'inner.md'), 'utf-8'), 'inner')
  assert.deepEqual(fs.readdirSync(at('sub-copy')), ['x.md'])
  assert.equal(fs.readFileSync(dropped, 'utf-8'), 'from finder')

  // A free name works; a case-only rename is the same file, not a taken name.
  assert.deepEqual(await h.invoke('fs:createFile', at('new.md'), 'hello'), { success: true })
  assert.equal(fs.readFileSync(at('new.md'), 'utf-8'), 'hello')
  assert.deepEqual(await h.invoke('fs:rename', at('new.md'), at('New.md')), { success: true, newPath: at('New.md') })
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.toLowerCase() === 'new.md'), ['New.md'])
  // Saving replaces on purpose: the editor, and the review's temporary file renamed over its sidecar.
  assert.equal(await h.invoke('fs:writeFile', at('keep.md'), 'saved'), true)
  fs.writeFileSync(at('.keep.md.acb-tmp-0a1b'), 'atomic')
  assert.deepEqual(await h.invoke('fs:rename', at('.keep.md.acb-tmp-0a1b'), at('keep.md')), { success: true, newPath: at('keep.md') })
  assert.equal(fs.readFileSync(at('keep.md'), 'utf-8'), 'atomic')
  // Only over its own target: a temporary file of another name is refused like any rename.
  fs.writeFileSync(at('.other.md.acb-tmp-0a1b'), 'x')
  assert.deepEqual(await h.invoke('fs:rename', at('.other.md.acb-tmp-0a1b'), at('keep.md')), taken)
})

test('deleting a folder removes everything in it; deleting what is not there reports a failure', async () => {
  const dir = shapes('delete')
  assert.deepEqual(await h.invoke('fs:delete', path.join(dir, 'sub')), { success: true })
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false)
  const missing = await h.invoke<{ success: boolean; error: string }>('fs:delete', path.join(dir, 'sub'))
  assert.equal(missing.success, false)
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

// Fake values only: what the test proves is that none of them reach the renderer.
const FAKE_ENV = {
  OPENAI_API_KEY: 'sk-FAKE-openai-value-9f3c',
  CUSTOM_TOKEN: 'FAKE token with spaces 7d2e',
  SHORT_PIN: 'pin1',
}

test('env:status never hands a .env value to the renderer: set and last four characters only', async () => {
  const company = h.companyDir('env-secret-co')
  await h.invoke('fs:registerAllowedRoot', company)
  fs.writeFileSync(path.join(company, '.env'), `# keys\nOPENAI_API_KEY=${FAKE_ENV.OPENAI_API_KEY}\nCUSTOM_TOKEN="${FAKE_ENV.CUSTOM_TOKEN}"\nSHORT_PIN=${FAKE_ENV.SHORT_PIN}\nEMPTY=\n`)
  const status = await h.invoke('env:status', company)
  assert.deepEqual(status, {
    success: true,
    vars: { OPENAI_API_KEY: { set: true, last4: '9f3c' }, CUSTOM_TOKEN: { set: true, last4: '7d2e' }, SHORT_PIN: { set: true }, EMPTY: { set: false } },
  })
  const wire = JSON.stringify(status)
  for (const value of Object.values(FAKE_ENV)) {
    // No value, nor any 5-character piece of one, is in the answer.
    for (let i = 0; i + 5 <= value.length; i++) assert.ok(!wire.includes(value.slice(i, i + 5)), 'a .env value reached the renderer')
  }
  assert.ok(!wire.includes(FAKE_ENV.SHORT_PIN))
  // The value-returning channels are gone, so no renderer can ask for them.
  for (const channel of ['env:read', 'env:write']) assert.equal(h.fake.handlers.has(channel), false, channel)
})

test('env:update: sets, replaces and removes names in place; refuses bad input; .gitignore keeps .env local', async () => {
  const company = h.companyDir('env-co')
  await h.invoke('fs:registerAllowedRoot', company)
  const envFile = path.join(company, '.env')
  assert.deepEqual(await h.invoke('env:status', company), { success: true, vars: {} })

  fs.writeFileSync(path.join(company, '.gitignore'), 'node_modules/\n.env')
  assert.deepEqual(await h.invoke('env:update', company, { KEY: 'plain', SPACED: 'a b', HASH: 'a#b', EQ: 'a=b' }), { success: true })
  assert.equal(fs.readFileSync(envFile, 'utf-8'), 'KEY=plain\nSPACED="a b"\nHASH="a#b"\nEQ="a=b"\n')
  const healed = 'node_modules/\n.env\n# Secrets — never sync (local only)\n.env.*\n!.env.example\n!.env.sample\n'
  assert.equal(fs.readFileSync(path.join(company, '.gitignore'), 'utf-8'), healed)

  fs.writeFileSync(envFile, '# mine\nKEY=plain\nKEEP=1\nGONE=x\n')
  assert.deepEqual(await h.invoke('env:update', company, { KEY: 'again', GONE: null, NEW: 'n' }), { success: true })
  assert.equal(fs.readFileSync(envFile, 'utf-8'), '# mine\nKEY=again\nKEEP=1\nNEW=n\n')
  assert.equal(fs.readFileSync(path.join(company, '.gitignore'), 'utf-8'), healed) // idempotent

  const before = fs.readFileSync(envFile, 'utf-8')
  for (const bad of [{ 'A=B': 'x' }, { A: 'x\nINJECTED=1' }, { A: 5 }, ['A']] as unknown as Record<string, string>[]) {
    const result = await h.invoke('env:update', company, bad)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /使えません|読み取れません/)
  }
  assert.equal(fs.readFileSync(envFile, 'utf-8'), before)
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
  // Inside by name, outside through a link: refused like any outside path.
  fs.symlinkSync(outside, path.join(root, 'served-out'))
  const viaLink = await serve(new Request(`local-file://${root}/served-out/secret.txt`))
  assert.equal(viaLink.status, 403)
  assert.equal(await viaLink.text(), 'Forbidden: path is outside allowed directories')
  fs.rmSync(path.join(root, 'served-out'))
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

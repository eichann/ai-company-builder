// Unit tests for the private-folder safety checks of sync (stage 3b): clone
// URL validation, symlinked ancestors, the path checker, the excludes block.
// The end-to-end behaviour is in tests/sync/private-folders.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cloneUrlAllowed, readPrivateExcludes, safeScopeDir, sameScopeRemote, writePrivateExcludes } from '../electron/sync/private-folders'
import { readNestedRepoExcludes, writeNestedRepoExcludes } from '../electron/sync/nested-repos'
import { createPathChecker, pathPrefixes } from '../electron/sync/path-check'
import { parseReservedPathRejection } from '../electron/sync/reserved-path'

const scope = { cloneUrl: 'https://acb.example.com/api/git-http/c1/scopes/s1.git', clonePath: '/api/git-http/c1/scopes/s1.git' }

test('clone URL: only the company server, the server clone path, never options or remote helpers', () => {
  const company = 'https://acb.example.com/api/git-http/c1.git'
  assert.equal(cloneUrlAllowed(scope, company), true)
  assert.equal(cloneUrlAllowed({ ...scope, cloneUrl: 'https://evil.example.com/api/git-http/c1/scopes/s1.git' }, company), false)
  assert.equal(cloneUrlAllowed({ ...scope, cloneUrl: 'http://acb.example.com/api/git-http/c1/scopes/s1.git' }, company), false)
  assert.equal(cloneUrlAllowed({ ...scope, cloneUrl: 'https://acb.example.com/other.git' }, company), false)
  assert.equal(cloneUrlAllowed({ ...scope, cloneUrl: '--upload-pack=touch /tmp/x' }, company), false)
  assert.equal(cloneUrlAllowed({ ...scope, cloneUrl: 'ext::sh -c touch% /tmp/x' }, company), false)
  // A local company remote (tests): local paths and file URLs only.
  assert.equal(cloneUrlAllowed({ cloneUrl: '/srv/repos/c1.scopes/r1.git', clonePath: '' }, '/srv/repos/c1.git'), true)
  assert.equal(cloneUrlAllowed({ cloneUrl: 'https://x/y.git', clonePath: '' }, '/srv/repos/c1.git'), false)
  assert.equal(sameScopeRemote('https://moved.example.com/api/git-http/c1/scopes/s1.git', scope), true)
  assert.equal(sameScopeRemote('https://acb.example.com/api/git-http/c1/scopes/s2.git', scope), false)
})

test('safeScopeDir refuses a symlinked or file ancestor and paths leaving the company folder', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-safe-')))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-out-')))
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(root, '営業部'))
  assert.equal(safeScopeDir(root, '営業部/顧客/秘密'), path.join(root, '営業部', '顧客', '秘密'))
  fs.symlinkSync(outside, path.join(root, '営業部', '顧客'))
  assert.equal(safeScopeDir(root, '営業部/顧客/秘密'), null)
  fs.rmSync(path.join(root, '営業部', '顧客'))
  fs.writeFileSync(path.join(root, '営業部', '顧客'), 'a file')
  assert.equal(safeScopeDir(root, '営業部/顧客/秘密'), null)
  assert.equal(safeScopeDir(root, '../x'), null)
  assert.equal(safeScopeDir(root, '.git/x'), null)
})

test('path checker: every prefix, batches of 50, cached, unknown never blocks', async () => {
  const asked: string[][] = []
  const private_ = '人事/評価'
  const checker = createPathChecker(async (_c, paths) => {
    asked.push(paths)
    return paths.map(p => ({ path: p, usable: !(p === private_ || p.startsWith(`${private_}/`)) }))
  })
  assert.deepEqual(pathPrefixes('人事/評価/x.md'), ['人事', '人事/評価', '人事/評価/x.md'])
  assert.equal(await checker.reservedFolderOf('c', '人事/評価/x.md'), '人事/評価')
  assert.equal(await checker.reservedFolderOf('c', '人事/評価/y.md'), '人事/評価')
  assert.equal(asked.length, 2, 'the cached prefixes are not asked again')
  assert.deepEqual(asked[1], ['人事/評価/y.md'])
  assert.equal(await checker.reservedFolderOf('c', '営業部/x.md'), null)
  const many = Array.from({ length: 120 }, (_, i) => `a/${i}`)
  asked.length = 0
  await checker.usable('c', many)
  assert.deepEqual(asked.map(a => a.length), [50, 50, 20])
  const down = createPathChecker(async () => { throw new Error('offline') })
  assert.equal(await down.reservedFolderOf('c', '人事/評価/x.md'), null)
})

test('path checker: a path that will be a file is asked as one (refused above a private folder), cached apart', async () => {
  const asked: Array<{ paths: string[]; files?: string[] }> = []
  const private_ = '人事/評価'
  const checker = createPathChecker(async (_c, paths, files) => {
    asked.push(files ? { paths, files } : { paths })
    return paths.map(p => ({
      path: p,
      usable: !(p === private_ || p.startsWith(`${private_}/`)) && !(files?.includes(p) && private_.startsWith(`${p}/`)),
    }))
  })
  // A file named like a folder above the private one: refused, named as typed.
  assert.equal(await checker.reservedFolderOf('c', '人事', { file: true }), '人事')
  assert.deepEqual(asked[0], { paths: ['人事'], files: ['人事'] })
  // The same path as a folder (or a prefix of another path) has its own answer.
  assert.equal(await checker.reservedFolderOf('c', '人事'), null)
  assert.equal(await checker.reservedFolderOf('c', '人事/メモ.md', { file: true }), null)
  assert.deepEqual(asked.slice(1), [{ paths: ['人事'] }, { paths: ['人事/メモ.md'], files: ['人事/メモ.md'] }])
  // Cached per kind.
  assert.equal(await checker.reservedFolderOf('c', '人事', { file: true }), '人事')
  assert.equal(asked.length, 3)
  // Folder-only callers (sync) send exactly what they sent before.
  await checker.usable('c', ['営業部'])
  assert.deepEqual(asked[3], { paths: ['営業部'] })
})

test('the managed excludes block keeps the member\'s own lines', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-excl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '# mine\n*.log\n')
  assert.equal(writePrivateExcludes(root, ['人事/評価']), true)
  assert.equal(writePrivateExcludes(root, ['人事/評価']), false)
  assert.deepEqual(readPrivateExcludes(root), ['人事/評価'])
  writePrivateExcludes(root, [])
  assert.equal(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf-8'), '# mine\n*.log\n')
})

test('the private-folder and nested-repository blocks of .git/info/exclude never clobber each other', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-excl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, '.git', 'info', 'exclude')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# mine\n*.log\n')
  assert.equal(writePrivateExcludes(root, ['人事/評価']), true)
  assert.equal(writeNestedRepoExcludes(root, ['tools/外部ツール', 'a[1]']), true)
  // Rewriting one block in place leaves the other (and the member's lines) alone.
  assert.equal(writePrivateExcludes(root, ['人事/評価']), false)
  assert.equal(writeNestedRepoExcludes(root, ['a[1]', 'tools/外部ツール']), false, 'order does not matter')
  assert.equal(writePrivateExcludes(root, ['人事/評価', '経理/給与']), true)
  assert.deepEqual(readNestedRepoExcludes(root).sort(), ['a[1]', 'tools/外部ツール'])
  assert.deepEqual(readPrivateExcludes(root), ['人事/評価', '経理/給与'])
  const text = fs.readFileSync(file, 'utf-8')
  assert.ok(text.includes('/a\\[1\\]/'), 'glob characters are escaped')
  assert.ok(text.includes(`/${'tools/外部ツール'.normalize('NFD')}/`), 'NFD spelling too')
  assert.ok(text.startsWith('# mine\n*.log\n'))
  writeNestedRepoExcludes(root, [])
  assert.deepEqual(readPrivateExcludes(root), ['人事/評価', '経理/給与'])
  writePrivateExcludes(root, [])
  assert.equal(fs.readFileSync(file, 'utf-8'), '# mine\n*.log\n')
})

test('[RESERVED_PATH] section: paths and the reason lines, verbatim', () => {
  const msg = [
    'remote: ========================================',
    'remote: [RESERVED_PATH] 使えない名前のフォルダが含まれています',
    'remote: ========================================',
    'remote: ',
    'remote: 以下のファイルは、使えない名前のフォルダの中にあります:',
    'remote:   - 人事/評価/メモ.md',
    'remote:       （『人事/評価』というフォルダ名は使えません。別の名前にしてください。）',
    'remote:   - hr/SECRET/a.md',
    'remote:       （『hr/SECRET』というフォルダ名は使えません。別の名前にしてください。）',
    'remote: ',
    'remote: プッシュをブロックしました。',
    'remote: ========================================',
  ].join('\n')
  const r = parseReservedPathRejection(msg)
  assert.deepEqual(r.paths, ['人事/評価/メモ.md', 'hr/SECRET/a.md'])
  assert.deepEqual(r.folderOf, { '人事/評価/メモ.md': '人事/評価', 'hr/SECRET/a.md': 'hr/SECRET' })
  assert.equal(r.reasons[0], '（『人事/評価』というフォルダ名は使えません。別の名前にしてください。）')
})

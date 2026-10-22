import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  excludedFolderOf,
  exclusionsInside,
  isNotDownloaded,
  isValidExclusion,
  normalizeExclusions,
  notDownloadedAgentMessage,
  parseSparsePatterns,
  pathKey,
  sparsePatterns,
} from '../shared/sparse-paths'
import { notDownloadedFolderFor, notDownloadedFolders } from '../electron/sync/not-downloaded'
import { evaluateWrite } from '../shared/write-access'

const NFD = (s: string) => s.normalize('NFD')

test('normalizeExclusions: slashes, duplicates (NFC / A–Z case), invalid paths, entries inside another exclusion', () => {
  assert.deepEqual(normalizeExclusions(['営業部', '/コンテンツ/動画/', 'コンテンツ\\動画', NFD('コンテンツ/動画')]), ['営業部', 'コンテンツ/動画'])
  assert.deepEqual(normalizeExclusions(['Media/Raw', 'media/raw', 'MEDIA/RAW/x']), ['Media/Raw'])
  assert.deepEqual(normalizeExclusions(['', '.', '..', 'a/../b', '.git', 'x/.git/y', 'ok\nnot', '.GIT']), [])
  // Re-including inside an excluded folder is not supported: the deeper entry is folded into the parent.
  assert.deepEqual(normalizeExclusions(['コンテンツ/動画/編集', 'コンテンツ/動画', 'コンテンツ/動画編集']), ['コンテンツ/動画', 'コンテンツ/動画編集'])
  assert.equal(isValidExclusion('.claude/skills'), true)
  assert.equal(isValidExclusion('a//b'), true)
})

test('excludedFolderOf / isNotDownloaded: the folder and everything below it, compared in NFC with A–Z folded', () => {
  const ex = ['コンテンツ/動画', 'Media/Raw', '営業部']
  assert.equal(excludedFolderOf(ex, 'コンテンツ/動画'), 'コンテンツ/動画')
  assert.equal(excludedFolderOf(ex, 'コンテンツ/動画/編集/cut.md'), 'コンテンツ/動画')
  assert.equal(excludedFolderOf(ex, NFD('コンテンツ/動画/a.md')), 'コンテンツ/動画')
  assert.equal(excludedFolderOf(ex, 'media/raw/take1.md'), 'Media/Raw')
  assert.equal(excludedFolderOf(ex, 'コンテンツ/動画編集/a.md'), null) // a sibling with a common prefix
  assert.equal(excludedFolderOf(ex, 'コンテンツ'), null)
  assert.equal(excludedFolderOf(ex, 'コンテンツ/top.md'), null)
  assert.equal(excludedFolderOf(ex, ''), null)
  assert.equal(excludedFolderOf(ex, '営業部/../コンテンツ/動画/a'), null) // '..' never resolves here
  assert.equal(isNotDownloaded(ex, '営業部/x.md'), true)
  assert.equal(isNotDownloaded([], '営業部/x.md'), false)
  assert.deepEqual(exclusionsInside(ex, 'コンテンツ'), ['コンテンツ/動画'])
  assert.deepEqual(exclusionsInside(ex, ''), ex)
  assert.deepEqual(exclusionsInside(ex, '営業部'), [])
})

test('path keys fold like the write guard and the push check (A–Z only)', () => {
  assert.equal(pathKey('Sales/A.md'), 'sales/a.md')
  assert.equal(pathKey('Ａ/É'), 'Ａ/É') // non-ASCII case is not folded, as git's ignorecase and the push check
  // Same folding as evaluateWrite's second pass.
  const access = { version: 'v', role: 'member', all: false, scopes: [{ path: '', write: true }, { path: 'Sales', write: false }] }
  assert.equal(evaluateWrite(access, 'sales/a.md').write, false)
  assert.equal(isNotDownloaded(['Sales'], 'sales/a.md'), true)
})

test('sparsePatterns / parseSparsePatterns round-trip, with wildcards escaped and NFD spellings added', () => {
  assert.deepEqual(sparsePatterns([]), ['/*'])
  assert.deepEqual(sparsePatterns(['営業部']), ['/*', '!/営業部/'])
  const lines = sparsePatterns(['デザイン/ビデオ', 'a*b/[x]?', 'back\\slash'])
  assert.deepEqual(lines, ['/*', '!/デザイン/ビデオ/', `!/${NFD('デザイン/ビデオ')}/`, '!/a\\*b/\\[x\\]\\?/', '!/back/slash/'])
  assert.deepEqual(parseSparsePatterns(`${lines.join('\n')}\n`), ['デザイン/ビデオ', 'a*b/[x]?', 'back/slash'])
  assert.equal(parseSparsePatterns('/*\n!/*/\n/営業部/\n'), null) // cone mode
  assert.equal(parseSparsePatterns(''), null)
  assert.deepEqual(parseSparsePatterns('/*\n'), [])
})

test('the agent message names the folder', () => {
  assert.equal(notDownloadedAgentMessage('コンテンツ/動画'), 'このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。')
})

// The patterns are only useful if git reads them the way isNotDownloaded does.
test('git checks out exactly what isNotDownloaded says is downloaded (real git, non-cone patterns)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-sparse-paths-')))
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: path.join(root, 'tpl') }
    fs.mkdirSync(env.GIT_TEMPLATE_DIR)
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n')
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' }).toString()
    git(['init', '-q'])
    const files = [
      'README.md', 'コンテンツ/top.md', 'コンテンツ/動画/a.md', 'コンテンツ/動画/編集/b.md', 'コンテンツ/動画編集/c.md',
      'a*b/[x]?/d.md', 'a*b/other/e.md', 'axb/[x]?/f.md', 'back/slash/g.md', '営業部/h.md', '.claude/skills/s.md',
    ]
    for (const f of files) {
      fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true })
      fs.writeFileSync(path.join(root, f), f)
    }
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'x'])
    const exclusions = ['コンテンツ/動画', 'a*b/[x]?', '営業部']
    git(['sparse-checkout', 'set', '--no-cone', ...sparsePatterns(exclusions)])
    for (const f of files) {
      assert.equal(fs.existsSync(path.join(root, f)), !isNotDownloaded(exclusions, f), f)
    }
    // The main-process reader sees the same, from the files under .git/ alone.
    fs.writeFileSync(path.join(root, '.git', 'acb-sparse-config.json'), JSON.stringify({ excluded: exclusions }))
    assert.deepEqual(notDownloadedFolders(root), exclusions)
    assert.equal(notDownloadedFolderFor(path.join(root, 'コンテンツ', '動画', '新規.md')), 'コンテンツ/動画')
    assert.equal(notDownloadedFolderFor(path.join(root, 'コンテンツ', '新規.md')), null)
    // Not applied (sparse checkout off) → nothing counts as not downloaded.
    git(['sparse-checkout', 'disable'])
    assert.deepEqual(notDownloadedFolders(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GREP_LINE_CHARS, GREP_MAX_PER_FILE, GREP_MAX_TOTAL,
  companySearchScope, gitLogArgs, grepCompany, listCompanyFiles, normalizeSearchFolder, parseGitLog, trimMatchLine,
  type GitCommand,
} from '../electron/git-search'

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-git-search-')))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: path.join(root, 'tpl') }
  fs.mkdirSync(env.GIT_TEMPLATE_DIR)
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n')
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString()
  const write = (base: string, files: Record<string, string>) => {
    for (const [f, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(base, path.dirname(f)), { recursive: true })
      fs.writeFileSync(path.join(base, f), content)
    }
  }
  const cmd: GitCommand = { binary: 'git', configArgs: ['-c', 'core.quotePath=false'], env }
  return { root, env, git, write, cmd, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function initRepo(s: ReturnType<typeof sandbox>, name: string, files: Record<string, string>): string {
  const repo = path.join(s.root, name)
  fs.mkdirSync(repo, { recursive: true })
  s.git(repo, ['init', '-q'])
  s.write(repo, files)
  s.git(repo, ['add', '-A'])
  s.git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

test('normalizeSearchFolder: whole company spellings, trailing slash, refuses ..', () => {
  for (const f of ['', '/', '.', './', undefined]) assert.equal(normalizeSearchFolder(f as string), '')
  assert.equal(normalizeSearchFolder('営業部/'), '営業部')
  assert.equal(normalizeSearchFolder('/a//b/'), 'a/b')
  assert.throws(() => normalizeSearchFolder('../x'))
  assert.throws(() => normalizeSearchFolder('a/../../x'))
})

test('grep: per-file and total caps, truncated, the git process stopped early', async () => {
  const s = sandbox()
  try {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`営業部/doc${i}.md`] = Array.from({ length: 100 }, (_, n) => `の line ${n}`).join('\n')
    files['総務/x.md'] = 'の\n'
    const repo = initRepo(s, 'repo', files)
    // The time at company size is measured in tests/perf/git-search.perf.test.ts.
    const res = await grepCompany(s.cmd, companySearchScope(repo, '営業部'), 'の')
    assert.equal(res.matches.length, GREP_MAX_TOTAL)
    assert.equal(res.truncated, true)
    const perFile = new Map<string, number>()
    for (const m of res.matches) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1)
    assert.ok([...perFile.values()].every(n => n <= GREP_MAX_PER_FILE))
    assert.ok(res.matches.every(m => m.file.startsWith('営業部/')))

    const few = await grepCompany(s.cmd, companySearchScope(repo, '総務/'), 'の')
    assert.deepEqual(few, { matches: [{ file: '総務/x.md', line: 1, text: 'の', column: 0 }], truncated: false, timedOut: false })
  } finally {
    s.cleanup()
  }
})

test('grep: whole company ("" and "/"), untracked files, never ignored / .backups / .workspace / stray nested repos', async () => {
  const s = sandbox()
  try {
    const repo = initRepo(s, 'repo', {
      '.gitignore': 'node_modules/\n',
      'README.md': 'needle at root\n',
      '営業部/a.md': 'a needle\n',
    })
    s.write(repo, {
      '営業部/new-by-ai.md': 'fresh needle\n', // untracked, not ignored
      'node_modules/x.js': 'needle\n', // ignored
      '.backups/2026/営業部/a.md': 'old needle\n', // not ignored here: excluded by pathspec
      '営業部/.workspace/tmp.md': 'scratch needle\n',
    })
    const stray = path.join(repo, '営業部', 'tool')
    fs.mkdirSync(stray)
    s.git(stray, ['init', '-q'])
    s.write(stray, { 'n.md': 'nested needle\n' })

    for (const folder of ['', '/', '.']) {
      const res = await grepCompany(s.cmd, companySearchScope(repo, normalizeSearchFolder(folder)), 'needle')
      assert.deepEqual(res.matches.map(m => m.file).sort(), ['README.md', '営業部/a.md', '営業部/new-by-ai.md'], `folder ${JSON.stringify(folder)}`)
      assert.equal(res.truncated, false)
    }
    const files = await listCompanyFiles(s.cmd, companySearchScope(repo, ''))
    assert.deepEqual(files.files.sort(), ['.gitignore', 'README.md', '営業部/a.md', '営業部/new-by-ai.md'])
  } finally {
    s.cleanup()
  }
})

test('grep: fixed string (regex characters, leading dash), A–Z case-insensitive, Japanese exact', async () => {
  const s = sandbox()
  try {
    const repo = initRepo(s, 'repo', {
      'a.md': 'price: a.*b (x)\naXXb\n--force here\nHello World\nｈｅｌｌｏ wide\n',
    })
    const q = async (query: string) => (await grepCompany(s.cmd, companySearchScope(repo, ''), query)).matches.map(m => m.line)
    assert.deepEqual(await q('a.*b'), [1])
    assert.deepEqual(await q('(x)'), [1])
    assert.deepEqual(await q('--force'), [3])
    assert.deepEqual(await q('hello world'), [4])
    assert.deepEqual(await q('ｈｅｌｌｏ'), [5])
    assert.deepEqual(await q('nothing-here'), [])
  } finally {
    s.cleanup()
  }
})

test('trimMatchLine: long lines cut around the match, column follows', () => {
  const line = 'x'.repeat(5000) + 'の検索語' + 'y'.repeat(5000)
  const buf = Buffer.from(line)
  const byteColumn = 5000 + 1
  const { text, column } = trimMatchLine(buf, byteColumn)
  assert.ok(text.length <= GREP_LINE_CHARS + 2)
  assert.ok(text.startsWith('…') && text.endsWith('…'))
  assert.equal(text.slice(column!, column! + 4), 'の検索語')
  assert.deepEqual(trimMatchLine(Buffer.from('short の line'), 7), { text: 'short の line', column: 6 })
  // A match near the start keeps the start.
  const early = trimMatchLine(Buffer.from('ab' + 'z'.repeat(1000)), 1)
  assert.equal(early.column, 0)
  assert.ok(!early.text.startsWith('…'))
})

test('grep: a giant single line does not have to be held whole', async () => {
  const s = sandbox()
  try {
    const repo = initRepo(s, 'repo', { 'min.js': 'needle' + 'q'.repeat(3_000_000) + '\nneedle 2\n' })
    const res = await grepCompany(s.cmd, companySearchScope(repo, ''), 'needle')
    assert.deepEqual(res.matches.map(m => m.line), [1, 2])
    assert.ok(res.matches.every(m => m.text.length <= GREP_LINE_CHARS + 2))
  } finally {
    s.cleanup()
  }
})

test('grep / listFiles in a partial clone: nothing from not-downloaded folders, no blob downloaded', async () => {
  const s = sandbox()
  try {
    const src = initRepo(s, 'src', {
      '営業部/a.md': 'needle sales\n',
      'コンテンツ/動画/v.md': 'needle video\n',
      'コンテンツ/記事/k.md': 'needle article\n',
    })
    const bare = path.join(s.root, 'server.git')
    s.git(s.root, ['clone', '-q', '--bare', src, bare])
    s.git(bare, ['config', 'uploadpack.allowFilter', 'true'])
    s.git(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true'])
    const member = path.join(s.root, 'member')
    s.git(s.root, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${bare}`, member])
    s.git(member, ['sparse-checkout', 'set', '--no-cone', '/*', '!/コンテンツ/動画/'])
    s.git(member, ['checkout', '-q', 'main'])
    fs.writeFileSync(path.join(member, '.git', 'acb-sparse-config.json'), JSON.stringify({ excluded: ['コンテンツ/動画'] }))
    // A file created inside the not-downloaded folder (sync holds it back).
    s.write(member, { 'コンテンツ/動画/new.md': 'needle local\n' })
    const missing = () => s.git(member, ['rev-list', '--objects', '--all', '--missing=print']).split('\n').filter(l => l.startsWith('?')).length
    const before = missing()
    assert.equal(before, 1)

    const scope = companySearchScope(member, '')
    assert.deepEqual(scope.notDownloaded, ['コンテンツ/動画'])
    const res = await grepCompany(s.cmd, scope, 'needle')
    assert.deepEqual(res.matches.map(m => m.file).sort(), ['コンテンツ/記事/k.md', '営業部/a.md'])
    const inDept = await grepCompany(s.cmd, companySearchScope(member, 'コンテンツ'), 'needle')
    assert.deepEqual(inDept.matches.map(m => m.file), ['コンテンツ/記事/k.md'])
    const list = await listCompanyFiles(s.cmd, companySearchScope(member, 'コンテンツ'))
    assert.deepEqual(list.files, ['コンテンツ/記事/k.md'])
    // Searching inside the not-downloaded folder itself finds nothing.
    assert.deepEqual((await grepCompany(s.cmd, companySearchScope(member, 'コンテンツ/動画'), 'needle')).matches, [])
    assert.equal(missing(), before)
  } finally {
    s.cleanup()
  }
})

test('readable private folders are searched in their own clone, paths company-relative', async () => {
  const s = sandbox()
  try {
    const repo = initRepo(s, 'repo', { '人事/公開.md': 'needle public\n', '総務/x.md': 'needle other\n' })
    const clone = path.join(repo, '人事', '評価')
    fs.mkdirSync(clone, { recursive: true })
    s.git(clone, ['init', '-q'])
    s.write(clone, { '評価表.md': 'needle private\n', 'draft.md': 'needle draft\n' })
    s.git(clone, ['add', '評価表.md'])
    s.git(clone, ['commit', '-q', '-m', 'p'])
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/人事/評価/\n')
    fs.writeFileSync(path.join(repo, '.git', 'acb-private-scopes.json'), JSON.stringify({
      companyId: 'c1', version: 'v1', fetchedAt: '', scopes: [{ scopeId: 's1', path: '人事/評価', cloneUrl: 'https://x/api/git-http/c1/scopes/s1.git', clonePath: '/api/git-http/c1/scopes/s1.git', canWrite: true }],
    }))

    const dept = await grepCompany(s.cmd, companySearchScope(repo, '人事'), 'needle')
    assert.deepEqual(dept.matches.map(m => m.file).sort(), ['人事/公開.md', '人事/評価/draft.md', '人事/評価/評価表.md'])
    const all = await grepCompany(s.cmd, companySearchScope(repo, ''), 'needle')
    assert.equal(all.matches.length, 4)
    const inside = await grepCompany(s.cmd, companySearchScope(repo, '人事/評価'), 'private')
    assert.deepEqual(inside.matches.map(m => m.file), ['人事/評価/評価表.md'])
    const other = await grepCompany(s.cmd, companySearchScope(repo, '総務'), 'needle')
    assert.deepEqual(other.matches.map(m => m.file), ['総務/x.md'])
    const list = await listCompanyFiles(s.cmd, companySearchScope(repo, '人事'))
    assert.deepEqual(list.files.sort(), ['人事/公開.md', '人事/評価/draft.md', '人事/評価/評価表.md'])
  } finally {
    s.cleanup()
  }
})

test('grep: an aborted search stops', async () => {
  const s = sandbox()
  try {
    const files: Record<string, string> = {}
    for (let i = 0; i < 10; i++) files[`d/f${i}.md`] = 'needle\n'
    const repo = initRepo(s, 'repo', files)
    const controller = new AbortController()
    controller.abort()
    const res = await grepCompany(s.cmd, companySearchScope(repo, ''), 'needle', controller.signal)
    assert.ok(res.matches.length < 10)
  } finally {
    s.cleanup()
  }
})

// The git:log handler's result shape (folder filter, message with body, field
// names) is pinned in ipc-git.test.ts; this checks the parser's values, a
// Japanese folder with a trailing slash, the whole company and the count limit.
test('git log: folder history without --follow; hash, short hash, author, date, message; whole company with a limit', async () => {
  const s = sandbox()
  try {
    const repo = initRepo(s, 'repo', { 'コンテンツ/a.md': '1\n', 'other/b.md': '1\n' })
    s.write(repo, { 'コンテンツ/a.md': '2\n' })
    s.git(repo, ['commit', '-q', '-am', 'second subject\n\nbody line 1\nbody line 2'])
    s.write(repo, { 'other/b.md': '2\n' })
    s.git(repo, ['commit', '-q', '-am', 'other only'])

    const args = gitLogArgs('コンテンツ/', 50)
    assert.ok(!args.includes('--follow'))
    const commits = parseGitLog(s.git(repo, args))
    assert.deepEqual(commits.map(c => c.hash), [s.git(repo, ['rev-parse', 'HEAD~1']).trim(), s.git(repo, ['rev-parse', 'HEAD~2']).trim()])
    assert.deepEqual(commits.map(c => c.message), ['second subject\nbody line 1\nbody line 2', 'init'])
    assert.equal(commits[0].hashShort, commits[0].hash.slice(0, 7))
    assert.equal(commits[0].author, 't')
    assert.ok(!Number.isNaN(new Date(commits[0].date).getTime()))

    const whole = parseGitLog(s.git(repo, gitLogArgs('', 2)))
    assert.deepEqual(whole.map(c => c.message), ['other only', 'second subject\nbody line 1\nbody line 2'])
  } finally {
    s.cleanup()
  }
})

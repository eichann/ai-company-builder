// Performance baselines for #153 at company size (~6.5k files, the company
// the limits were measured on): the search stays capped on a very common
// token, and a folder's history stays fast. The caps, the no---follow
// arguments and their behaviour are covered by tests/git-search.test.ts on
// small repositories; these add the scale and the numbers.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { GREP_MAX_TOTAL, companySearchScope, gitLogArgs, grepCompany, parseGitLog, type GitCommand } from '../../electron/git-search'
import { budget, generateCompanyTree, scratch, timeMs } from './perf'

const box = scratch('git-search')
after(() => box.cleanup())
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(box.dir, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TEMPLATE_DIR: path.join(box.dir, 'tpl'),
}
fs.mkdirSync(env.GIT_TEMPLATE_DIR)
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n')
const repo = path.join(box.dir, 'company')
fs.mkdirSync(repo)
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString()
const cmd: GitCommand = { binary: 'git', configArgs: ['-c', 'core.quotePath=false'], env }

// 6,500 files, each 20 lines full of 「の」: ~130k matching lines, ~20 MB.
const LINE = '会議の議事録の要点の整理のための下書きの文章の例です。'.repeat(3)
git(['init', '-q'])
const files = generateCompanyTree(repo, { departments: 13, subfolders: 10, files: 50, content: (d, s, f) => `${d}-${s}-${f}\n` + `${LINE}\n`.repeat(20) })
git(['add', '-A'])
git(['commit', '-q', '-m', 'init'])
// A history: 120 commits, every third one inside 部署00.
for (let i = 0; i < 120; i++) {
  fs.writeFileSync(path.join(repo, i % 3 === 0 ? '部署00' : '部署01', `log${i % 10}.md`), `change ${i}\n`)
  git(['add', '-A'])
  git(['commit', '-q', '-m', `change ${i}`])
}

test('perf #153: searching 「の」 over ~6.5k files returns at most 500 small matches, fast', async () => {
  assert.equal(files, 6_500)
  const { ms, value } = await timeMs(() => grepCompany(cmd, companySearchScope(repo, ''), 'の'))
  assert.equal(value.truncated, true)
  assert.equal(value.timedOut, false)
  budget('grep.matches', value.matches.length, 'matches', GREP_MAX_TOTAL)
  // Uncapped, git prints ~20 MB here; 500 lines cut to 300 characters are < 0.5 MB.
  budget('grep.payload', Buffer.byteLength(JSON.stringify(value)), 'bytes', 1_000_000)
  budget('grep.time', ms, 'ms', 5_000)
})

test('perf #153: a folder\'s history (git log, no --follow) is fast', async () => {
  const { ms, value } = await timeMs(() => parseGitLog(git([...cmd.configArgs, ...gitLogArgs('部署00', 50)])))
  assert.equal(value.length, 41) // 40 changes + the initial commit
  budget('gitLog.folder.time', ms, 'ms', 2_000)
})

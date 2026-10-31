// Choosing a company folder in CompanySelector (both 「既存のフォルダを開く」
// and 「新しく作成」): which folders get the department picker + partial first
// setup, which open as before, which are refused — and opening the remembered
// company directly after login. See .claude/rules/download-choices.md.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  decideCompanyFolder,
  inspectLocalFolder,
  sameCompanyRemote,
  NOT_EMPTY_MESSAGE,
  OTHER_REMOTE_MESSAGE,
  UNRELATED_REPO_MESSAGE,
  type CompanyFolderFacts,
} from '../electron/sync/company-folder'
import { planFolderSetup, INSPECT_FAILED_MESSAGE } from '../src/features/company/folderPlan'
import { checkRememberedCompany } from '../src/features/company/restore-company'

const COMPANY = 'https://acb.example.com/api/git-http/c0ffee-123.git'

function facts(overrides: Partial<CompanyFolderFacts>): CompanyFolderFacts {
  return { hasGitDir: false, originUrl: null, hasLocalCommits: false, hasUserFiles: false, remoteHasCommits: true, ...overrides }
}

test('empty folder (or one with only OS files) and a company with content: department picker + partial first setup', () => {
  assert.deepEqual(decideCompanyFolder(facts({}), COMPANY), { action: 'firstSetup' })
})

test('existing clone of this company opens as before (no conversion), whatever the server has', () => {
  const clone = facts({ hasGitDir: true, originUrl: COMPANY, hasLocalCommits: true, hasUserFiles: true })
  assert.deepEqual(decideCompanyFolder(clone, COMPANY), { action: 'existingClone' })
  assert.deepEqual(decideCompanyFolder({ ...clone, remoteHasCommits: false }, COMPANY), { action: 'existingClone' })
})

test('clone of a different remote is refused, with or without commits', () => {
  for (const originUrl of [
    'https://acb.example.com/api/git-http/other-company.git',
    'https://github.com/someone/project.git',
    'git@github.com:someone/project.git',
  ]) {
    for (const hasLocalCommits of [true, false]) {
      const d = decideCompanyFolder(facts({ hasGitDir: true, originUrl, hasLocalCommits, hasUserFiles: true }), COMPANY)
      assert.deepEqual(d, { action: 'refuse', reason: 'otherRemote', message: OTHER_REMOTE_MESSAGE }, originUrl)
    }
  }
})

test('non-empty folder without a clone is refused while the company has content (nothing is touched)', () => {
  assert.deepEqual(decideCompanyFolder(facts({ hasUserFiles: true }), COMPANY),
    { action: 'refuse', reason: 'notEmpty', message: NOT_EMPTY_MESSAGE })
  // A repository with no remote and no commits is the same as no repository.
  assert.equal(decideCompanyFolder(facts({ hasGitDir: true, hasUserFiles: true }), COMPANY).action, 'refuse')
  assert.deepEqual(decideCompanyFolder(facts({ hasGitDir: true }), COMPANY), { action: 'firstSetup' })
})

test('a repository with its own history and no remote is refused when the company has content', () => {
  assert.deepEqual(decideCompanyFolder(facts({ hasGitDir: true, hasLocalCommits: true, hasUserFiles: true }), COMPANY),
    { action: 'refuse', reason: 'unrelatedRepo', message: UNRELATED_REPO_MESSAGE })
})

test('company without content yet: the folder becomes its first commit (owner), as before', () => {
  for (const f of [
    facts({ remoteHasCommits: false }),
    facts({ remoteHasCommits: false, hasUserFiles: true }),
    facts({ remoteHasCommits: false, hasGitDir: true, hasLocalCommits: true, hasUserFiles: true }),
  ]) {
    assert.deepEqual(decideCompanyFolder(f, COMPANY), { action: 'uploadExisting' })
  }
})

test('interrupted first setup (this company\'s origin, nothing checked out) resumes with the picker', () => {
  assert.deepEqual(decideCompanyFolder(facts({ hasGitDir: true, originUrl: COMPANY }), COMPANY), { action: 'firstSetup' })
})

test('same company remote: compared by path, so a moved server address still matches; ids must match exactly', () => {
  assert.ok(sameCompanyRemote('https://old.example.com/api/git-http/c0ffee-123.git', COMPANY))
  assert.ok(sameCompanyRemote('http://localhost:3001/api/git-http/c0ffee-123', COMPANY))
  assert.ok(sameCompanyRemote('https://acb.example.com/api/git-http/c0ffee-123.git/', COMPANY))
  assert.ok(!sameCompanyRemote('https://acb.example.com/api/git-http/c0ffee-1234.git', COMPANY))
  assert.ok(!sameCompanyRemote('https://acb.example.com/api/git-http/c0ffee.git', COMPANY))
  assert.ok(!sameCompanyRemote('git@github.com:a/b.git', COMPANY))
  assert.ok(!sameCompanyRemote('', COMPANY))
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}

test('inspecting real folders: missing, empty, OS files only, user files, clone, repo inside another repo', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-company-folder-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const run = (dir: string) => (args: string[]) => Promise.resolve().then(() => git(dir, ...args))

  assert.deepEqual(await inspectLocalFolder(path.join(root, 'missing'), run(root)),
    { exists: false, hasGitDir: false, originUrl: null, hasLocalCommits: false, hasUserFiles: false })

  const empty = path.join(root, 'empty')
  fs.mkdirSync(empty)
  fs.writeFileSync(path.join(empty, '.DS_Store'), '')
  fs.writeFileSync(path.join(empty, 'desktop.ini'), '')
  assert.deepEqual(await inspectLocalFolder(empty, run(empty)),
    { exists: true, hasGitDir: false, originUrl: null, hasLocalCommits: false, hasUserFiles: false })

  const files = path.join(root, 'files')
  fs.mkdirSync(files)
  fs.writeFileSync(path.join(files, 'メモ.txt'), 'mine')
  assert.equal((await inspectLocalFolder(files, run(files))).hasUserFiles, true)

  const clone = path.join(root, 'clone')
  fs.mkdirSync(clone)
  git(clone, 'init', '-q')
  assert.deepEqual(await inspectLocalFolder(clone, run(clone)),
    { exists: true, hasGitDir: true, originUrl: null, hasLocalCommits: false, hasUserFiles: false })
  git(clone, 'remote', 'add', 'origin', COMPANY)
  fs.writeFileSync(path.join(clone, 'a.md'), 'a')
  git(clone, 'add', '.')
  git(clone, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a')
  assert.deepEqual(await inspectLocalFolder(clone, run(clone)),
    { exists: true, hasGitDir: true, originUrl: COMPANY, hasLocalCommits: true, hasUserFiles: true })

  // An empty folder inside another clone is a folder of its own, not that clone.
  const nested = path.join(clone, 'sub')
  fs.mkdirSync(nested)
  assert.deepEqual(await inspectLocalFolder(nested, run(nested)),
    { exists: true, hasGitDir: false, originUrl: null, hasLocalCommits: false, hasUserFiles: false })
})

test('a folder that is refused, or could not be checked, is never set up or opened: the member sees why', () => {
  assert.deepEqual(planFolderSetup({ success: true, decision: { action: 'refuse', reason: 'otherRemote', message: OTHER_REMOTE_MESSAGE } }),
    { kind: 'error', message: OTHER_REMOTE_MESSAGE })
  assert.deepEqual(planFolderSetup({ success: false, error: 'offline' }), { kind: 'error', message: 'offline' })
  assert.deepEqual(planFolderSetup(null), { kind: 'error', message: INSPECT_FAILED_MESSAGE })
})

// main answers fs:exists only for registered folders (validatePath /
// allowedRoots), and a fresh launch has none registered.
function fakeMain(onDisk: string[], companyIds: string[] | null | Error) {
  const allowed = new Set<string>()
  return {
    allowed,
    deps: {
      accessibleCompanyIds: async () => { if (companyIds instanceof Error) throw companyIds; return companyIds },
      registerAllowedRoot: async (folder: string) => { allowed.add(folder) },
      exists: async (target: string) => [...allowed].some(r => target === r || target.startsWith(r + '/')) && onDisk.includes(target),
    },
  }
}

test('login: the remembered company opens directly (was: forgotten on every launch because the folder was not registered yet)', async () => {
  const main = fakeMain(['/Users/m/会社'], ['c1'])
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/Users/m/会社' }, main.deps), 'open')
  assert.ok(main.allowed.has('/Users/m/会社'))
})

test('login: forget when access was revoked or the folder is gone; keep when the server cannot be asked', async () => {
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/x' }, fakeMain(['/x'], ['c2']).deps), 'forget')
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/x' }, fakeMain([], ['c1']).deps), 'forget')
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/x' }, fakeMain(['/x'], null).deps), 'keep')
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/x' }, fakeMain(['/x'], new Error('ipc')).deps), 'keep')
})

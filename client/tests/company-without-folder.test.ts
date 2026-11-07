// A company without the shared company folder (client/shared/company-folder.ts) in the chat
// write guard and when the app restores the remembered company. Git companies keep every check
// (the same guard data refuses the same writes without `folderKind`). The open path and every
// git entry point: ipc-company-without-folder.test.ts; the selector: tests/ui/company-selector.spec.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { answeredCompanyFolderKind } from '../shared/company-folder'
import { checkRememberedCompany } from '../src/features/company/restore-company'
import type { WriteAccess } from '../shared/write-access'
import { createChatServerConfig, type ChatServerConfigDeps } from '../electron/features/chat/server-config'
import { createWorkingFolders } from '../electron/services/working-folders'

const ROOT = '/Users/me/作業'
const ACCESS: WriteAccess = { version: 'v1', role: 'member', all: false, scopes: [{ path: '', write: true }, { path: '営業部', write: false }] }

/** The same member and data for both kinds: a member (not owner/admin) without skill editing. */
const guard = (folderKind?: 'none'): WriteGuard => ({
  root: ROOT,
  ...(folderKind ? { folderKind } : {}),
  getAccess: () => ACCESS,
  getNotDownloaded: () => ['開発部'],
  getInstructionAuthority: () => ({ role: 'member', managedFolders: [], skillEditing: { everywhere: false, folders: [] } }),
  getPrivateFolderView: () => ({ reservedFolderOf: async () => null, readOnlyFolderOf: rel => (rel.startsWith('人事/評価/') ? '人事/評価' : null) }),
})

const write = (g: WriteGuard, rel: string) => decideToolWrite(g, 'Write', { file_path: `${ROOT}/${rel}`, content: 'x' }, ROOT)

test('the server\'s kind: only an exact `none` is a company without the shared folder (an older server\'s answer is a git company)', () => {
  assert.equal(answeredCompanyFolderKind('none'), 'none')
  for (const value of [undefined, null, 'git', 'None', 'NONE', '', 0, {}]) assert.equal(answeredCompanyFolderKind(value), 'git', String(value))
})

test('without the shared folder the guard drops what only mirrors the push checker; a git company keeps every one of those refusals', () => {
  const mirrors: Array<[string, string]> = [
    ['営業部/見積.md', 'read-only-folder'],
    ['開発部/設計.md', 'not-downloaded'],
    ['人事/評価/a.md', 'read-only-folder'],
    ['営業部/CLAUDE.md', 'instruction-file'],
    ['.claude/skills/mine/SKILL.md', 'skill-file'],
    ['.acb/types/deal.md', 'type-definition'],
  ]
  for (const [rel, code] of mirrors) {
    const git = write(guard(), rel)
    assert.equal(git.deny && git.code, code, `git: ${rel}`)
    assert.equal(write(guard('none'), rel).deny, false, `none: ${rel}`)
  }
  const clone = { command: 'git clone https://example.com/x.git 営業部/x' }
  assert.equal(decideToolWrite(guard(), 'Bash', clone, ROOT).deny, true)
  assert.equal(decideToolWrite(guard('none'), 'Bash', clone, ROOT).deny, false)
})

test('without the shared folder the app\'s own rules stay: agent config, a step\'s deliverable folder, record frontmatter', () => {
  for (const rel of ['.claude/settings.json', '.mcp.json', '.claude/hooks/run.sh']) {
    const d = write(guard('none'), rel)
    assert.equal(d.deny && d.code, 'agent-config', rel)
    const viaShell = decideToolWrite(guard('none'), 'Bash', { command: `echo x > ${rel}` }, ROOT)
    assert.equal(viaShell.deny && viaShell.code, 'agent-config', `bash ${rel}`)
  }
  // (Judged where it lands on disk too, so the folder is a real one here.)
  const disk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-none-')))
  const step: WriteGuard = { ...guard('none'), root: disk, writeArea: { folder: '提案書' } }
  const outside = decideToolWrite(step, 'Write', { file_path: `${disk}/営業部/メモ.md`, content: 'x' }, disk)
  assert.equal(outside.deny && outside.code, 'deliverable-folder')
  assert.equal(decideToolWrite(step, 'Write', { file_path: `${disk}/営業部/.personal/提案書/a.md`, content: 'x' }, disk).deny, false)
  fs.rmSync(disk, { recursive: true, force: true })
  const record = decideToolWrite(guard('none'), 'Write', { file_path: `${ROOT}/営業部/t.md`, content: '---\nid: task-0a1b2c3d4e5f\ntype: task\nstate: done\n---\n' }, ROOT)
  assert.equal(record.deny && record.code, 'record-file')
})

test('restoring a remembered company without the shared folder registers it as a working folder again, or does not open it', async () => {
  const opened: string[] = []
  const deps = (kind: 'git' | 'none', works = true) => ({
    accessibleCompanyIds: async () => ['c1'],
    registerAllowedRoot: async () => {},
    exists: async () => true,
    withoutSharedFolder: () => kind === 'none',
    openWorkingFolder: async (folder: string) => { opened.push(folder); return works },
  })
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/w' }, deps('none')), 'open')
  assert.deepEqual(opened, ['/w'])
  // main could not take it as a working folder: not opened (git could otherwise run there), kept for the next login.
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/w' }, deps('none', false)), 'keep')
  // A git company is restored as before, never prepared as a working folder.
  opened.length = 0
  assert.equal(await checkRememberedCompany({ id: 'c1', rootPath: '/g' }, deps('git')), 'open')
  assert.deepEqual(opened, [])
})

test('the chat in a working folder gets the guard without the push checker\'s mirrors and no company file tools; a git company\'s folder gets both as before', async () => {
  const workingFolders = createWorkingFolders()
  workingFolders.add('/Users/me/作業')
  const authority = { role: 'member', managedFolders: [] }
  const deps = {
    workingFolders,
    writeAccess: { refresh: async () => ACCESS, get: () => ACCESS },
    privateFolders: { refreshReadable: async () => {}, refreshAuthority: async () => {}, authority: () => authority, readable: () => [], guardView: () => undefined },
    companyFiles: {},
    claudeCli: {},
    config: { load: () => ({}) },
    shellEnv: { env: () => ({}) },
  } as unknown as ChatServerConfigDeps
  const config = createChatServerConfig(deps)

  const none = await config.getWriteGuard!('c1', '/Users/me/作業')
  const git = await config.getWriteGuard!('c1', '/Users/me/会社')
  const at = (root: string, rel: string) => ({ file_path: `${root}/${rel}`, content: 'x' })
  assert.equal(decideToolWrite(none, 'Write', at('/Users/me/作業', '営業部/a.md')).deny, false)
  assert.equal(decideToolWrite(git, 'Write', at('/Users/me/会社', '営業部/a.md')).deny, true)
  // AI settings stay protected in the working folder too.
  assert.equal(decideToolWrite(none, 'Write', at('/Users/me/作業', '.claude/settings.json')).deny, true)

  const signal = new AbortController().signal
  assert.equal(config.createCompanyFiles!('c1', '/Users/me/作業', signal), undefined)
  assert.ok(config.createCompanyFiles!('c1', '/Users/me/会社', signal)?.tools)
})

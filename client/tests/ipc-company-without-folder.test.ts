// A company without the shared company folder (`folderKind: 'none'`, client/shared/company-folder.ts)
// through the real main.ts: its working folder is a plain folder on this PC, and no git ever
// runs there — every sync / history / download-choice / skill-sharing entry point is refused or
// skipped (never an error loop, never a `.git` made), while 探す and Cmd+P still read the disk.
// A git company's folder is never taken for one.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commitRepo, git, loadMain, writeFiles, type MainHarness } from './ipc-harness/main-harness.ts'
import { NO_GIT_IN_WORKING_FOLDER } from '../electron/services/working-folders.ts'
import { SYNCED_FOLDER_MESSAGE, WORKING_FOLDER_TAKEN_MESSAGE } from '../electron/features/company-setup/ipc.ts'
import { STEP_SKILL_NOT_HERE } from '../electron/features/plugin-steps/ipc.ts'

let h: MainHarness
before(async () => { h = await loadMain() })
after(() => h.shutdown())

const company = (id: string, folderKind: unknown) => {
  h.server.on('GET', `/api/companies/${id}`, { json: { success: true, data: { id, name: id, ...(folderKind === undefined ? {} : { folderKind }) } } })
  h.server.on('GET', `/api/companies/${id}/departments`, {
    json: { success: true, data: [{ id: 'd1', folder: '営業部' }, { id: 'd2', folder: '../外' }, { id: 'd3', folder: 'a/b' }, { id: 'd4', folder: '.hidden' }] },
  })
}

test('a company without the shared folder opens in a plain folder with its department folders, and no git ever runs there', async () => {
  company('co-none', 'none')
  // The working folder sits inside some other repository on disk: git run there would act on that one.
  const parent = h.companyDir('parent-none')
  commitRepo(h.base, parent, { 'README.md': 'someone else\'s project\n' })
  await h.invoke('fs:registerAllowedRoot', parent)
  const folder = path.join(parent, 'ノーフォルダ商事')

  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-none'), { success: true })
  assert.ok(fs.statSync(path.join(folder, '営業部')).isDirectory())
  // Department folders are names only: never a path out of the folder, never a nested or hidden one.
  assert.deepEqual(fs.readdirSync(folder).sort(), ['営業部'])
  assert.equal(fs.existsSync(path.join(parent, '外')), false)

  writeFiles(folder, { '営業部/見積.md': '見積の下書き Alpha\n', '.backups/old.md': 'Alpha は控え\n', '.claude/skills/mine/SKILL.md': '# mine\n' })

  // Sync: refused before anything runs; automatic sync is a skip, never an error.
  assert.deepEqual(await h.invoke('git:sync', folder, 'co-none', 'msg'), { success: false, error: NO_GIT_IN_WORKING_FOLDER, errorType: 'unknown' })
  assert.deepEqual(await h.invoke('git:autoSync', folder, 'co-none', 'send', { unsavedEdits: false, needsMember: false, offline: false }), { status: 'skipped', reason: 'no-company-folder' })
  // History, preview, download choices, setup as a clone, skill sharing: refused by the app's git.
  for (const [channel, args] of [
    ['git:preview', [folder]],
    ['git:log', [folder, '', 5]],
    ['git:sparseSetExclusions', [folder, ['営業部']]],
    ['git:setupCompanyRemote', [folder, 'co-none', []]],
  ] as const) {
    const answer = await h.invoke<{ success: boolean; error?: string }>(channel, ...args)
    assert.equal(answer.success, false, channel)
  }
  const inspected = await h.invoke<{ decision?: { action: string; message?: string } }>('git:inspectCompanyFolder', folder, 'co-none')
  assert.deepEqual(inspected.decision, { action: 'refuse', reason: 'notEmpty', message: WORKING_FOLDER_TAKEN_MESSAGE })
  // A new skill is the member's own already; publishing has nowhere to go.
  assert.deepEqual(await h.invoke('skills:makePrivate', folder, '営業部/.claude/skills/new/'), { success: true })
  assert.equal((await h.invoke<{ success: boolean }>('skills:publish', folder, '.claude/skills/mine/')).success, false)

  // 探す and Cmd+P read the disk (never .backups/).
  const listed = await h.invoke<{ success: boolean; files: string[] }>('git:listFiles', folder, '')
  assert.deepEqual(listed.files.sort(), ['.claude/skills/mine/SKILL.md', '営業部/見積.md'])
  const found = await h.invoke<{ success: boolean; results: Array<{ file: string; line: number }> }>('git:grep', folder, 'alpha', '')
  assert.deepEqual(found.results.map(r => [r.file, r.line]), [['営業部/見積.md', 1]])

  // Nothing above made the folder (or anything in it) a repository, nor touched the one around it.
  assert.equal(git(h.base, parent, ['status', '--porcelain', '--', 'README.md']), '')
  assert.equal(git(h.base, parent, ['rev-list', '--count', 'HEAD']).trim(), '1')
  assert.equal(fs.existsSync(path.join(folder, '.git')), false)
  assert.equal(fs.existsSync(path.join(folder, '営業部', '.git')), false)
})

test('only an exact `none` from the server opens a working folder: a git company or an older server\'s answer is refused, nothing made', async () => {
  const parent = h.companyDir('parent-kinds')
  await h.invoke('fs:registerAllowedRoot', parent)
  for (const [id, kind] of [['co-git', 'git'], ['co-old', undefined], ['co-odd', 'None']] as const) {
    company(id, kind)
    const folder = path.join(parent, id)
    const answer = await h.invoke<{ success: boolean }>('companySetup:openWorkingFolder', folder, id)
    assert.equal(answer.success, false, id)
    assert.equal(fs.existsSync(folder), false, id)
  }
})

test('a synced company folder (it holds .git) is never made a working folder, and its git keeps running', async () => {
  company('co-none2', 'none')
  const folder = h.companyDir('synced')
  commitRepo(h.base, folder, { '営業部/a.md': 'a\n' })
  await h.invoke('fs:registerAllowedRoot', folder)
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-none2'), { success: false, error: SYNCED_FOLDER_MESSAGE })
  const log = await h.invoke<{ success: boolean; commits: unknown[] }>('git:log', folder, '', 5)
  assert.equal(log.success, true)
  assert.equal(log.commits.length, 1)
})

test('a plugin step that needs a company Skill says plainly that such a company cannot use one yet (not "place it and sync")', async () => {
  const user = { id: 'u-me', email: 'me@example.com', name: 'Me' }
  h.server.on('POST', '/api/auth/sign-in/email', { json: { user }, headers: { 'Set-Cookie': 'better-auth.session_token=tok.me; Path=/; HttpOnly' } })
  h.server.on('GET', '/api/me', { json: { success: true, data: user } })
  await h.invoke('auth:signIn', 'me@example.com', 'pw')
  company('co-none4', 'none')
  const parent = h.companyDir('parent-step')
  await h.invoke('fs:registerAllowedRoot', parent)
  const folder = path.join(parent, 'step')
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-none4'), { success: true })
  h.server.on('POST', /\/me\/plugin-steps\/records\/.*\/start$/, { status: 409, json: { success: false, error: '会社のスキルが見つかりません。.claude/skills/ に置いて同期してから、もう一度ためしてください', code: 'STEP_SKILL_MISSING' } })
  assert.deepEqual(await h.invoke('pluginSteps:start', 'co-none4', 'deal-0a1b2c3d4e5f', 'sample-sales', 'prepare', folder), { ok: false, error: STEP_SKILL_NOT_HERE })
  // A git company keeps the server's own words.
  const synced = h.companyDir('synced-step')
  commitRepo(h.base, synced, { 'a.md': 'a\n' })
  await h.invoke('fs:registerAllowedRoot', synced)
  const gitAnswer = await h.invoke<{ ok: boolean; error?: string }>('pluginSteps:start', 'co-git', 'deal-0a1b2c3d4e5f', 'sample-sales', 'prepare', synced)
  assert.match(gitAnswer.error ?? '', /置いて同期して/)
  await h.invoke('auth:signOut')
})

test('探す and Cmd+P work in a working folder that is no repository at all (they read the disk, not git)', async () => {
  company('co-none3', 'none')
  const parent = h.companyDir('parent-plain')
  await h.invoke('fs:registerAllowedRoot', parent)
  const folder = path.join(parent, 'plain')
  assert.deepEqual(await h.invoke('companySetup:openWorkingFolder', folder, 'co-none3'), { success: true })
  writeFiles(folder, { '営業部/メモ.md': '一行目\n二行目 ベータ\n' })
  assert.deepEqual(await h.invoke('git:listFiles', folder, '営業部'), { success: true, files: ['営業部/メモ.md'], truncated: false })
  const found = await h.invoke<{ success: boolean; results: Array<{ file: string; line: number; text: string }> }>('git:grep', folder, 'ベータ', '')
  assert.deepEqual(found.results.map(r => [r.file, r.line, r.text]), [['営業部/メモ.md', 2, '二行目 ベータ']])
})

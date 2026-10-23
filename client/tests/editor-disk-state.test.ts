import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDiskDecision,
  backupStamp,
  canAutosave,
  decideOnDiskEvent,
  decideSave,
  editorOverwriteBackupPlan,
  type EditorFileState,
} from '../shared/editor-disk-state'

const clean = (text: string): EditorFileState => ({ content: text, originalContent: text })
const dirty = (base: string, mine: string): EditorFileState => ({ content: mine, originalContent: base })

test('clean tab follows the disk (AI edit, sync pull)', () => {
  const f = clean('v1')
  assert.deepEqual(decideOnDiskEvent(f, 'v1'), { action: 'none' })
  const d = decideOnDiskEvent(f, 'v2')
  assert.deepEqual(d, { action: 'reload', content: 'v2' })
  const next = applyDiskDecision(f, d)
  assert.equal(next.content, 'v2')
  assert.equal(next.originalContent, 'v2')
  assert.equal(canAutosave(next), false)
})

test('clean tab deleted → marked missing; reappearing reloads it', () => {
  const f = applyDiskDecision(clean('v1'), decideOnDiskEvent(clean('v1'), null))
  assert.equal(f.missing, true)
  assert.equal(f.external, undefined)
  assert.deepEqual(decideOnDiskEvent(f, null), { action: 'none' })
  const back = applyDiskDecision(f, decideOnDiskEvent(f, 'v1'))
  assert.equal(back.missing, false)
})

test('dirty + disk changed → banner (external), edits kept, autosave paused', () => {
  const f = dirty('v1', 'mine')
  const d = decideOnDiskEvent(f, 'ai')
  assert.deepEqual(d, { action: 'conflict', external: { kind: 'changed', diskContent: 'ai' } })
  const next = applyDiskDecision(f, d)
  assert.equal(next.content, 'mine')
  assert.equal(next.originalContent, 'v1')
  assert.equal(canAutosave(next), false)
  // the same disk version again: nothing new
  assert.deepEqual(decideOnDiskEvent(next, 'ai'), { action: 'none' })
  // another change: banner follows the newest disk version
  assert.deepEqual(decideOnDiskEvent(next, 'ai2'), { action: 'conflict', external: { kind: 'changed', diskContent: 'ai2' } })
})

test('dirty + our own save event (disk = base or = my edits) is not a conflict', () => {
  assert.deepEqual(decideOnDiskEvent(dirty('v1', 'mine'), 'v1'), { action: 'none' })
  const adopt = decideOnDiskEvent(dirty('v1', 'mine'), 'mine')
  assert.deepEqual(adopt, { action: 'adopt', content: 'mine' })
  const saved = applyDiskDecision(dirty('v1', 'mine'), adopt)
  assert.equal(saved.originalContent, 'mine')
  assert.equal(saved.external, undefined)
})

test('dirty + the disk change reverted → banner cleared, autosave resumes', () => {
  const conflicted = applyDiskDecision(dirty('v1', 'mine'), { action: 'conflict', external: { kind: 'changed', diskContent: 'ai' } })
  const d = decideOnDiskEvent(conflicted, 'v1')
  assert.deepEqual(d, { action: 'clear' })
  assert.equal(canAutosave(applyDiskDecision(conflicted, d)), true)
})

test('dirty + deleted → edits kept, 「保存すると作り直します」, save recreates', () => {
  const f = dirty('v1', 'mine')
  const d = decideOnDiskEvent(f, null)
  assert.deepEqual(d, { action: 'conflict', external: { kind: 'deleted' } })
  const next = applyDiskDecision(f, d)
  assert.equal(next.content, 'mine')
  assert.equal(next.missing, true)
  assert.equal(canAutosave(next), false)
  assert.deepEqual(decideSave(next, null), { action: 'write', recreate: true })
})

test('save: unchanged disk writes; changed disk asks; disk = my edits is already saved', () => {
  assert.deepEqual(decideSave(dirty('v1', 'mine'), 'v1'), { action: 'write', recreate: false })
  assert.deepEqual(decideSave(dirty('v1', 'mine'), 'ai'), { action: 'ask', diskContent: 'ai' })
  assert.deepEqual(decideSave(dirty('v1', 'mine'), 'mine'), { action: 'already-saved' })
  // The AI wrote before the watcher event arrived: the save itself catches it.
  assert.equal(decideSave({ content: 'mine', originalContent: 'v1' }, 'ai-not-yet-seen').action, 'ask')
})

test('backup location: .backups/<ts>_editor_overwrite/<rel>', () => {
  const now = new Date('2026-10-23T01:02:03.456Z')
  assert.equal(backupStamp(now), '2026-10-23T01-02-03-456')
  const plan = editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/営業部/提案書.md', privateFolders: [], insideNestedRepo: false, now })
  assert.deepEqual(plan, { base: '.backups', folder: '2026-10-23T01-02-03-456_editor_overwrite', rel: '営業部/提案書.md', privateFolder: false })
})

test('backup location: never in a private folder working tree → .git/acb-private-backups', () => {
  const now = new Date(0)
  const byCache = editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/人事/評価/表.md', privateFolders: ['人事/評価'], insideNestedRepo: false, now })
  assert.ok(!('skip' in byCache))
  assert.equal(byCache.base, '.git/acb-private-backups')
  assert.equal(byCache.privateFolder, true)
  // case / NFD spelling of the folder still counts
  const nfd = editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/人事/評価/表.md', privateFolders: ['人事/評価'.normalize('NFD')], insideNestedRepo: false, now })
  assert.ok(!('skip' in nfd) && nfd.privateFolder)
  // a nested repository between the file and the root (cache missing)
  const nested = editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/x/y.md', privateFolders: [], insideNestedRepo: true, now })
  assert.ok(!('skip' in nested) && nested.base === '.git/acb-private-backups')
  // a sibling with a common prefix is not private
  const sibling = editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/人事/評価2/表.md', privateFolders: ['人事/評価'], insideNestedRepo: false, now })
  assert.ok(!('skip' in sibling) && sibling.base === '.backups')
})

test('backup location: outside the company or inside .git/.backups → no backup', () => {
  const now = new Date(0)
  assert.deepEqual(editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/other/a.md', privateFolders: [], insideNestedRepo: false, now }), { skip: 'outside-company' })
  assert.deepEqual(editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co2/a.md', privateFolders: [], insideNestedRepo: false, now }), { skip: 'outside-company' })
  assert.deepEqual(editorOverwriteBackupPlan({ rootPath: '/co', filePath: '/co/.backups/x/a.md', privateFolders: [], insideNestedRepo: false, now }), { skip: 'internal' })
  assert.deepEqual(editorOverwriteBackupPlan({ rootPath: 'C:\\co', filePath: 'C:\\co\\.git\\config', privateFolders: [], insideNestedRepo: false, now }), { skip: 'internal' })
})

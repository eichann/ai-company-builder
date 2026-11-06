// A business plugin step's run or consultation writes only inside its deliverable folder,
// `<department>/.personal/<folder>/` (plugin-steps.md "The deliverable folder", owner decision
// 2026-11-06 ③). `.personal` never reaches the server, so this line is drawn here, by the chat
// write guard (`writeArea`), judged on the path as written and where it lands on disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { checkWritePath, decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { insideDeliverableFolder } from '../../shared/core/plugin-step-runs'

function world() {
  const base = mkdtempSync(path.join(tmpdir(), 'acb-step-area-'))
  const root = path.join(base, 'company')
  const outside = path.join(base, 'outside')
  mkdirSync(path.join(root, '営業部', '.personal', '提案書'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const guard: WriteGuard = { root, getAccess: () => ({ version: 1, role: 'member', all: true, scopes: [] }), writeArea: { folder: '提案書' } }
  return { base, root, outside, guard, done: () => rmSync(base, { recursive: true, force: true }) }
}

test('a step writes inside its deliverable folder; anywhere else is refused with the plain reason', () => {
  const w = world()
  try {
    const write = (p: string) => decideToolWrite(w.guard, 'Write', { file_path: p, content: 'x' }, w.root)
    assert.equal(write(path.join(w.root, '営業部/.personal/提案書/2026-11-06_A社/提案書.pdf')).deny, false)
    // A new department folder of the member's own is fine too (the folder is the step's, not the department's).
    assert.equal(write('企画部/.personal/提案書/memo.md').deny, false)
    for (const p of [
      '営業部/提案書/2026-11-06_A社/提案書.pdf',          // shared with the department
      '営業部/.personal/日報/today.md',                   // the member's own, but not the step's folder
      '営業部/.personal/提案書',                          // the folder itself, not inside it
      '.personal/提案書/x.md',                            // not under a department
      '営業部/.personal/提案書/../../共有.md',             // climbs out
      'CLAUDE.md',
      path.join(w.outside, 'x.md'),                        // outside the company folder
    ]) {
      const d = write(p)
      assert.equal(d.deny, true, p)
      assert.ok(d.deny && d.code === 'deliverable-folder' && d.message.includes('.personal/提案書/'), p)
    }
    // Edit / MultiEdit / NotebookEdit and a literal shell redirect are judged the same way.
    assert.equal(decideToolWrite(w.guard, 'Edit', { file_path: '営業部/共有.md' }, w.root).deny, true)
    assert.equal(decideToolWrite(w.guard, 'NotebookEdit', { notebook_path: '営業部/a.ipynb' }, w.root).deny, true)
    assert.equal(decideToolWrite(w.guard, 'Bash', { command: 'echo hi > 営業部/共有.md' }, w.root).deny, true)
    assert.equal(decideToolWrite(w.guard, 'Bash', { command: 'echo hi > 営業部/.personal/提案書/a.md' }, w.root).deny, false)
  } finally { w.done() }
})

test('a link cannot lead a step\'s write out of its deliverable folder', () => {
  const w = world()
  try {
    symlinkSync(w.outside, path.join(w.root, '営業部/.personal/提案書/link'))
    symlinkSync(path.join(w.root, '営業部'), path.join(w.root, '営業部/.personal/提案書/up'))
    assert.equal(checkWritePath(w.guard, '営業部/.personal/提案書/link/x.md', w.root).deny, true)
    assert.equal(checkWritePath(w.guard, '営業部/.personal/提案書/up/共有.md', w.root).deny, true)
    // The folder itself reached through a link outside it: refused as written.
    symlinkSync(path.join(w.root, '営業部/.personal/提案書'), path.join(w.root, '営業部/近道'))
    assert.equal(checkWritePath(w.guard, '営業部/近道/x.md', w.root).deny, true)
    assert.equal(checkWritePath(w.guard, '営業部/.personal/提案書/x.md', w.root).deny, false)
  } finally { w.done() }
})

test('an ordinary consultation is unchanged', () => {
  const w = world()
  try {
    const guard: WriteGuard = { ...w.guard, writeArea: undefined }
    assert.equal(checkWritePath(guard, '営業部/共有.md', w.root).deny, false)
    assert.equal(checkWritePath(guard, path.join(w.outside, 'x.md'), w.root).deny, false)
  } finally { w.done() }
})

test('the folder rule: NFC and A–Z folded like the disk, never a hidden department or an invalid folder', () => {
  assert.equal(insideDeliverableFolder('営業部/.Personal/提案書/a.pdf', '提案書'), true)
  assert.equal(insideDeliverableFolder('営業部/.personal/Proposal/a.pdf', 'proposal'), true)
  assert.equal(insideDeliverableFolder('.claude/.personal/提案書/a.pdf', '提案書'), false)
  assert.equal(insideDeliverableFolder('営業部/.personal/x/a.pdf', '../x'), false)
  assert.equal(insideDeliverableFolder('営業部//.personal/提案書/a.pdf', '提案書'), false)
})

// The way to ask the settings, from outside their sections, what is typed and not saved: what a frame
// (today's dialog, later a tab) asks before closing or moving on, so nothing typed disappears unasked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsUnsaved } from './unsaved'

const handle = (what: string | null, saved: string[], result: string | null = null) => ({
  pending: () => what,
  save: async () => { saved.push(what ?? ''); return result },
})

test('a mounted section is asked through its ref; once React clears it on unmount, nothing is asked of it', () => {
  const unsaved = createSettingsUnsaved()
  const saved: string[] = []
  unsaved.refFor('ownkeys').current = handle('鍵の入力', saved)
  assert.deepEqual(unsaved.pending(['ownkeys', 'input']), ['鍵の入力'])
  assert.equal(unsaved.refFor('ownkeys'), unsaved.refFor('ownkeys'))
  unsaved.refFor('ownkeys').current = null
  assert.deepEqual(unsaved.pending(['ownkeys']), [])
})

test('only the sections asked about are asked (moving on asks the open one; closing asks all)', () => {
  const unsaved = createSettingsUnsaved()
  const saved: string[] = []
  unsaved.refFor('ownkeys').current = handle('鍵の入力', saved)
  unsaved.refFor('input').current = handle('整え方の入力', saved)
  assert.deepEqual(unsaved.pending(['input']), ['整え方の入力'])
  assert.deepEqual(unsaved.pending(['ownkeys', 'input']), ['鍵の入力', '整え方の入力'])
})

test('a kept draft (the .env keys) is asked although no section of it is mounted', () => {
  const saved: string[] = []
  const unsaved = createSettingsUnsaved(() => ({ envkeys: handle('API キー・環境変数の入力', saved) }))
  assert.deepEqual(unsaved.pending(['mine', 'envkeys']), ['API キー・環境変数の入力'])
})

test('saving stops at the first section that could not save and leaves the rest unsaved', async () => {
  const unsaved = createSettingsUnsaved()
  const saved: string[] = []
  unsaved.refFor('ownkeys').current = handle(null, saved)
  unsaved.refFor('input').current = handle('整え方の入力', saved, 'ことばが長すぎます')
  unsaved.refFor('aienv').current = handle('名前の入力', saved)
  assert.equal(await unsaved.save(['ownkeys', 'input', 'aienv']), 'ことばが長すぎます')
  assert.deepEqual(saved, ['整え方の入力'])
  assert.equal(await unsaved.save(['aienv']), null)
  assert.deepEqual(saved, ['整え方の入力', '名前の入力'])
})

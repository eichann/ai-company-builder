// The document review's temporary save file name (src/features/doc-review/api.ts)
// and the rule sync uses to never commit one (client/shared/temp-save-file.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTempSaveFile, tempSaveFileName, TEMP_SAVE_EXCLUDE_PATTERN } from '../shared/temp-save-file'

test('the temporary file is a dotfile next to the target', () => {
  assert.equal(tempSaveFileName('提案書.md.review.r1.json', 'k3x9'), '.提案書.md.review.r1.json.acb-tmp-k3x9')
})

test('isTempSaveFile: only the app\'s temporary save files, at any depth', () => {
  for (const p of [
    '.提案書.md.review.r1.json.acb-tmp-k3x9',
    '営業部/.提案書.md.reply.qtm6lc.json.acb-tmp-a',
    '/Users/demo/会社/営業部/2026/.x.acb-tmp-0',
  ]) assert.equal(isTempSaveFile(p), true, p)
  for (const p of [
    '提案書.md.review.r1.json',
    '営業部/提案書.md.acb-tmp-k3x9', // not a dotfile
    '.acb-tmp-k3x9', // nothing before the mark
    '営業部/.acb-tmp-x/notes.md', // a folder, not the file
    '.gitignore',
    '.env',
  ]) assert.equal(isTempSaveFile(p), false, p)
})

test('the exclude pattern has no slash, so git applies it in every folder', () => {
  assert.equal(TEMP_SAVE_EXCLUDE_PATTERN, '.*.acb-tmp-*')
  assert.ok(!TEMP_SAVE_EXCLUDE_PATTERN.includes('/'))
})

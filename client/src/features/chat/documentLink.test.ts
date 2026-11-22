// The chat's ［見る］ (documentLink.ts): offered only on a finished writing row naming an .html / .htm
// file inside the company folder; never for a read, a failure, a running call, another file type,
// a file outside the company folder or a path that climbs out of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { documentToViewOf } from './documentLink'

const ROOT = '/Users/m/Company'
const row = (toolName: string, input: unknown, state = 'output-available', failure?: { reason?: string }) => ({ toolName, input, state, failure })

test('a finished write or edit of an HTML file in the company folder offers it', () => {
  assert.equal(documentToViewOf(row('Write', { file_path: `${ROOT}/営業/報告.html` }), ROOT), `${ROOT}/営業/報告.html`)
  assert.equal(documentToViewOf(row('Edit', { file_path: `${ROOT}/営業/slides.HTM` }), `${ROOT}/`), `${ROOT}/営業/slides.HTM`)
  assert.equal(documentToViewOf(row('MultiEdit', { file_path: `${ROOT}/a/b.html` }), ROOT), `${ROOT}/a/b.html`)
  assert.equal(documentToViewOf(row('writeFile', { path: `${ROOT}/a/b.html` }), ROOT), `${ROOT}/a/b.html`)
  // Codex reports a file change with its changed files: the first HTML one.
  assert.equal(documentToViewOf(row('Write', { changes: [{ path: `${ROOT}/a/style.css` }, { path: `${ROOT}/a/index.html` }] }), ROOT), `${ROOT}/a/index.html`)
})

test('nothing for a read, a running or failed call, another type, outside the folder, or a climbing path', () => {
  const html = { file_path: `${ROOT}/営業/報告.html` }
  assert.equal(documentToViewOf(row('Read', html), ROOT), null)
  assert.equal(documentToViewOf(row('Bash', html), ROOT), null)
  assert.equal(documentToViewOf(row('Write', html, 'input-available'), ROOT), null)
  assert.equal(documentToViewOf(row('Write', html, 'output-error'), ROOT), null)
  assert.equal(documentToViewOf(row('Write', html, 'output-available', { reason: 'できません' }), ROOT), null)
  assert.equal(documentToViewOf(row('Write', html), null), null, 'no company folder')
  assert.equal(documentToViewOf(row('Write', { file_path: `${ROOT}/営業/報告.md` }), ROOT), null)
  assert.equal(documentToViewOf(row('Write', { file_path: '/tmp/x.html' }), ROOT), null)
  assert.equal(documentToViewOf(row('Write', { file_path: `${ROOT}-other/x.html` }), ROOT), null, 'a sibling folder whose name starts the same')
  assert.equal(documentToViewOf(row('Write', { file_path: `${ROOT}/a/../../x.html` }), ROOT), null)
  assert.equal(documentToViewOf(row('Write', { file_path: `${ROOT}/a/./x.html` }), ROOT), null)
  assert.equal(documentToViewOf(row('Write', { file_path: 'a/x.html' }), ROOT), null, 'a relative path')
  assert.equal(documentToViewOf(row('Write', undefined), ROOT), null, 'a restored row has no input')
})

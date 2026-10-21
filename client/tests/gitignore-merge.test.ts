import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GITIGNORE_UNION_ATTRIBUTE,
  dropUnionDuplicates,
  ensureGitignoreUnionMerge,
} from '../electron/sync/gitignore-merge'

test('ensureGitignoreUnionMerge declares the attribute once and keeps existing lines', () => {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-attr-'))
  try {
    const file = path.join(gitDir, 'info', 'attributes')
    assert.equal(ensureGitignoreUnionMerge(gitDir), true) // creates info/
    assert.equal(ensureGitignoreUnionMerge(gitDir), false)
    assert.equal(fs.readFileSync(file, 'utf-8').split('\n').filter(l => l === GITIGNORE_UNION_ATTRIBUTE).length, 1)

    fs.writeFileSync(file, '*.pptx binary') // no trailing newline
    assert.equal(ensureGitignoreUnionMerge(gitDir), true)
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    assert.equal(lines[0], '*.pptx binary')
    assert.ok(lines.includes(GITIGNORE_UNION_ATTRIBUTE))
    assert.equal(ensureGitignoreUnionMerge(gitDir), false)
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true })
  }
})

test('dropUnionDuplicates removes only the copies the merge added', () => {
  const server = 'a\nx/\nshared/\n'
  const local = 'a\nshared/\nz/\n'
  assert.equal(dropUnionDuplicates('a\nx/\nshared/\nshared/\nz/\n', server, local), 'a\nx/\nshared/\nz/\n')
})

test('dropUnionDuplicates keeps duplicates a side already had', () => {
  const server = 'dup\ndup\n'
  assert.equal(dropUnionDuplicates('dup\ndup\nnew\n', server, 'dup\ndup\nnew\n'), 'dup\ndup\nnew\n')
})

test('dropUnionDuplicates keeps a copy when a negation lies between (order decides)', () => {
  const server = '*.log\n!keep.log\n'
  const local = '*.log\n'
  // Dropping the second "*.log" would share keep.log again.
  const merged = '*.log\n!keep.log\n*.log\n'
  assert.equal(dropUnionDuplicates(merged, server, local), merged)
  // Without a negation in between the later copy is redundant.
  assert.equal(dropUnionDuplicates('*.log\ntmp/\n*.log\n', '*.log\ntmp/\n', local), '*.log\ntmp/\n')
})

test('dropUnionDuplicates drops duplicated comments, leaves blank lines and CRLF intact', () => {
  const server = '# Nested\r\n/ext-a/\r\n'
  const local = '# Nested\r\n/ext-b/\r\n'
  assert.equal(
    dropUnionDuplicates('# Nested\r\n/ext-a/\r\n\r\n# Nested\r\n/ext-b/\r\n', server, local),
    '# Nested\r\n/ext-a/\r\n\r\n/ext-b/\r\n',
  )
})

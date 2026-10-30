// The API-key chat's readFile / readSkillFile (electron/chat-tools.ts) read
// only the first 50 KB of a file: a huge file in the company folder was read
// whole into the app's memory before being cut (a file over 2 GiB failed
// outright), and anything that is not a regular file is refused instead of read.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createFileSystemTools, createSkillTools } from '../electron/chat-tools'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-chat-tools-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

type Exec = (input: { path: string }, options: { toolCallId: string; messages: [] }) => Promise<string>
const run = (t: { execute?: unknown }, p: string) => (t.execute as Exec)({ path: p }, { toolCallId: 't1', messages: [] })

test('a file larger than the app could hold is answered with its first 50 KB, at once', async () => {
  const big = path.join(dir, 'video.mov')
  fs.writeFileSync(big, 'あ'.repeat(30_000)) // 90 KB of text first
  fs.truncateSync(big, 3 * 1024 ** 3) // then 3 GiB (sparse: costs no disk)
  const tools = createFileSystemTools(dir)
  const started = Date.now()
  const text = await run(tools.readFile, 'video.mov')
  assert.ok(Date.now() - started < 2000, 'not read whole')
  assert.ok(text.endsWith('\n... (truncated)'))
  assert.ok(Buffer.byteLength(text) <= 50_000 + 20)
  assert.ok(text.startsWith('あああ'))
  // The skill tool reads the same way.
  assert.ok((await run(createSkillTools(dir).readSkillFile, 'video.mov')).endsWith('\n... (truncated)'))
})

test('a small file comes back whole, without a truncation mark', async () => {
  fs.writeFileSync(path.join(dir, 'memo.md'), '# メモ\n本文')
  assert.equal(await run(createFileSystemTools(dir).readFile, 'memo.md'), '# メモ\n本文')
})

test('something that is not a regular file is refused instead of read (a pipe would never end)', { skip: process.platform === 'win32' }, async () => {
  const fifo = path.join(dir, 'pipe')
  execFileSync('mkfifo', [fifo])
  await assert.rejects(run(createFileSystemTools(dir).readFile, 'pipe'), /Not a file/)
  fs.mkdirSync(path.join(dir, 'folder'))
  await assert.rejects(run(createFileSystemTools(dir).readFile, 'folder'), /Not a file/)
})

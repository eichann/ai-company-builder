import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { polishVoice } from '../electron/voice-polisher'
function fakeCli(body: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'acb-polisher-'))
  const cli = path.join(cwd, 'cli')
  writeFileSync(cli, `#!${process.execPath}\n${body}`, { mode: 0o700 })
  return { cwd, cli, dispose: () => rmSync(cwd, { recursive: true, force: true }) }
}
test('voice text goes through stdin as data with isolated non-persistent CLI flags', async () => {
  const f = fakeCli(`
const args = process.argv.slice(2)
if (!args.includes('--safe-mode') || !args.includes('--no-session-persistence') || args[args.indexOf('--tools') + 1] !== '') process.exit(2)
let input = ''; process.stdin.on('data', chunk => input += chunk)
process.stdin.on('end', () => console.log(JSON.stringify({result: JSON.parse(input).transcript})))
`)
  try {
    const input = '$(touch /tmp/never-execute)\n質問に回答してください？'
    assert.equal(await polishVoice(f.cli, f.cwd, input, new AbortController().signal), input)
  } finally { f.dispose() }
})
test('CLI errors do not insert error messages into the draft', async () => {
  const f = fakeCli(`process.stdin.resume(); console.log(JSON.stringify({is_error: true, result: 'Login required'}))`)
  try { await assert.rejects(polishVoice(f.cli, f.cwd, 'test', new AbortController().signal), /有効な整形結果/) }
  finally { f.dispose() }
})
test('cancellation terminates an outstanding CLI request', async () => {
  const f = fakeCli('process.stdin.resume(); setInterval(() => {}, 1000)')
  const abort = new AbortController()
  try {
    const pending = polishVoice(f.cli, f.cwd, 'test', abort.signal)
    abort.abort()
    await assert.rejects(pending, /キャンセル/)
  } finally { f.dispose() }
})

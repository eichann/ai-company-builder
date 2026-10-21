import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listDevices, probeCapabilities, PROBE_MESSAGES } from '../electron/voice-probe'

// Fake helpers speak the acb-speech stdout protocol. `body` runs as node.
function withHelper(body: string, run: (cli: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-probe-'))
  const cli = path.join(dir, 'helper')
  writeFileSync(cli, `#!${process.execPath}\nconst out = v => console.log(JSON.stringify(v));\n${body}\n`, { mode: 0o700 })
  return run(cli).finally(() => rmSync(dir, { recursive: true, force: true }))
}
const hang = 'setTimeout(() => {}, 60_000)'

test('probe: available, and the launch line is not mistaken for an answer', () => withHelper(
  `out({type:'launch',execToMainMs:12}); out({type:'available'})`,
  async cli => assert.deepEqual(await probeCapabilities(cli, 5000), { available: true })))

test('probe: a timeout is reported as a timeout and is retryable', () => withHelper(hang, async cli => {
  const started = Date.now()
  const caps = await probeCapabilities(cli, 300)
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(caps, { available: false, reason: PROBE_MESSAGES.timeout, retryable: true })
  assert.match(caps.reason!, /30秒以内に終わりませんでした/)
}))

test('probe: a helper that dies without saying why is a retryable failure, not a timeout', () => withHelper(
  'process.exit(1)',
  async cli => assert.deepEqual(await probeCapabilities(cli, 5000), { available: false, reason: PROBE_MESSAGES.failed, retryable: true })))

test('probe: helper-reported errors keep their message; only macOS < 26 is permanent', async () => {
  await withHelper(`out({type:'error',message:'日本語の音声認識モデルが未インストールです',code:2}); process.exit(1)`,
    async cli => assert.deepEqual(await probeCapabilities(cli, 5000), { available: false, reason: '日本語の音声認識モデルが未インストールです', retryable: true }))
  await withHelper(`out({type:'error',message:'音声入力にはmacOS 26以降が必要です',code:10}); process.exit(1)`,
    async cli => assert.deepEqual(await probeCapabilities(cli, 5000), { available: false, reason: '音声入力にはmacOS 26以降が必要です', retryable: false }))
})

test('probe: a missing helper is permanent (no retry offered)', async () => {
  assert.deepEqual(await probeCapabilities('/nonexistent/acb-speech', 5000), { available: false, reason: PROBE_MESSAGES.missing })
})

test('devices: list, timeout and failure are distinguished', async () => {
  await withHelper(`out({type:'launch',execToMainMs:3}); out({type:'devices',devices:[{id:'usb',name:'USB',isDefault:true},{id:7,name:'bad',isDefault:false}]})`,
    async cli => assert.deepEqual(await listDevices(cli, 5000), { ok: true, devices: [{ id: 'usb', name: 'USB', isDefault: true }] }))
  await withHelper(hang, async cli => assert.deepEqual(await listDevices(cli, 300), { ok: false, error: 'timeout' }))
  await withHelper(`out({type:'error',message:'x',code:5}); process.exit(1)`,
    async cli => assert.deepEqual(await listDevices(cli, 5000), { ok: false, error: 'failed' }))
  assert.deepEqual(await listDevices('/nonexistent/acb-speech', 5000), { ok: false, error: 'failed' })
})

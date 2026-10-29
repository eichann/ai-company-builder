// The API key at rest (electron/services/api-key-store.ts): encrypted in
// config.json, migrated from the old plain field, refused (never stored in
// plain text) without OS encryption, and only its status reaches the renderer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApiKeyStore, type SecretBox } from '../electron/services/api-key-store.ts'
import { createConfigStore } from '../electron/services/config-store.ts'

const FAKE_KEY = 'sk-ant-FAKE-unit-test-key-ABCD'

function fakeBox(): SecretBox & { on: boolean } {
  return {
    on: true,
    available() { return this.on },
    encrypt: (text) => Buffer.from(`sealed:${Buffer.from(text).reverse().toString('hex')}`),
    decrypt: (data) => {
      const s = data.toString()
      if (!s.startsWith('sealed:')) throw new Error('cannot decrypt')
      return Buffer.from(s.slice(7), 'hex').reverse().toString()
    },
  }
}

function world(initial?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-api-key-'))
  const file = path.join(dir, 'config.json')
  if (initial) fs.writeFileSync(file, JSON.stringify(initial))
  const box = fakeBox()
  const logs: string[] = []
  const store = createApiKeyStore(createConfigStore(() => file), box, m => logs.push(m))
  return { file, box, store, logs, disk: () => fs.readFileSync(file, 'utf-8'), done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('save encrypts; the renderer status has only the last four characters', () => {
  const w = world()
  try {
    assert.deepEqual(w.store.save(`  ${FAKE_KEY}\n`), { success: true })
    assert.ok(!w.disk().includes(FAKE_KEY))
    assert.equal(JSON.parse(w.disk()).anthropicApiKey, undefined)
    assert.equal(w.store.read(), FAKE_KEY)
    const status = w.store.status()
    assert.deepEqual(status, { set: true, last4: 'ABCD', encryptionAvailable: true })
    assert.ok(!JSON.stringify(status).includes(FAKE_KEY.slice(0, -4)))
  } finally { w.done() }
})

test('migration: a plain key from an older version is encrypted on first read and the plain field removed', () => {
  const w = world({ serverUrl: 'https://acb.example', anthropicApiKey: FAKE_KEY })
  try {
    assert.equal(w.store.read(), FAKE_KEY)
    const saved = JSON.parse(w.disk())
    assert.equal(saved.anthropicApiKey, undefined)
    assert.equal(saved.serverUrl, 'https://acb.example')
    assert.equal(typeof saved.anthropicApiKeyEncrypted, 'string')
    assert.ok(!w.disk().includes(FAKE_KEY))
    assert.equal(w.logs.length, 1)
    assert.ok(w.logs.every(line => !line.includes(FAKE_KEY) && !line.includes('ABCD')))
    // A second store over the same file (next app start) reads the encrypted key.
    const again = createApiKeyStore(createConfigStore(() => w.file), fakeBox())
    assert.deepEqual(again.status(), { set: true, last4: 'ABCD', encryptionAvailable: true })
  } finally { w.done() }
})

test('migration waits while encryption is unavailable: the plain key keeps working, flagged for a warning', () => {
  const w = world({ anthropicApiKey: FAKE_KEY })
  try {
    w.box.on = false
    assert.equal(w.store.read(), FAKE_KEY)
    assert.deepEqual(w.store.status(), { set: true, last4: 'ABCD', encryptionAvailable: false, storedInPlainText: true })
    assert.equal(JSON.parse(w.disk()).anthropicApiKey, FAKE_KEY, 'not removed without an encrypted copy')
    w.box.on = true // e.g. after app ready
    assert.deepEqual(w.store.status(), { set: true, last4: 'ABCD', encryptionAvailable: true })
    assert.ok(!w.disk().includes(FAKE_KEY))
  } finally { w.done() }
})

test('no OS encryption: saving a new key is refused and nothing is written in plain text', () => {
  const w = world()
  try {
    w.box.on = false
    const result = w.store.save(FAKE_KEY)
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /安全に保存する仕組み/)
    assert.ok(!fs.existsSync(w.file) || !w.disk().includes(FAKE_KEY))
    assert.deepEqual(w.store.status(), { set: false, encryptionAvailable: false })
  } finally { w.done() }
})

test('a key this computer cannot decrypt reads as unset and is reported as unreadable', () => {
  const w = world({ anthropicApiKeyEncrypted: Buffer.from('from-another-mac').toString('base64') })
  try {
    assert.equal(w.store.read(), undefined)
    assert.deepEqual(w.store.status(), { set: false, encryptionAvailable: true, unreadable: true })
    assert.deepEqual(w.store.save(FAKE_KEY), { success: true })
    assert.equal(w.store.read(), FAKE_KEY)
  } finally { w.done() }
})

test('an old version that wrote a plain key again: the newer plain key replaces the encrypted one', () => {
  const box = fakeBox()
  const w = world({ anthropicApiKeyEncrypted: box.encrypt('sk-ant-FAKE-older-0000').toString('base64'), anthropicApiKey: FAKE_KEY })
  try {
    assert.equal(w.store.read(), FAKE_KEY)
    assert.equal(JSON.parse(w.disk()).anthropicApiKey, undefined)
  } finally { w.done() }
})

test('an empty key removes the stored key', () => {
  const w = world()
  try {
    w.store.save(FAKE_KEY)
    assert.deepEqual(w.store.save('  '), { success: true })
    assert.equal(w.store.read(), undefined)
    assert.equal(JSON.parse(w.disk()).anthropicApiKeyEncrypted, undefined)
  } finally { w.done() }
})

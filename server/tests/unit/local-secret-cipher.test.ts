/**
 * The key broker's envelope encryption (adapters/local-secret-cipher.ts):
 * a stored key opens only with its own context and a loaded KEK, any
 * tampering fails, and moving to a new KEK re-wraps the data key without
 * re-encrypting the value (what a later KMS migration relies on).
 */
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'crypto'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'

const FAKE_KEY = 'fake-test-key-NOT-REAL-0123456789abcdef'
const ctx = { purpose: 'acb-broker-key', companyId: 'c1', keyId: 'k1' }

describe('envelope encryption of broker keys', () => {
  const kek = randomBytes(32)
  const cipher = localSecretCipher(kek)

  it('round-trips, and nothing stored contains the value', async () => {
    const sealed = await cipher.seal(FAKE_KEY, ctx)
    expect(sealed.scheme).toBe('env1')
    expect(sealed.kekId).toMatch(/^local:[0-9a-f]{16}$/)
    expect(JSON.stringify(sealed)).not.toContain('NOT-REAL')
    expect(await cipher.open(sealed, { keyId: 'k1', companyId: 'c1', purpose: 'acb-broker-key' })).toBe(FAKE_KEY)
  })

  it('a fresh data key and nonce every time', async () => {
    const a = await cipher.seal(FAKE_KEY, ctx)
    const b = await cipher.seal(FAKE_KEY, ctx)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.wrappedKey).not.toBe(b.wrappedKey)
  })

  it('a sealed key copied to another company or row does not open', async () => {
    const sealed = await cipher.seal(FAKE_KEY, ctx)
    await expect(cipher.open(sealed, { ...ctx, companyId: 'c2' })).rejects.toThrow()
    await expect(cipher.open(sealed, { ...ctx, keyId: 'k2' })).rejects.toThrow()
  })

  it('another KEK, a tampered value, tag or wrapped key all fail', async () => {
    const sealed = await cipher.seal(FAKE_KEY, ctx)
    await expect(localSecretCipher(randomBytes(32)).open(sealed, ctx)).rejects.toThrow()
    const flip = (s: string) => {
      const b = Buffer.from(s, 'base64url')
      b[0] ^= 1
      return b.toString('base64url')
    }
    await expect(cipher.open({ ...sealed, ciphertext: flip(sealed.ciphertext) }, ctx)).rejects.toThrow()
    await expect(cipher.open({ ...sealed, tag: flip(sealed.tag) }, ctx)).rejects.toThrow()
    const parts = sealed.wrappedKey.split('.')
    parts[3] = flip(parts[3])
    await expect(cipher.open({ ...sealed, wrappedKey: parts.join('.') }, ctx)).rejects.toThrow()
    await expect(cipher.open({ ...sealed, scheme: 'env0' }, ctx)).rejects.toThrow(/scheme/)
  })

  it('a new KEK re-wraps only the data key: same ciphertext, opens under the new KEK alone', async () => {
    const sealed = await cipher.seal(FAKE_KEY, ctx)
    const newKek = randomBytes(32)
    const rotating = localSecretCipher(newKek, [kek])
    expect(await rotating.open(sealed, ctx)).toBe(FAKE_KEY)
    const moved = await rotating.rewrap(sealed, ctx)
    expect(moved.ciphertext).toBe(sealed.ciphertext)
    expect(moved.nonce).toBe(sealed.nonce)
    expect(moved.tag).toBe(sealed.tag)
    expect(moved.kekId).not.toBe(sealed.kekId)
    expect(await localSecretCipher(newKek).open(moved, ctx)).toBe(FAKE_KEY)
    await expect(cipher.open(moved, ctx)).rejects.toThrow(/not loaded/)
  })

  it('requires a 256-bit KEK', () => {
    expect(() => localSecretCipher(randomBytes(16))).toThrow(/32 bytes/)
  })
})

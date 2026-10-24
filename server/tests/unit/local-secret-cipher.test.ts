import { describe, expect, it } from 'vitest'
import { randomBytes } from 'crypto'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'

describe('localSecretCipher (SecretCipher, AES-256-GCM)', () => {
  const key = randomBytes(32)
  const cipher = localSecretCipher(key)

  it('round-trips text, Japanese included', async () => {
    const secret = 'sk-ant-api03-秘密のキー'
    const ct = await cipher.encrypt(secret, { companyId: 'c1', purpose: 'api-key' })
    expect(ct).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(ct).not.toContain('sk-ant')
    expect(await cipher.decrypt(ct, { purpose: 'api-key', companyId: 'c1' })).toBe(secret)
  })

  it('uses a fresh IV every time', async () => {
    expect(await cipher.encrypt('x')).not.toBe(await cipher.encrypt('x'))
  })

  it('refuses another context, another key, and a tampered ciphertext', async () => {
    const ct = await cipher.encrypt('secret', { companyId: 'c1' })
    await expect(cipher.decrypt(ct, { companyId: 'c2' })).rejects.toThrow()
    await expect(cipher.decrypt(ct)).rejects.toThrow()
    await expect(localSecretCipher(randomBytes(32)).decrypt(ct, { companyId: 'c1' })).rejects.toThrow()

    const parts = ct.split('.')
    const data = Buffer.from(parts[3], 'base64url')
    data[0] ^= 1
    parts[3] = data.toString('base64url')
    await expect(cipher.decrypt(parts.join('.'), { companyId: 'c1' })).rejects.toThrow()
    await expect(cipher.decrypt('v2.a.b.c')).rejects.toThrow(/unsupported/)
  })

  it('requires a 256-bit key', () => {
    expect(() => localSecretCipher(randomBytes(16))).toThrow(/32 bytes/)
  })
})

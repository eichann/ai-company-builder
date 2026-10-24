/**
 * SecretCipher with a key held by this process: AES-256-GCM, a random 96-bit
 * IV per message, the context bound as additional authenticated data.
 *
 * Ciphertext: `v1.<iv>.<tag>.<data>` (base64url). The version prefix lets a
 * KMS-backed cipher (envelope encryption) coexist with stored v1 values
 * during a migration.
 *
 * Not used by anything yet (the key broker that will use it is planned).
 * Where the key comes from is the caller's decision; it is never generated
 * or persisted here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import type { SecretCipher } from '../ports/secret-cipher'

const VERSION = 'v1'
const IV_BYTES = 12

/** Context as bytes: keys sorted, so `{a, b}` and `{b, a}` are the same context. */
function contextBytes(context: Record<string, string> | undefined): Buffer {
  const entries = Object.entries(context ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Buffer.from(JSON.stringify(entries), 'utf8')
}

export function localSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== 32) throw new Error('localSecretCipher: the key must be 32 bytes (AES-256)')
  const k = Buffer.from(key)

  return {
    async encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', k, iv)
      cipher.setAAD(contextBytes(context))
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.')
    },

    async decrypt(ciphertext, context) {
      const parts = ciphertext.split('.')
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('localSecretCipher: unsupported ciphertext')
      const [, iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'))
      if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('localSecretCipher: unsupported ciphertext')
      const decipher = createDecipheriv('aes-256-gcm', k, iv)
      decipher.setAAD(contextBytes(context))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    },
  }
}

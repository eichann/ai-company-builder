/**
 * Envelope encryption of the key broker's secrets (ports/secret-cipher.ts)
 * with a KEK held by this process (stage 1: a file, adapters/kek-file.ts).
 *
 * - `envelopeSecretCipher(current, previous)`: a fresh random 256-bit data key
 *   per secret encrypts the value (AES-256-GCM, 96-bit nonce, the context as
 *   additional data); the data key is wrapped by `current`. `open` unwraps with
 *   whichever wrapper's kekId matches the row (`previous` = KEKs being retired).
 * - `localKeyWrapper(kek)`: wraps data keys with AES-256-GCM under the KEK;
 *   wrapped form `w1.<nonce>.<tag>.<data>` (base64url). Its id is a one-way
 *   fingerprint of the KEK (`local:<16 hex>`), safe to store and log.
 *
 * Never generates or persists a KEK, and never logs a value.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import type { KeyWrapper, SealedSecret, SecretCipher, SecretContext } from '../ports/secret-cipher'

export const ENVELOPE_SCHEME = 'env1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** Context as bytes: keys sorted, so `{a, b}` and `{b, a}` are the same context. */
function contextBytes(context: SecretContext, layer: string): Buffer {
  const entries = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Buffer.from(JSON.stringify([layer, entries]), 'utf8')
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { nonce, tag: cipher.getAuthTag(), data }
}

function gcmDecrypt(key: Buffer, nonce: Buffer, tag: Buffer, data: Buffer, aad: Buffer): Buffer {
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('secret-cipher: malformed envelope')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** One-way id of a KEK: lets rows say which KEK wrapped them without revealing it. */
export function kekFingerprint(kek: Buffer): string {
  return createHash('sha256').update('acb-broker-kek-id\0').update(kek).digest('hex').slice(0, 16)
}

export function localKeyWrapper(kek: Buffer): KeyWrapper {
  if (kek.length !== KEY_BYTES) throw new Error('localKeyWrapper: the KEK must be 32 bytes (AES-256)')
  const k = Buffer.from(kek)
  const kekId = `local:${kekFingerprint(k)}`
  return {
    kekId,
    async wrap(dataKey, context) {
      const { nonce, tag, data } = gcmEncrypt(k, Buffer.from(dataKey), contextBytes(context, 'wrap'))
      return ['w1', nonce, tag, data].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
    },
    async unwrap(wrapped, context) {
      const parts = wrapped.split('.')
      if (parts.length !== 4 || parts[0] !== 'w1') throw new Error('localKeyWrapper: unsupported wrapped key')
      const [nonce, tag, data] = parts.slice(1).map(p => Buffer.from(p, 'base64url'))
      const key = gcmDecrypt(k, nonce, tag, data, contextBytes(context, 'wrap'))
      if (key.length !== KEY_BYTES) throw new Error('localKeyWrapper: unsupported wrapped key')
      return key
    },
  }
}

export function envelopeSecretCipher(current: KeyWrapper, previous: KeyWrapper[] = []): SecretCipher {
  const wrappers = new Map([...previous, current].map(w => [w.kekId, w]))
  wrappers.set(current.kekId, current)

  async function dataKeyOf(sealed: SealedSecret, context: SecretContext): Promise<Buffer> {
    if (sealed.scheme !== ENVELOPE_SCHEME) throw new Error('secret-cipher: unsupported scheme')
    const wrapper = wrappers.get(sealed.kekId)
    if (!wrapper) throw new Error('secret-cipher: the key-encryption key of this secret is not loaded')
    return Buffer.from(await wrapper.unwrap(sealed.wrappedKey, context))
  }

  return {
    kekId: current.kekId,

    async seal(plaintext, context) {
      const dataKey = randomBytes(KEY_BYTES)
      try {
        const { nonce, tag, data } = gcmEncrypt(dataKey, Buffer.from(plaintext, 'utf8'), contextBytes(context, 'value'))
        return {
          scheme: ENVELOPE_SCHEME,
          ciphertext: data.toString('base64url'),
          nonce: nonce.toString('base64url'),
          tag: tag.toString('base64url'),
          wrappedKey: await current.wrap(dataKey, context),
          kekId: current.kekId,
        }
      } finally {
        dataKey.fill(0)
      }
    },

    async open(sealed, context) {
      const dataKey = await dataKeyOf(sealed, context)
      try {
        const b = (s: string) => Buffer.from(s, 'base64url')
        return gcmDecrypt(dataKey, b(sealed.nonce), b(sealed.tag), b(sealed.ciphertext), contextBytes(context, 'value')).toString('utf8')
      } finally {
        dataKey.fill(0)
      }
    },

    async rewrap(sealed, context) {
      const dataKey = await dataKeyOf(sealed, context)
      try {
        return { ...sealed, wrappedKey: await current.wrap(dataKey, context), kekId: current.kekId }
      } finally {
        dataKey.fill(0)
      }
    },
  }
}

/** The stage-1 cipher: envelope encryption under a local KEK (32 bytes). */
export function localSecretCipher(kek: Buffer, previousKeks: Buffer[] = []): SecretCipher {
  return envelopeSecretCipher(localKeyWrapper(kek), previousKeks.map(localKeyWrapper))
}

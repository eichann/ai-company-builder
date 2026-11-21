/**
 * The app's crypto for plugin trust (`.claude/rules/plugin-trust.md`): `node:crypto` behind the
 * core's `PluginTrustCrypto` (`shared/core/plugin-trust-sshsig.ts`), no new dependency. P1: only
 * the tests use it; P2's trust record and P4's gate take it from the composition root.
 *
 * - ed25519: the 32-byte key as a JWK, `crypto.verify(null, …)` over the SSHSIG's signed data.
 * - P-256: the uncompressed point as a JWK (Node refuses a point off the curve), ECDSA with SHA-256
 *   over the signed data, the signature as r ‖ s (`ieee-p1363`).
 * Anything that throws is `false`.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import type { PluginTrustCrypto, SshKeyType } from '../../../../shared/core/plugin-trust-sshsig'

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

function publicKeyOf(type: SshKeyType, key: Uint8Array): KeyObject {
  if (type === 'ssh-ed25519') {
    if (key.length !== 32) throw new Error('ed25519 key length')
    return createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: b64url(key) } })
  }
  if (key.length !== 65 || key[0] !== 4) throw new Error('P-256 point')
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64url(key.subarray(1, 33)), y: b64url(key.subarray(33)) } })
}

export const nodePluginTrustCrypto: PluginTrustCrypto = {
  sha256: data => new Uint8Array(createHash('sha256').update(data).digest()),
  sha512: data => new Uint8Array(createHash('sha512').update(data).digest()),
  verify(type, publicKey, data, signature) {
    try {
      const key = publicKeyOf(type, publicKey)
      if (type === 'ssh-ed25519') return signature.length === 64 && verify(null, data, key, signature)
      return signature.length === 64 && verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    } catch {
      return false
    }
  },
}

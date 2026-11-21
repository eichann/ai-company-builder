/**
 * Plugin trust, part 1: OpenSSH signatures (`ssh-keygen -Y sign`, the "SSHSIG" format) and the
 * public keys they carry, read strictly and verified through an injected `verify`
 * (`.claude/rules/plugin-trust.md`). Pure: no Node built-ins — the hashes and the signature check
 * come from the caller (`PluginTrustCrypto`; the app's is `client/electron/features/plugins/trust-crypto.ts`).
 *
 * Two key types, both as OpenSSH writes them:
 * - `ssh-ed25519`: the root keys (offline files) and the freshness key (GitHub Actions secret);
 * - `ecdsa-sha2-nistp256`: the everyday signing key (targets) in the Mac's Secure Enclave
 *   (Secretive), and the emergency freshness key. Only uncompressed points on the curve.
 *
 * A key's identity is its decoded value (`keyIdentity`: type + the 32-byte ed25519 key or the
 * 65-byte P-256 point), never the base64 spelling, and base64 is accepted only in its one
 * canonical spelling (Codex's P1 condition 1).
 */

export type SshKeyType = 'ssh-ed25519' | 'ecdsa-sha2-nistp256'
export const SSH_KEY_TYPES: readonly SshKeyType[] = ['ssh-ed25519', 'ecdsa-sha2-nistp256']

/**
 * What the pure code needs from a crypto library. `verify` gets the decoded key bytes (ed25519:
 * 32 bytes; P-256: the 65-byte uncompressed point), the exact bytes that were signed and the raw
 * signature (ed25519: 64 bytes; P-256: r ‖ s, 32 bytes each, over sha256 of `data`). It never
 * throws: anything it cannot check is `false`.
 */
export interface PluginTrustCrypto {
  sha256(data: Uint8Array): Uint8Array
  sha512(data: Uint8Array): Uint8Array
  verify(type: SshKeyType, publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean
}

export interface SshPublicKey {
  type: SshKeyType
  /** ed25519: the 32-byte key; P-256: the 65-byte uncompressed point. */
  key: Uint8Array
  /** `<type>:<hex of key>` — the identity every comparison and every threshold count uses. */
  identity: string
}

// ---------------------------------------------------------------- bytes

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_VALUE: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]))

export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }
  return out
}

/**
 * Standard base64 in its one canonical spelling (padding as required, unused bits zero, no
 * whitespace), or null. Two spellings of one value can therefore never both be accepted.
 */
export function decodeBase64Strict(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const v = [0, 1, 2, 3].map(j => (text[i + j] === '=' ? 0 : B64_VALUE[text[i + j]]))
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3]
    for (const b of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) if (o < out.length) out[o++] = b
  }
  return encodeBase64(out) === text ? out : null
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes)
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** SSH wire `string`: uint32 length, then the bytes. */
function sshString(bytes: Uint8Array): Uint8Array {
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, bytes.length)
  return concat([len, bytes])
}

/** Reads SSH wire data; every read past the end throws (callers turn that into a refusal). */
class WireReader {
  private offset = 0
  constructor(private readonly bytes: Uint8Array) {}
  bytesOf(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error('truncated')
    const v = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return v
  }
  u32(): number {
    const b = this.bytesOf(4)
    return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]
  }
  string(): Uint8Array { return this.bytesOf(this.u32()) }
  done(): boolean { return this.offset === this.bytes.length }
}

// ---------------------------------------------------------------- P-256 points

const P256_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff')
const P256_B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b')
const bigOf = (bytes: Uint8Array): bigint => BigInt('0x' + (toHex(bytes) || '0'))

/** An uncompressed P-256 point whose coordinates lie on the curve (y² = x³ − 3x + b mod p). */
export function isP256Point(point: Uint8Array): boolean {
  if (point.length !== 65 || point[0] !== 4) return false
  const x = bigOf(point.subarray(1, 33))
  const y = bigOf(point.subarray(33))
  if (x >= P256_P || y >= P256_P) return false
  const mod = (v: bigint) => ((v % P256_P) + P256_P) % P256_P
  return mod(y * y) === mod(x * x * x - BigInt(3) * x + P256_B)
}

// ---------------------------------------------------------------- public keys

/** An OpenSSH public key blob (the base64 part of a `.pub` line, decoded), or an error. */
export function decodeSshPublicKey(blob: Uint8Array): { ok: true; key: SshPublicKey } | { ok: false; error: string } {
  try {
    const r = new WireReader(blob)
    const type = ascii(r.string())
    let key: Uint8Array
    if (type === 'ssh-ed25519') {
      key = r.string()
      if (key.length !== 32) return { ok: false, error: 'an ed25519 key must be 32 bytes' }
    } else if (type === 'ecdsa-sha2-nistp256') {
      if (ascii(r.string()) !== 'nistp256') return { ok: false, error: 'the curve must be nistp256' }
      key = r.string()
      if (!isP256Point(key)) return { ok: false, error: 'a P-256 key must be an uncompressed point on the curve' }
    } else {
      return { ok: false, error: 'unknown key type' }
    }
    if (!r.done()) return { ok: false, error: 'trailing bytes after the key' }
    const copy = Uint8Array.from(key)
    return { ok: true, key: { type, key: copy, identity: `${type}:${toHex(copy)}` } }
  } catch {
    return { ok: false, error: 'truncated key' }
  }
}

/** A public key as a root document writes it: canonical base64 of the OpenSSH blob. */
export function parseRootKey(base64: unknown): { ok: true; key: SshPublicKey } | { ok: false; error: string } {
  if (typeof base64 !== 'string') return { ok: false, error: 'a key must be a base64 string' }
  const blob = decodeBase64Strict(base64)
  if (!blob) return { ok: false, error: 'a key must be canonical base64' }
  return decodeSshPublicKey(blob)
}

// ---------------------------------------------------------------- SSHSIG

const MAGIC = utf8('SSHSIG')
const ARMOR_RE = /^-----BEGIN SSH SIGNATURE-----\n((?:[A-Za-z0-9+/=]{1,76}\n)+)-----END SSH SIGNATURE-----\n?$/
/** ssh-keygen's armored signatures are a few hundred bytes; anything far larger is not one. */
const MAX_ARMORED = 4096

export interface ParsedSshSig {
  key: SshPublicKey
  namespace: string
  hashAlgorithm: 'sha256' | 'sha512'
  /** ed25519: 64 bytes; P-256: r ‖ s, 32 bytes each. */
  signature: Uint8Array
}

/** ECDSA's mpint (big-endian, a leading 0 when the high bit is set) as exactly 32 bytes. */
function scalar32(mpint: Uint8Array): Uint8Array | null {
  let b = mpint
  if (b.length === 0 || b[0] & 0x80) return null
  while (b.length > 0 && b[0] === 0) b = b.subarray(1)
  if (b.length === 0 || b.length > 32) return null
  const out = new Uint8Array(32)
  out.set(b, 32 - b.length)
  return out
}

/** Parse an armored SSHSIG strictly; null when it is not one this code accepts. */
export function parseSshSig(armored: unknown): ParsedSshSig | null {
  if (typeof armored !== 'string' || armored.length > MAX_ARMORED) return null
  const m = ARMOR_RE.exec(armored)
  if (!m) return null
  const blob = decodeBase64Strict(m[1].replace(/\n/g, ''))
  if (!blob) return null
  try {
    const r = new WireReader(blob)
    if (!equalBytes(r.bytesOf(6), MAGIC) || r.u32() !== 1) return null
    const key = decodeSshPublicKey(r.string())
    if (!key.ok) return null
    const namespace = ascii(r.string())
    if (r.string().length !== 0) return null // reserved: empty in every signature ssh-keygen makes
    const hashAlgorithm = ascii(r.string())
    if (hashAlgorithm !== 'sha256' && hashAlgorithm !== 'sha512') return null
    const sr = new WireReader(r.string())
    if (!r.done()) return null
    if (ascii(sr.string()) !== key.key.type) return null // the signature's type must be the key's
    const raw = sr.string()
    if (!sr.done()) return null
    let signature: Uint8Array
    if (key.key.type === 'ssh-ed25519') {
      if (raw.length !== 64) return null
      signature = Uint8Array.from(raw)
    } else {
      const er = new WireReader(raw)
      const rs = [scalar32(er.string()), scalar32(er.string())]
      if (!er.done() || !rs[0] || !rs[1]) return null
      signature = concat([rs[0], rs[1]])
    }
    return { key: key.key, namespace, hashAlgorithm, signature }
  } catch {
    return null
  }
}

/** The exact bytes an SSHSIG signs over `message` (PROTOCOL.sshsig: magic, namespace, reserved, hash name, H(message)). */
export function sshSigSignedData(namespace: string, hashAlgorithm: 'sha256' | 'sha512', message: Uint8Array, crypto: PluginTrustCrypto): Uint8Array {
  const digest = hashAlgorithm === 'sha512' ? crypto.sha512(message) : crypto.sha256(message)
  return concat([MAGIC, sshString(utf8(namespace)), sshString(new Uint8Array(0)), sshString(utf8(hashAlgorithm)), sshString(digest)])
}

/**
 * True only when `armored` is a valid SSHSIG over `message`, made for exactly `namespace` (a
 * root signature is not a list signature) by exactly `expected` (compared by decoded value).
 * Never throws.
 */
export function verifySshSig(armored: unknown, message: Uint8Array, namespace: string, expected: SshPublicKey, crypto: PluginTrustCrypto): boolean {
  const sig = parseSshSig(armored)
  if (!sig) return false
  if (sig.namespace !== namespace) return false
  if (sig.key.identity !== expected.identity) return false
  try {
    return crypto.verify(expected.type, expected.key, sshSigSignedData(sig.namespace, sig.hashAlgorithm, message, crypto), sig.signature) === true
  } catch {
    return false
  }
}

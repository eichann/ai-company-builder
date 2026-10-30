/**
 * Encryption of the secrets the key broker stores (API keys), as envelope
 * encryption (docs: .claude/rules/key-broker.md):
 *
 * - every secret gets its own random data key; the value is encrypted with it
 *   (AES-256-GCM);
 * - the data key is wrapped by the key-encryption key (KEK) and stored next to
 *   the ciphertext, with the id of the KEK that wrapped it.
 *
 * Stage 1 keeps the KEK in a file on the server (adapters/local-secret-cipher.ts).
 * A KMS later replaces only the `KeyWrapper`: `rewrap` re-wraps each data key
 * under the new KEK — the ciphertext is never re-encrypted and nothing is
 * registered again.
 *
 * `context` is bound to both layers (GCM additional data / KMS encryption
 * context): a sealed secret copied to another company or key row does not open.
 * Async because a KMS call is.
 */
export interface SealedSecret {
  /** Envelope format; `env1` = AES-256-GCM value, data key wrapped by `kekId`. */
  scheme: string
  /** base64url */
  ciphertext: string
  /** base64url, 96 bits */
  nonce: string
  /** base64url, 128-bit GCM tag */
  tag: string
  /** The data key as wrapped by the KEK (opaque to callers). */
  wrappedKey: string
  /** Which KEK wrapped it (`local:<fingerprint>`, later `kms:<key id>`). */
  kekId: string
}

export type SecretContext = Record<string, string>

export interface SecretCipher {
  /** The id of the KEK new secrets are wrapped with. */
  readonly kekId: string
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>
  /** Fails (rejects) on another context, another KEK or any tampering. */
  open(sealed: SealedSecret, context: SecretContext): Promise<string>
  /** The same ciphertext with its data key re-wrapped under the current KEK. */
  rewrap(sealed: SealedSecret, context: SecretContext): Promise<SealedSecret>
}

/**
 * The key-encryption key: wraps and unwraps data keys. The local adapter holds
 * a 256-bit key from a file; a KMS adapter would call Encrypt / Decrypt.
 */
export interface KeyWrapper {
  readonly kekId: string
  wrap(dataKey: Uint8Array, context: SecretContext): Promise<string>
  unwrap(wrapped: string, context: SecretContext): Promise<Uint8Array>
}

/**
 * Encryption of secrets the server will store (the API keys of the planned
 * key broker). Async because the production implementation is a KMS call.
 * `context` is bound to the ciphertext (AES-GCM additional data / KMS
 * encryption context): decrypting with a different context fails, so a
 * ciphertext copied to another company or purpose is useless.
 *
 * Nothing uses it yet. adapters/local-secret-cipher.ts is the local
 * implementation; a KMS-backed one plugs in here without touching callers.
 */
export interface SecretCipher {
  encrypt(plaintext: string, context?: Record<string, string>): Promise<string>
  decrypt(ciphertext: string, context?: Record<string, string>): Promise<string>
}

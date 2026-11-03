// The API-key mode's Anthropic key, kept encrypted in config.json
// (`anthropicApiKeyEncrypted`, base64 of the OS-keychain-backed ciphertext the
// shell's SecretBox produces — Electron safeStorage). Only the main process
// decrypts it, and only where it is used (the API-key chat, the one-shots:
// commit messages, voice formatting); the renderer gets `ApiKeyStatus`.
//
// Migration: a plain `anthropicApiKey` (written by app versions before this,
// or by an old version run again later) is encrypted on the first access once
// encryption is available, and the plain field is removed. Old versions
// reading the new config see no key (they ignore the unknown field).
//
// Encryption unavailable (Linux without a keyring; before app ready):
// saving a new key is refused with a message — never stored in plain text. A
// plain key already on disk that cannot be moved into encrypted storage is not
// used either: the API-key mode then behaves as with no key, the status says
// `storedInPlainText` (the settings screen asks to save it again), and one
// tagged warning is logged. The plain field stays on disk and the move is
// retried on every access, so once encryption works (after app ready) the key
// is encrypted and used again.
//
// Never log the key, its length or any part of it.

import type { ApiKeyStatus, SimpleResult } from '../../shared/ipc-contract'
import type { AppConfig, ConfigStore } from './config-store'

/** OS-backed encryption the shell provides (electron-adapter.ts: safeStorage). */
export interface SecretBox {
  /** False when the OS offers no real protection (then nothing is encrypted or saved). */
  available(): boolean
  encrypt(text: string): Buffer
  /** Throws when the data cannot be decrypted (another computer, a reset keychain). */
  decrypt(data: Buffer): string
}

export interface ApiKeyStore {
  /** The key in clear text, for the main process's own use. Undefined when unset or unreadable. */
  read(): string | undefined
  status(): ApiKeyStatus
  /** Store a new key encrypted; an empty key removes it. Refused when encryption is unavailable. */
  save(apiKey: string): SimpleResult
}

export const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'このコンピューターでは APIキーを安全に保存する仕組み（キーチェーン）が使えないため、保存できません。Claude Code などほかの接続方法をお使いください。'

export function createApiKeyStore(config: ConfigStore, box: SecretBox, log: (message: string) => void = () => {}): ApiKeyStore {
  let warnedPlain = false

  /** Encrypt a plain key left by an older version, when possible. Throws when it cannot. */
  function migrate(current: AppConfig): void {
    const plain = current.anthropicApiKey
    if (plain === undefined) return
    if (!box.available()) throw new Error('encryption unavailable')
    if (typeof plain === 'string' && plain.trim()) {
      current.anthropicApiKeyEncrypted = box.encrypt(plain.trim()).toString('base64')
    }
    delete current.anthropicApiKey
    config.save(current)
    log('[api-key] moved the API key into encrypted storage')
  }

  function decrypted(current: AppConfig): string | undefined {
    const stored = current.anthropicApiKeyEncrypted
    if (typeof stored === 'string' && stored) {
      try {
        return box.decrypt(Buffer.from(stored, 'base64')) || undefined
      } catch {
        return undefined
      }
    }
    // A plain key is never used: it is either moved into encrypted storage (migrate) or ignored.
    return undefined
  }

  /** A plain key from an older version that could not be moved into encrypted storage. */
  function plainLeft(current: AppConfig): boolean {
    const plain = current.anthropicApiKey
    return typeof plain === 'string' && !!plain.trim()
  }

  function load(): AppConfig {
    const current = config.load()
    try {
      migrate(current)
    } catch {
      // Encryption or the write failed: the plain key is not used; retried on the next access.
      if (plainLeft(current) && !warnedPlain) {
        warnedPlain = true
        log('[api-key] a plain API key from an older version could not be moved into encrypted storage; not using it until it is saved again')
      }
    }
    return current
  }

  return {
    read: () => decrypted(load()),

    status() {
      const current = load()
      const key = decrypted(current)
      const encryptionAvailable = box.available()
      if (key) return { set: true, last4: key.slice(-4), encryptionAvailable }
      const unreadable = typeof current.anthropicApiKeyEncrypted === 'string' && !!current.anthropicApiKeyEncrypted
      return {
        set: false,
        encryptionAvailable,
        ...(unreadable ? { unreadable: true } : {}),
        ...(plainLeft(current) ? { storedInPlainText: true } : {}),
      }
    },

    save(apiKey) {
      const key = typeof apiKey === 'string' ? apiKey.trim() : ''
      const current = config.load()
      if (!key) {
        delete current.anthropicApiKey
        delete current.anthropicApiKeyEncrypted
        config.save(current)
        return { success: true }
      }
      if (!box.available()) return { success: false, error: ENCRYPTION_UNAVAILABLE_MESSAGE }
      let encrypted: string
      try {
        encrypted = box.encrypt(key).toString('base64')
      } catch {
        return { success: false, error: ENCRYPTION_UNAVAILABLE_MESSAGE }
      }
      current.anthropicApiKeyEncrypted = encrypted
      delete current.anthropicApiKey
      config.save(current)
      return { success: true }
    },
  }
}

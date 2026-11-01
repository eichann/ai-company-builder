/**
 * The key broker's vault: the one place that seals and opens the stored API
 * keys (.claude/rules/key-broker.md).
 *
 * - `seal` is used when an admin registers or replaces a key; the value goes
 *   straight into the cipher and is never kept, returned or logged.
 * - `reveal` is for the relay (K4) only — after it has validated a token —
 *   and is reached by no route. Nothing that answers an HTTP request returns
 *   its result.
 * - `rewrapAll` moves every data key to the current key-encryption key (a new
 *   KEK file, later a KMS) without touching the ciphertext.
 *
 * Without a KEK (BROKER_KEK_FILE unset or unusable) the broker is off: the
 * server runs, `status()` says why, and sealing / revealing refuse.
 */
import type { BrokerCipherState, BrokerKeyRepository, BrokerStatusReason } from '../ports/key-broker'
import type { SealedSecret, SecretContext } from '../ports/secret-cipher'

export interface BrokerVaultDeps {
  brokerKeys: BrokerKeyRepository
  brokerCipher: BrokerCipherState
}

export class BrokerDisabledError extends Error {
  constructor() {
    super('The key broker is off (no key-encryption key)')
    this.name = 'BrokerDisabledError'
  }
}

/** What a sealed key is bound to: copied to another company or row, it does not open. */
export function brokerSecretContext(companyId: string, keyId: string): SecretContext {
  return { purpose: 'acb-broker-key', companyId, keyId }
}

/** A connector secret's binding: what it is, whose company, which row. */
export interface ConnectorSecretContext {
  purpose: 'acb-google-client' | 'acb-google-grant' | 'acb-oauth-pending'
  companyId: string
  /** The row: `google-client`, the grant id, the state hash. */
  id: string
}

function connectorSecretContext(c: ConnectorSecretContext): SecretContext {
  return { purpose: c.purpose, companyId: c.companyId, keyId: c.id }
}

export function createBrokerVault(deps: BrokerVaultDeps) {
  const { brokerKeys, brokerCipher } = deps

  function cipher() {
    if (!brokerCipher.enabled) throw new BrokerDisabledError()
    return brokerCipher.cipher
  }

  return {
    /** On, with the KEK's one-way id; or off, with why (`detail` is for the operator's log). */
    status(): { enabled: true; kekId: string } | { enabled: false; reason: BrokerStatusReason; detail: string } {
      return brokerCipher.enabled
        ? { enabled: true, kekId: brokerCipher.cipher.kekId }
        : { enabled: false, reason: brokerCipher.reason, detail: brokerCipher.detail }
    },

    /** Encrypt a key value for the row `keyId` (not yet written). */
    async seal(companyId: string, keyId: string, secret: string): Promise<SealedSecret> {
      return cipher().seal(secret, brokerSecretContext(companyId, keyId))
    },

    /**
     * The plain value of a stored key, for the relay (K4) to put into the
     * upstream request. null when the key no longer exists. Callers must have
     * validated a token and the key's status; never return or log the result.
     */
    async reveal(companyId: string, keyId: string): Promise<string | null> {
      const sealed = brokerKeys.sealed(companyId, keyId)
      if (!sealed) return null
      return cipher().open(sealed, brokerSecretContext(companyId, keyId))
    },

    /**
     * Connector secrets (google-connector.md): the Google client secret, a
     * member's refresh token, a pending PKCE verifier — sealed under their own
     * purpose and bound to the company and the row, like a key.
     */
    async sealConnector(context: ConnectorSecretContext, secret: string): Promise<SealedSecret> {
      return cipher().seal(secret, connectorSecretContext(context))
    },

    /** Opens a connector secret (the Google client only); never return or log the result. */
    async openConnector(context: ConnectorSecretContext, sealed: SealedSecret): Promise<string> {
      return cipher().open(sealed, connectorSecretContext(context))
    },

    /**
     * Re-wrap every data key not yet under the current KEK (rotation, KMS
     * migration). Keys whose KEK is not loaded are counted as failed and left
     * as they are.
     */
    async rewrapAll(): Promise<{ rewrapped: number; current: number; failed: number }> {
      const c = cipher()
      let rewrapped = 0
      let current = 0
      let failed = 0
      for (const { companyId, keyId, sealed } of brokerKeys.allSealed()) {
        if (sealed.kekId === c.kekId) { current++; continue }
        try {
          const next = await c.rewrap(sealed, brokerSecretContext(companyId, keyId))
          brokerKeys.rewrap(companyId, keyId, next.wrappedKey, next.kekId)
          rewrapped++
        } catch {
          failed++
        }
      }
      return { rewrapped, current, failed }
    },
  }
}

export type BrokerVault = ReturnType<typeof createBrokerVault>

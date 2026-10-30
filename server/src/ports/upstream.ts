/**
 * The key broker relay's way out (.claude/rules/key-broker.md, K4): one HTTPS
 * request to a named host, with the address check done by the adapter after
 * DNS resolution and the connection made to the very address it checked (no
 * second lookup, so no DNS-rebinding window). Never follows redirects.
 *
 * The adapter (adapters/upstream-https.ts) never logs headers or bodies.
 */

export interface UpstreamRequest {
  /** The exact host name (from the key's destinations); TLS is verified against it. */
  host: string
  method: string
  /** Path and query, starting with '/'. */
  path: string
  /** Header name (lower case) → value; already contains the real credential. */
  headers: Record<string, string>
  /** The request body, streamed; null for none. */
  body: AsyncIterable<Uint8Array> | null
  /** Hosts the company allowed to resolve to private addresses (explicit exception). */
  allowPrivateHosts: readonly string[]
  /** Aborts the connection (client gone, time limit). */
  signal: AbortSignal
  /** Until the response headers arrive. */
  headersTimeoutMs: number
}

export type UpstreamFailure =
  /** The host resolved to a private / internal address (and is not an allowed exception). */
  | 'private-address'
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'aborted'

export interface UpstreamResponse {
  status: number
  /** Lower-case names; repeated headers appear more than once. */
  headers: Array<[string, string]>
  body: AsyncIterable<Uint8Array>
  /** The address actually connected to was private (allowed by the company's exception). */
  viaPrivateAddress: boolean
}

export interface UpstreamClient {
  send(request: UpstreamRequest): Promise<{ ok: true; response: UpstreamResponse } | { ok: false; reason: UpstreamFailure }>
}

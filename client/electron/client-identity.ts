/**
 * Tells the ACB server which desktop-app build is talking to it.
 *
 * Every HTTP request to the server API and every git request to the company
 * repository carries:
 *   X-ACB-Client-Version: <semver>+<sha>.<commitDate>   (shared/build-info.ts)
 *   X-ACB-Client-Platform: <os>/<arch>                  e.g. darwin/arm64
 *
 * The server records it per member (server/src/lib/client-activity.ts) so it
 * can refuse operations old builds would misread, and so admins can see when
 * each member last synced.
 */
import type { BuildInfo } from '../shared/build-info'

declare const __ACB_BUILD_INFO__: BuildInfo | undefined

export const CLIENT_VERSION_HEADER = 'X-ACB-Client-Version'
export const CLIENT_PLATFORM_HEADER = 'X-ACB-Client-Platform'

/** Embedded by vite.config.ts; the fallback only applies to unbundled runs (tests). */
export const BUILD_INFO: BuildInfo = typeof __ACB_BUILD_INFO__ !== 'undefined'
  ? __ACB_BUILD_INFO__
  : {
      version: '0.0.0-unbundled+nogit.00000000000000',
      semver: '0.0.0-unbundled',
      sha: 'nogit',
      commitDate: '00000000000000',
      builtAt: new Date(0).toISOString(),
      dev: true,
    }

export function clientPlatform(): string {
  return `${process.platform}/${process.arch}`
}

export function clientIdentityHeaders(): Record<string, string> {
  return {
    [CLIENT_VERSION_HEADER]: BUILD_INFO.version,
    [CLIENT_PLATFORM_HEADER]: clientPlatform(),
  }
}

/**
 * simple-git `config` entries (passed as `-c` to every git invocation) that
 * make git send the identity headers on its HTTP requests to the server.
 */
export function gitIdentityConfig(): string[] {
  return Object.entries(clientIdentityHeaders()).map(([name, value]) => `http.extraHeader=${name}: ${value}`)
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Wrap `target.fetch` so that requests to the ACB server's origin carry the
 * identity headers. One wrapper instead of editing every call site: it also
 * covers call sites added later, in any main-process module. Requests to any
 * other origin pass through untouched, and headers a caller set explicitly
 * are kept.
 */
export function installServerFetchIdentity(
  getServerUrl: () => string,
  target: { fetch: typeof fetch } = globalThis,
): void {
  const original = target.fetch
  if ((original as { acbIdentity?: boolean }).acbIdentity) return
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const serverOrigin = originOf(getServerUrl())
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!serverOrigin || originOf(url) !== serverOrigin) return original(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const [name, value] of Object.entries(clientIdentityHeaders())) {
      if (!headers.has(name)) headers.set(name, value)
    }
    return original(input, { ...init, headers })
  }
  ;(wrapped as { acbIdentity?: boolean }).acbIdentity = true
  target.fetch = wrapped as typeof fetch
}

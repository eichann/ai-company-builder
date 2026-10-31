// The server calls git:sync makes, over fetch with the signed-in session's
// cookies. features/sync/wire.ts wires the real session; tests pass a fake fetch.

import type { SyncServerApi } from './types'
import { parseMyScopes } from './private-folders'
import { fetchCheckPaths } from './path-check'

export interface FetchSyncServerApiOptions {
  /** Server base URL, read on every call (it can change in settings). */
  baseUrl(): string
  /** Session cookies, read on every call (empty when signed out). */
  cookies(): string[]
  fetch?: typeof fetch
}

export function createFetchSyncServerApi(options: FetchSyncServerApiOptions): SyncServerApi {
  const doFetch = (url: string, init?: RequestInit) => (options.fetch ?? fetch)(url, init)
  const optionalCookie = (): Record<string, string> => {
    const cookies = options.cookies()
    return cookies.length > 0 ? { 'Cookie': cookies.join('; ') } : {}
  }

  return {
    async getRepoHttpsUrl(companyId) {
      const repoInfoResponse = await doFetch(`${options.baseUrl()}/api/git/repos/${companyId}`, {
        headers: optionalCookie(),
      })
      if (!repoInfoResponse.ok) return undefined
      const repoInfo = await repoInfoResponse.json()
      return repoInfo.data?.httpsUrl || undefined
    },

    async getCurrentUser() {
      const cookies = options.cookies()
      if (cookies.length === 0) return null
      const response = await doFetch(`${options.baseUrl()}/api/me`, {
        headers: { 'Cookie': cookies.join('; ') },
      })
      if (!response.ok) return null
      const data = await response.json()
      return data.success && data.data ? data.data : null
    },

    async getDepartments(companyId) {
      const deptResponse = await doFetch(`${options.baseUrl()}/api/companies/${companyId}/departments`, {
        headers: optionalCookie(),
      })
      if (!deptResponse.ok) return null
      const deptResult = await deptResponse.json()
      return deptResult.data || []
    },

    checkPaths: fetchCheckPaths({ baseUrl: options.baseUrl, cookies: options.cookies, fetch: options.fetch }),

    async getMyScopes(companyId) {
      const response = await doFetch(`${options.baseUrl()}/api/companies/${encodeURIComponent(companyId)}/me/scopes`, {
        headers: optionalCookie(),
      })
      if (response.status === 404) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null
        return body?.error === 'Company not found or access denied' ? 'not-member' : null
      }
      if (!response.ok) return null
      const body = await response.json()
      return parseMyScopes(body?.data)
    },
  }
}

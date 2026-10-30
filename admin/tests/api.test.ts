import { describe, expect, it, vi } from 'vitest'

import { API_TIMEOUT_MS, ApiError, ApiTimeoutError, apiClient, authApi, invitationsApi, overviewApi } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { COMPANY_ID, ok } from './fixtures'
import { mockApi } from './mock-api'

const base = `/api/companies/${COMPANY_ID}`

// What the admin sends to each endpoint is checked against the real server in
// server/tests/integration/admin-contract.test.ts; these cover the client itself.
describe('API client', () => {
  it('sign-up through an invitation carries X-Invitation-Token (server sign-up guard)', async () => {
    const { calls } = mockApi({ ['POST /api/auth/sign-up/email']: { body: { user: { id: 'u' } } } })
    await authApi.signUp('new@example.com', 'password123', '新人', 'tok_abc')
    expect(calls[0].headers['X-Invitation-Token']).toBe('tok_abc')
    expect(calls[0].body).toEqual({ email: 'new@example.com', password: 'password123', name: '新人' })
  })

  it('first-user sign-up sends no invitation header', async () => {
    const { calls } = mockApi({ ['POST /api/auth/sign-up/email']: { body: { user: { id: 'u' } } } })
    await authApi.signUp('first@example.com', 'password123', '最初')
    expect(calls[0].headers['X-Invitation-Token']).toBeUndefined()
  })

  it('errors keep the HTTP status and server message', async () => {
    mockApi({ [`GET ${base}/overview`]: { status: 403, body: { error: 'Only owners and admins can view the overview' } } })
    const err = await overviewApi.get(COMPANY_ID).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(403)
    expect((err as ApiError).message).toMatch(/owners and admins/)
  })

  it('an empty answer (204, a proxy\'s empty error) is not mistaken for a broken page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(apiClient('/api/x', { method: 'DELETE' })).resolves.toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    const err = await apiClient('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(502)
    expect(describeError(err)).toMatch(/サーバーでエラーが発生しました/)
  })

  it('a server that never answers is given up on with a plain message, not an endless spinner', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })))
      const result = apiClient('/api/slow').catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS)
      const err = await result
      expect(err).toBeInstanceOf(ApiTimeoutError)
      expect(describeError(err)).toBe('サーバーから応答がありません。少し待ってからもう一度お試しください。')
    } finally {
      vi.useRealTimers()
    }
  })

  it('path segments are URL-encoded', async () => {
    const { calls } = mockApi({ [`GET /api/invitations/a/b`]: { body: ok({}) } })
    await invitationsApi.validate('a/b').catch(() => {})
    expect(calls[0].url).toBe('/api/invitations/a%2Fb')
  })
})

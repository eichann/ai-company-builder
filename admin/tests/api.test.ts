import { describe, expect, it } from 'vitest'

import { ApiError, authApi, invitationsApi, overviewApi } from '@/lib/api'
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

  it('path segments are URL-encoded', async () => {
    const { calls } = mockApi({ [`GET /api/invitations/a/b`]: { body: ok({}) } })
    await invitationsApi.validate('a/b').catch(() => {})
    expect(calls[0].url).toBe('/api/invitations/a%2Fb')
  })
})

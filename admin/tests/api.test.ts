import { describe, expect, it } from 'vitest'

import {
  ApiError,
  authApi,
  capabilitiesApi,
  departmentsApi,
  invitationsApi,
  overviewApi,
  permissionsApi,
} from '@/lib/api'
import {
  COMPANY_ID,
  busyOverview,
  invitations,
  managerCapabilities,
  managers,
  ok,
  permissionScopes,
} from './fixtures'
import { mockApi } from './mock-api'

const base = `/api/companies/${COMPANY_ID}`

describe('API client (contract)', () => {
  it('GET overview unwraps { success, data }', async () => {
    const { calls } = mockApi({ [`GET ${base}/overview`]: { body: ok(busyOverview) } })
    const data = await overviewApi.get(COMPANY_ID)
    expect(data.attention.recentRejections[0].marker).toBe('PROTECTED_CONFIG')
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${base}/overview` })
  })

  it('GET permissions returns scopes in tree order', async () => {
    mockApi({ [`GET ${base}/permissions`]: { body: ok({ scopes: permissionScopes }) } })
    const data = await permissionsApi.get(COMPANY_ID)
    expect(data.scopes.map((s) => s.path)).toEqual(['', '営業部', '営業部/契約書', 'development'])
  })

  it('GET / PUT department managers', async () => {
    const { calls } = mockApi({
      [`GET ${base}/departments/d_sales/managers`]: { body: ok({ managers: managers.d_sales }) },
      [`PUT ${base}/departments/d_sales/managers`]: { body: ok({ managers: [] }) },
    })
    expect((await departmentsApi.getManagers(COMPANY_ID, 'd_sales')).managers).toHaveLength(1)
    await departmentsApi.setManagers(COMPANY_ID, 'd_sales', ['u_admin', 'u_member'])
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { userIds: ['u_admin', 'u_member'] } })
  })

  it('GET me/capabilities', async () => {
    mockApi({ [`GET ${base}/me/capabilities`]: { body: ok(managerCapabilities) } })
    expect(await capabilitiesApi.get(COMPANY_ID)).toEqual({ role: 'member', managedDepartmentIds: ['d_sales'] })
  })

  it('reorder posts { items }', async () => {
    const { calls } = mockApi({ [`POST ${base}/departments/reorder`]: { body: { success: true } } })
    await departmentsApi.reorder(COMPANY_ID, [
      { id: 'd_dev', sortOrder: 0 },
      { id: 'd_sales', sortOrder: 1 },
    ])
    expect(calls[0].body).toEqual({ items: [{ id: 'd_dev', sortOrder: 0 }, { id: 'd_sales', sortOrder: 1 }] })
  })

  it('invitation create sends role and expiry; list unwraps', async () => {
    const { calls } = mockApi({
      [`POST ${base}/invitations`]: { status: 201, body: ok(invitations[0]) },
      [`GET ${base}/invitations`]: { body: ok(invitations) },
    })
    await invitationsApi.create(COMPANY_ID, 'admin', 30)
    expect(calls[0].body).toEqual({ role: 'admin', expiresInDays: 30 })
    expect(await invitationsApi.list(COMPANY_ID)).toHaveLength(1)
  })

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

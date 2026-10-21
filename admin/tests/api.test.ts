import { describe, expect, it } from 'vitest'

import {
  ApiError,
  authApi,
  capabilitiesApi,
  companiesApi,
  departmentsApi,
  invitationsApi,
  overviewApi,
  permissionsApi,
  pushRejectionsApi,
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

  it('permission rule writes: methods, paths and bodies (read is never sent)', async () => {
    const { calls } = mockApi({
      [`POST ${base}/permissions/rules`]: { status: 201, body: ok({ scope: null, rules: [] }) },
      [`PATCH ${base}/permissions/rules/r 1`]: { body: ok({ scope: null, rules: [] }) },
      [`DELETE ${base}/permissions/rules/r 1`]: { body: ok({ scope: null, rules: [] }) },
      [`DELETE ${base}/permissions/scopes/s_1/rules`]: { body: ok({ removed: 2 }) },
      [`GET ${base}/permissions/effective?path=営業部/契約書`]: { body: ok({ path: '営業部/契約書', members: [] }) },
      [`GET ${base}/permissions/folders?path=`]: { body: ok({ path: '', folders: [] }) },
    })
    await permissionsApi.setRule(COMPANY_ID, '営業部', { subjectType: 'user', subjectId: 'u_member' }, false)
    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: '営業部', subjectType: 'user', subjectId: 'u_member', canWrite: false } })
    expect(calls[0].body).not.toHaveProperty('canRead')
    await permissionsApi.updateRule(COMPANY_ID, 'r 1', true)
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: `${base}/permissions/rules/r%201`, body: { canWrite: true } })
    await permissionsApi.deleteRule(COMPANY_ID, 'r 1')
    expect((await permissionsApi.resetScope(COMPANY_ID, 's_1')).removed).toBe(2)
    await permissionsApi.effective(COMPANY_ID, '営業部/契約書')
    expect(calls[4].url).toBe(`${base}/permissions/effective?path=${encodeURIComponent('営業部/契約書')}`)
    await permissionsApi.folders(COMPANY_ID, '')
    expect(calls[5].url).toBe(`${base}/permissions/folders?path=`)
  })

  it('replaceScope sends the whole rule set for one path', async () => {
    const { calls } = mockApi({ [`PUT ${base}/permissions/scopes/by-path`]: { body: ok({ scope: null, rules: [] }) } })
    await permissionsApi.replaceScope(COMPANY_ID, '営業部/契約書', [
      { subjectType: 'everyone', subjectId: null, canWrite: false },
      { subjectType: 'user', subjectId: 'u_member', canWrite: true },
    ])
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `${base}/permissions/scopes/by-path`,
      body: {
        path: '営業部/契約書',
        rules: [
          { subjectType: 'everyone', subjectId: null, canWrite: false },
          { subjectType: 'user', subjectId: 'u_member', canWrite: true },
        ],
      },
    })
  })

  it('push rejections pass filters as query parameters', async () => {
    const { calls } = mockApi({
      [`GET ${base}/push-rejections`]: { body: ok({ total: 0, markers: [], rejections: [] }) },
      [`GET ${base}/push-rejections?userId=u_member&marker=SECRET_DETECTED&limit=10&offset=20`]: { body: ok({ total: 0, markers: [], rejections: [] }) },
    })
    await pushRejectionsApi.list(COMPANY_ID)
    await pushRejectionsApi.list(COMPANY_ID, { userId: 'u_member', marker: 'SECRET_DETECTED', limit: 10, offset: 20 })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET'])
  })

  it('rename and role change', async () => {
    const { calls } = mockApi({
      [`PATCH ${base}`]: { body: ok({ id: COMPANY_ID, name: '新' }) },
      [`PUT ${base}/members/u_member/role`]: { body: ok({ userId: 'u_member', companyId: COMPANY_ID, role: 'admin' }) },
    })
    await companiesApi.rename(COMPANY_ID, '新')
    await companiesApi.setMemberRole(COMPANY_ID, 'u_member', 'admin')
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { name: '新' } })
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { role: 'admin' } })
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

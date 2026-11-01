/**
 * Role resolution (`.claude/rules/connector-roles.md`): the core app asks for
 * a role and gets the one connector that serves it in the company now — never
 * a stopped one, never a guess between two, never another company's choice.
 */
import { describe, expect, it } from 'vitest'
import { hasRoleCapability, resolveRole, roleServingProblems, type ConnectorRole, type RoleServing } from '../../shared/core/connector-roles'
import type { ConnectorRoleChoiceRepository, RoleConnector } from '../../src/ports/connector-roles'
import { createConnectorRoles } from '../../src/services/connector-roles'

const GOOGLE: RoleServing[] = [
  { role: 'calendar', operations: ['read'], capabilities: [] },
  { role: 'mail', operations: ['read', 'send'], capabilities: [] },
  { role: 'meetings', operations: ['read'], capabilities: ['transcript'] },
]
const MS365: RoleServing[] = [
  { role: 'calendar', operations: ['read'], capabilities: [] },
  { role: 'mail', operations: ['send'], capabilities: [] },
  { role: 'meetings', operations: ['read'], capabilities: ['attendees'] },
]
const SLACK: RoleServing[] = [{ role: 'chat', operations: ['receive', 'reply'], capabilities: [] }]

function memoryChoices(): ConnectorRoleChoiceRepository {
  const rows = new Map<string, string>()
  return {
    choice: (companyId, role) => rows.get(`${companyId}/${role}`) ?? null,
    setChoice: (companyId, role, connectorId) => {
      if (connectorId === null) rows.delete(`${companyId}/${role}`)
      else rows.set(`${companyId}/${role}`, connectorId)
    },
  }
}

function setup(usable: Record<string, Set<string>>) {
  const roles = createConnectorRoles({ choices: memoryChoices(), clock: { now: () => '2026-11-01T00:00:00.000Z', nowMs: () => 0 } })
  const connector = (id: string, servings: RoleServing[]): RoleConnector => ({ id, servings, usable: async c => usable[id]?.has(c) ?? false })
  roles.register(connector('google', GOOGLE))
  roles.register(connector('microsoft365', MS365))
  roles.register(connector('slack', SLACK))
  return roles
}

describe('core roles: which connector serves a role', () => {
  it('a role served by one usable connector resolves to it, with its capabilities', async () => {
    const roles = setup({ google: new Set(['c1']), slack: new Set(['c1']) })
    const meetings = await roles.resolve('c1', 'meetings', 'read')
    expect(meetings).toEqual({ ok: true, connectorId: 'google', capabilities: ['transcript'] })
    expect(hasRoleCapability(meetings, 'transcript')).toBe(true)
    expect(hasRoleCapability(meetings, 'attendees')).toBe(false)
    expect(await roles.resolve('c1', 'chat', 'reply')).toMatchObject({ ok: true, connectorId: 'slack' })
  })

  it('a connector that is off or stopped never serves (from the next call)', async () => {
    const on = new Set(['c1'])
    const roles = setup({ google: on })
    expect(await roles.resolve('c1', 'calendar')).toMatchObject({ ok: true, connectorId: 'google' })
    on.delete('c1')
    expect(await roles.resolve('c1', 'calendar')).toEqual({ ok: false, reason: 'none' })
  })

  it('a connector whose switch check throws counts as not usable', async () => {
    const roles = createConnectorRoles({ choices: memoryChoices(), clock: { now: () => '', nowMs: () => 0 } })
    roles.register({ id: 'google', servings: GOOGLE, usable: async () => { throw new Error('db down') } })
    expect(await roles.resolve('c1', 'calendar')).toEqual({ ok: false, reason: 'none' })
  })

  it('two usable connectors: never a guess — the admin\'s choice decides', async () => {
    const roles = setup({ google: new Set(['c1']), microsoft365: new Set(['c1']) })
    expect(await roles.resolve('c1', 'calendar')).toEqual({ ok: false, reason: 'choice-needed', candidates: ['google', 'microsoft365'] })
    expect(roles.choose('c1', 'calendar', 'microsoft365', 'admin-1')).toMatchObject({ ok: true })
    expect(await roles.resolve('c1', 'calendar')).toMatchObject({ ok: true, connectorId: 'microsoft365' })
    // The choice is per role: meetings still needs its own.
    expect(await roles.resolve('c1', 'meetings')).toMatchObject({ ok: false, reason: 'choice-needed' })
  })

  it('an operation only one of the two can do resolves to that one without a choice', async () => {
    const roles = setup({ google: new Set(['c1']), microsoft365: new Set(['c1']) })
    expect(await roles.resolve('c1', 'mail', 'read')).toMatchObject({ ok: true, connectorId: 'google' })
  })

  it('a chosen connector that is switched off is not replaced by a guess while two remain', () => {
    const candidates = [
      { connectorId: 'a', servings: GOOGLE, usable: true },
      { connectorId: 'b', servings: GOOGLE, usable: true },
      { connectorId: 'c', servings: GOOGLE, usable: false },
    ]
    expect(resolveRole('calendar', null, candidates, 'c')).toEqual({ ok: false, reason: 'choice-needed', candidates: ['a', 'b'] })
    // One usable left: it serves whatever the old choice said.
    expect(resolveRole('calendar', null, candidates.slice(1), 'c')).toMatchObject({ ok: true, connectorId: 'b' })
  })

  it('one company\'s choice never decides for another company', async () => {
    const both = new Set(['c1', 'c2'])
    const roles = setup({ google: both, microsoft365: both })
    roles.choose('c1', 'calendar', 'google', 'admin-1')
    expect(await roles.resolve('c1', 'calendar')).toMatchObject({ ok: true, connectorId: 'google' })
    expect(await roles.resolve('c2', 'calendar')).toMatchObject({ ok: false, reason: 'choice-needed' })
  })

  it('a connector usable in another company only does not serve this one', async () => {
    const roles = setup({ google: new Set(['c2']) })
    expect(await roles.resolve('c1', 'calendar')).toEqual({ ok: false, reason: 'none' })
  })

  it('only a registered connector that declares the role can be chosen', () => {
    const roles = setup({})
    expect(roles.choose('c1', 'chat', 'google', 'admin-1')).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(roles.choose('c1', 'calendar', 'zoom', 'admin-1')).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(roles.choose('c1', 'drive', 'google', 'admin-1')).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(roles.choose('c1', 'calendar', null, 'admin-1')).toMatchObject({ ok: true })
  })

  it('the admin view lists each role\'s usable candidates and the resolution', async () => {
    const roles = setup({ google: new Set(['c1']), slack: new Set(['c1']) })
    const views = await roles.views('c1')
    expect(views.map(v => v.role)).toEqual(['calendar', 'mail', 'meetings', 'chat'])
    expect(views.find(v => v.role === 'calendar')).toMatchObject({ candidates: ['google'], resolution: { ok: true, connectorId: 'google' } })
    expect(views.find(v => v.role === 'chat')).toMatchObject({ candidates: ['slack'] })
  })
})

describe('core roles: declarations', () => {
  it('Drive is not a role, and unknown operations or capabilities are refused at registration', () => {
    const bad = (s: Partial<RoleServing> & { role: string }) => roleServingProblems([{ operations: ['read'], capabilities: [], ...s } as RoleServing])
    expect(bad({ role: 'drive' })).not.toEqual([])
    expect(bad({ role: 'calendar', operations: ['write'] })).not.toEqual([])
    expect(bad({ role: 'mail', capabilities: ['transcript'] })).not.toEqual([])
    expect(bad({ role: 'chat', operations: [] })).not.toEqual([])
    expect(roleServingProblems([...GOOGLE, ...SLACK])).toEqual([])
    expect(roleServingProblems([GOOGLE[0], GOOGLE[0]])).not.toEqual([])

    const roles = createConnectorRoles({ choices: memoryChoices(), clock: { now: () => '', nowMs: () => 0 } })
    expect(() => roles.register({ id: 'x', servings: [{ role: 'drive' as ConnectorRole, operations: ['read'], capabilities: [] }], usable: async () => true })).toThrow()
    roles.register({ id: 'google', servings: GOOGLE, usable: async () => true })
    expect(() => roles.register({ id: 'google', servings: GOOGLE, usable: async () => true })).toThrow()
  })
})

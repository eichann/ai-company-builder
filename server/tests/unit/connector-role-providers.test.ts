/**
 * The routed role ports (`.claude/rules/connector-roles.md` "Role providers"):
 * a core service's call reaches the implementation of the connector that serves
 * the role in that company now — the admin's choice between two, never a guess,
 * never a connector that is off — and no usable connector is an answer in the
 * role's own terms (nothing is called).
 */
import { describe, expect, it } from 'vitest'
import type { RoleServing } from '../../shared/core/connector-roles'
import type { ConnectorRoleChoiceRepository } from '../../src/ports/connector-roles'
import type { MailReader, MailSender } from '../../src/ports/mail'
import { MeetingReadFailed, type MeetingRecordsReader } from '../../src/ports/meeting-records'
import { createConnectorRoles } from '../../src/services/connector-roles'
import { createRoleProviders } from '../../src/services/connector-role-providers'

const MAIL_AND_CAL: RoleServing[] = [
  { role: 'calendar', operations: ['read'], capabilities: [] },
  { role: 'mail', operations: ['read', 'send'], capabilities: [] },
  { role: 'meetings', operations: ['read'], capabilities: [] },
]

function setup(usable: Record<string, boolean>) {
  const rows = new Map<string, string>()
  const choices: ConnectorRoleChoiceRepository = {
    choice: (c, role) => rows.get(`${c}/${role}`) ?? null,
    setChoice: (c, role, id) => { if (id) rows.set(`${c}/${role}`, id); else rows.delete(`${c}/${role}`) },
  }
  const roles = createConnectorRoles({ choices, clock: { now: () => '2026-11-01T00:00:00.000Z', nowMs: () => 0 } })
  const calls: string[] = []
  const impl = (id: string) => ({
    calendar: { eventsBetween: async () => { calls.push(`${id}:calendar`); return { ok: true as const, events: [] } } },
    mailReader: {
      listMessages: async () => { calls.push(`${id}:list`); return { ok: true as const, value: { messages: [], nextPageToken: null } } },
      getMessage: async () => { calls.push(`${id}:get`); return { ok: false as const, reason: 'not-found' as const } },
    } satisfies MailReader,
    mailSender: {
      senderAccount: async () => { calls.push(`${id}:account`); return { ok: true as const, account: `${id}@x.example` } },
      send: async () => { calls.push(`${id}:send`); return { ok: true as const, status: 200, json: {} } },
    } satisfies MailSender,
    meetings: {
      meetEvents: async () => { calls.push(`${id}:meetings`); return [] },
      event: async () => null, conferenceFor: async () => null, documents: async () => [], docVersion: async () => '1', docText: async () => ({ text: '', truncated: false }),
    } satisfies MeetingRecordsReader,
  })
  for (const id of ['google', 'microsoft365']) roles.register({ id, servings: MAIL_AND_CAL, usable: async () => usable[id] ?? false })
  const providers = createRoleProviders(roles, { google: impl('google'), microsoft365: impl('microsoft365') })
  return { roles, providers, calls, usable }
}

describe('routed role ports', () => {
  it('a call reaches the one usable connector serving the role', async () => {
    const { providers, calls } = setup({ google: true })
    await providers.calendar.eventsBetween('c1', 'u1', 0, 1)
    await providers.mailReader.listMessages('c1', 'u1', { afterMs: 0 })
    expect(await providers.mailSender.senderAccount('c1', 'u1')).toEqual({ ok: true, account: 'google@x.example' })
    await providers.meetings.meetEvents('c1', 'u1', new Date(0), new Date(1))
    expect(calls).toEqual(['google:calendar', 'google:list', 'google:account', 'google:meetings'])
  })

  it('no usable connector: an answer in the role\'s terms, and nothing is called', async () => {
    const { providers, calls } = setup({})
    expect(await providers.calendar.eventsBetween('c1', 'u1', 0, 1)).toEqual({ ok: false, reason: 'stopped' })
    expect(await providers.mailReader.getMessage('c1', 'u1', 'm1')).toEqual({ ok: false, reason: 'stopped' })
    expect(await providers.mailSender.senderAccount('c1', 'u1')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await providers.mailSender.send('c1', 'u1', 'raw')).toMatchObject({ ok: false, kind: 'not-sent', reason: 'no-connector' })
    await expect(providers.meetings.meetEvents('c1', 'u1', new Date(0), new Date(1))).rejects.toBeInstanceOf(MeetingReadFailed)
    expect(calls).toEqual([])
  })

  it('two usable connectors: nothing until the admin chooses, then only the chosen one', async () => {
    const { roles, providers, calls, usable } = setup({ google: true, microsoft365: true })
    expect(await providers.mailSender.send('c1', 'u1', 'raw')).toMatchObject({ ok: false, reason: 'choice-needed' })
    expect(await providers.mailReader.listMessages('c1', 'u1', { afterMs: 0 })).toEqual({ ok: false, reason: 'choice-needed' })
    expect(calls).toEqual([])
    expect(roles.choose('c1', 'mail', 'microsoft365', 'admin').ok).toBe(true)
    await providers.mailSender.send('c1', 'u1', 'raw')
    await providers.mailReader.listMessages('c1', 'u1', { afterMs: 0 })
    expect(calls).toEqual(['microsoft365:send', 'microsoft365:list'])
    // The choice is per company; with the chosen one switched off, the only one left serves.
    expect(await providers.mailSender.send('c2', 'u1', 'raw')).toMatchObject({ ok: false, reason: 'choice-needed' })
    usable.microsoft365 = false
    await providers.mailSender.send('c1', 'u1', 'raw')
    expect(calls.at(-1)).toBe('google:send')
  })
})

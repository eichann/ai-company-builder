/**
 * Notification mails of connected services (owner FB #18, `.claude/rules/inbox.md`
 * "Notification mails of connected services"): the sender match is by whole
 * address or `@domain` (a person of the service's domain stays a person), the
 * Sender header only where an entry asks for it; a connector plugin declares its
 * own senders (`notification_senders`), and only an installed, on, unchanged and
 * not-stopped connector's count. The inbox's use of it: inbox.test.ts.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../../shared/core/plugin-manifest'
import {
  BUILTIN_NOTIFICATION_SENDERS, notificationServiceOf, parseNotificationSender, type ConnectedNotifier,
} from '../../../shared/core/notification-senders'
import { pluginNotifiersOf } from '../../src/composition/inbox'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { PluginInstallRow } from '../../src/ports/plugins'

const google: ConnectedNotifier[] = BUILTIN_NOTIFICATION_SENDERS.google.map(e => ({ service: e.service, from: e.from, sender: e.sender }))

describe('the sender match', () => {
  it('Google\'s notification senders by address; a person at google.com, or one who only names Google, is not one', () => {
    expect(notificationServiceOf({ from: 'Gemini-Notes@Google.com' }, google)).toBe('google_meet')
    expect(notificationServiceOf({ from: 'meetings-noreply@google.com' }, google)).toBe('google_meet')
    expect(notificationServiceOf({ from: 'calendar-notification@google.com' }, google)).toBe('google_calendar')
    expect(notificationServiceOf({ from: 'sundar@google.com' }, google)).toBeNull()
    expect(notificationServiceOf({ from: 'gemini-notes@google.com.example' }, google)).toBeNull()
  })

  it('an invitation "via Google Calendar" by its Sender; Sender counts only where the entry says so', () => {
    expect(notificationServiceOf({ from: 'tanaka@client.example', sender: 'calendar-notification@google.com' }, google)).toBe('google_calendar')
    expect(notificationServiceOf({ from: 'tanaka@client.example', sender: 'gemini-notes@google.com' }, google)).toBeNull()
    const plugin: ConnectedNotifier[] = [{ service: 'plugin:x', from: ['@hubspot.com'], sender: [] }]
    // A salesperson's mail sent through HubSpot is still theirs.
    expect(notificationServiceOf({ from: 'rep@vendor.example', sender: 'bounce@hubspot.com' }, plugin)).toBeNull()
    expect(notificationServiceOf({ from: 'noreply@notifications.hubspot.com' }, plugin)).toBe('plugin:x')
  })

  it('entries are an address or @domain; a bare domain or junk is refused', () => {
    expect(parseNotificationSender(' Notification@Slack.com ')).toBe('notification@slack.com')
    expect(parseNotificationSender('@Notifications.HubSpot.com')).toBe('@notifications.hubspot.com')
    for (const bad of ['hubspot.com', '@', '@localhost', 'a b@x.com', 3, null]) expect(parseNotificationSender(bad)).toBeNull()
  })
})

describe('a connector plugin declares its senders', () => {
  const hub = readFileSync(join(__dirname, '../fixtures/plugins/sample-hub/plugin.yaml'), 'utf8')

  it('notification_senders is optional, parsed and checked', () => {
    const plain = parsePluginManifest(hub)
    expect(plain.ok && plain.value.notificationSenders).toBeUndefined()
    const declared = parsePluginManifest(`${hub}\nnotification_senders: ["@Notifications.HubSpot.com", noreply@hubspot.com]\n`)
    expect(declared.ok && declared.value.notificationSenders).toEqual(['@notifications.hubspot.com', 'noreply@hubspot.com'])
    const bad = parsePluginManifest(`${hub}\nnotification_senders: [hubspot.com]\n`)
    expect(bad.ok).toBe(false)
  })

  it('counted only while the company has it installed, on, unchanged and not stopped', async () => {
    const parsed = parsePluginManifest(`${hub}\nnotification_senders: ["@hubspot.com"]\n`)
    if (!parsed.ok) throw new Error(parsed.errors.join())
    const install = (over: Partial<PluginInstallRow> = {}): PluginInstallRow => ({
      pluginId: 'sample-hub', version: parsed.value.version, fingerprint: 'fp', service: 'hubspot', connectionId: 'c', accountId: null,
      enabled: true, managedSince: null, keyId: null, mappingVersion: 0, updatedAt: '', updatedBy: '', ...over,
    })
    let installs = [install()]
    let stopped = false
    const companyData = { forCompany: () => ({ plugins: { installs: () => installs } }) } as unknown as CompanyDataSource
    const shelf = {
      find: (_co: string, id: string) => (id === 'sample-hub' ? { pkg: { manifest: parsed.value }, fingerprint: 'fp' } : null),
      isStopped: async () => stopped,
    } as unknown as Parameters<typeof pluginNotifiersOf>[1]
    const of = pluginNotifiersOf(companyData, shelf)
    expect(await of('a')).toEqual([{ service: 'plugin:sample-hub', from: ['@hubspot.com'], sender: [] }])
    installs = [install({ enabled: false })]
    expect(await of('a')).toEqual([])
    installs = [install({ fingerprint: 'changed' })]
    expect(await of('a')).toEqual([])
    installs = [install()]
    stopped = true
    expect(await of('a')).toEqual([])
    installs = []
    stopped = false
    expect(await of('a')).toEqual([])
  })
})

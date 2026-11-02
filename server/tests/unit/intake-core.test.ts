/**
 * The inbox's pure rules (`.claude/rules/inbox.md`): the company's intake
 * settings (shared/core/intake-settings.ts), the routing of one message, the
 * connection window, and the core types the inbox writes
 * (interaction v5, reply_request v1, task v8 in shared/core/core-types.ts).
 *
 * Guards: settings validate (free mail is never an internal domain, an
 * address once, a folder required) and default to the owner's decisions;
 * routing's order (spam, internal, To, bulk, shared, CC); 7 days are read
 * back and the 8th is a gap; the new versions only add (records made before
 * stay valid); only the 返事のお願い lets the AI end it, a task never.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTAKE_SETTINGS, defaultIntakeSettings, parseIntakeSettings, pollWindow, routeIncoming, type RouteInput,
} from '../../../shared/core/intake-settings'
import { coreTypeDefinitions, SERVICE_OWNED_TYPES, SERVICE_STATE_TYPES } from '../../../shared/core/core-types'
import { compareTypeDefinitions, parseTypeFile, type TypeDefinition } from '../../../shared/core/record-types'
import { INTERACTION_V4_TEXT, REPLY_REQUEST_V1_TEXT, TASK_V7_TEXT } from '../helpers/core-types-before-inbox'

const def = (name: string) => coreTypeDefinitions().find(d => d.name === name) as TypeDefinition
const parsed = (name: string, text: string) => {
  const r = parseTypeFile(name, text)
  if (!r.ok) throw new Error(r.errors.join())
  return r.definition
}

describe('intake settings', () => {
  it('defaults are the owner\'s decisions; a partial document keeps the rest', () => {
    expect(DEFAULT_INTAKE_SETTINGS).toMatchObject({ multipleTo: 'first', ccOnly: 'nothing', memberReply: 'ai_checks', excludeInternal: true, excludeBulk: true })
    const r = parseIntakeSettings({ ccOnly: 'unsure' })
    expect(r).toEqual({ value: { ...defaultIntakeSettings(), ccOnly: 'unsure' } })
  })

  it('refuses unknown rules, free-mail internal domains, an address twice and a shared address without a folder', () => {
    expect('error' in parseIntakeSettings(null)).toBe(true)
    expect('error' in parseIntakeSettings({ multipleTo: 'all' })).toBe(true)
    expect('error' in parseIntakeSettings({ excludeBulk: 'yes' })).toBe(true)
    expect('error' in parseIntakeSettings({ internalDomains: ['gmail.com'] })).toBe(true)
    expect('error' in parseIntakeSettings({ internalDomains: ['docomo.ne.jp'] })).toBe(true)
    expect('error' in parseIntakeSettings({ sharedAddresses: [{ address: 'info@a.example', folder: '営業部' }, { address: 'INFO@a.example', folder: '総務' }] })).toBe(true)
    expect('error' in parseIntakeSettings({ sharedAddresses: [{ address: 'info@a.example', folder: '' }] })).toBe(true)
    expect(parseIntakeSettings({ internalDomains: ['@WWW.Group.example'], sharedAddresses: [{ address: 'Info@A.example', folder: '/営業部/' }] }))
      .toEqual({ value: { ...defaultIntakeSettings(), internalDomains: ['group.example'], sharedAddresses: [{ address: 'info@a.example', folder: '営業部' }] } })
  })
})

describe('routing one message', () => {
  const base = (over: Partial<RouteInput> = {}): RouteInput => ({
    from: { address: 'tanaka@client.example', memberId: null },
    to: [{ address: 'alice@acme.example', memberId: 'u-alice' }],
    cc: [], reporterId: 'u-alice', bulk: false, automated: false, spam: false, internalDomains: ['acme.example'], ...over,
  })
  const s = defaultIntakeSettings()

  it('spam and internal first, then To, then bulk', () => {
    expect(routeIncoming(s, base({ spam: true }))).toEqual({ kind: 'skip', why: 'spam' })
    expect(routeIncoming(s, base({ from: { address: 'x@acme.example', memberId: null } }))).toEqual({ kind: 'skip', why: 'internal' })
    expect(routeIncoming(s, base({ from: { address: 'U123', memberId: 'u-bob' } }))).toEqual({ kind: 'skip', why: 'internal' })
    expect(routeIncoming(s, base())).toEqual({ kind: 'member', owner: 'u-alice', state: 'received', reason: 'to' })
    expect(routeIncoming(s, base({ bulk: true }))).toEqual({ kind: 'member', owner: 'u-alice', state: 'excluded', reason: 'bulk' })
    expect(routeIncoming({ ...s, excludeBulk: false }, base({ automated: true }))).toMatchObject({ state: 'received' })
  })

  it('CC is told nothing when someone is in To, and nothing at all by default', () => {
    const cc = [{ address: 'bob@acme.example', memberId: 'u-bob' }]
    expect(routeIncoming(s, base({ cc, reporterId: 'u-bob' }))).toMatchObject({ owner: 'u-alice' })
    const ccOnly = base({ to: [{ address: 'p@partner.example', memberId: null }], cc, reporterId: 'u-bob' })
    expect(routeIncoming(s, ccOnly)).toEqual({ kind: 'skip', why: 'cc' })
    expect(routeIncoming({ ...s, ccOnly: 'unsure' }, ccOnly)).toEqual({ kind: 'member', owner: 'u-bob', state: 'unsure', reason: 'cc' })
    // The setting never makes someone else's CC the reporter's.
    expect(routeIncoming({ ...s, ccOnly: 'unsure' }, { ...ccOnly, reporterId: 'u-carol' })).toEqual({ kind: 'skip', why: 'cc' })
  })

  it('a shared address is the department\'s, unless a member is in To; a newsletter to it is nobody\'s', () => {
    const shared = { ...s, sharedAddresses: [{ address: 'info@acme.example', folder: '営業部' }] }
    const toInfo = base({ to: [{ address: 'info@acme.example', memberId: null }] })
    expect(routeIncoming(shared, toInfo)).toEqual({ kind: 'department', folder: '営業部', reason: 'shared' })
    expect(routeIncoming(shared, { ...toInfo, bulk: true })).toEqual({ kind: 'skip', why: 'bulk' })
    expect(routeIncoming(shared, base({ cc: [{ address: 'info@acme.example', memberId: null }] }))).toMatchObject({ kind: 'member', owner: 'u-alice' })
  })
})

describe('the connection window', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z')
  it('7 days back are read again; from the 8th day the rest is a gap', () => {
    expect(pollWindow('2026-11-08T00:00:00.000Z', now)).toEqual({ from: '2026-11-08T00:00:00.000Z', gap: null })
    expect(pollWindow('2026-11-07T00:00:00.000Z', now)).toEqual({ from: '2026-11-08T00:00:00.000Z', gap: { from: '2026-11-07T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z' } })
  })
})

describe('the core types the inbox writes', () => {
  it('interaction 5 and task 8 only add to what was there', () => {
    for (const [name, before] of [['interaction', INTERACTION_V4_TEXT], ['task', TASK_V7_TEXT]] as const) {
      const change = compareTypeDefinitions(parsed(name, before), def(name))
      expect(change.breaking).toEqual([])
      expect(change.versionProblem).toBeNull()
    }
    expect(def('interaction').version).toBe(5)
    expect(def('interaction').fields.channel.options).toContain('chat')
    expect(def('task').version).toBeGreaterThanOrEqual(8)
    expect(def('task').links.interaction.target).toBe('interaction')
  })

  it('a 返事のお願い: made by the inbox only, a request with end conditions, and the one type whose AI may end it', () => {
    const rr = def('reply_request')
    // Version 2 (B4) only adds 「もう返した」 (a reply ACB cannot see: the phone, another channel).
    expect(rr.version).toBe(2)
    const change = compareTypeDefinitions(parsed('reply_request', REPLY_REQUEST_V1_TEXT), rr)
    expect(change.breaking).toEqual([])
    expect(change.versionProblem).toBeNull()
    expect(rr.actions.replied_elsewhere).toMatchObject({ to: 'closed', who: ['assignee'] })
    expect([...rr.implements].sort()).toEqual(['outside_event', 'prepared', 'request'])
    expect(SERVICE_OWNED_TYPES).toContain('reply_request')
    expect(SERVICE_STATE_TYPES).not.toContain('reply_request')
    expect(rr.fields.end_condition.kind).toBe('long_text')
    const aiEnds = (d: TypeDefinition) => Object.entries(d.actions)
      .filter(([, a]) => a.who.includes('ai') && a.to !== null && d.final.includes(a.to)).map(([n]) => n)
    expect(aiEnds(rr)).toEqual(['ai_close'])
    expect(aiEnds(def('task'))).toEqual([])
    // A person's close is the assignee's, never the AI's.
    expect(rr.actions.close.who).toEqual(['assignee'])
  })
})

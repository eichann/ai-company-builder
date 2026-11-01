/**
 * Members' own OAuth permissions, provider-neutral (services/member-oauth.ts,
 * `.claude/rules/member-oauth.md`), on the real schema and vault with two
 * stand-in providers (`google`, `slack`). Google's own behaviour is in
 * tests/integration/google-connector.test.ts; this file guards what holds for
 * every provider:
 * - a grant (or a pending start) of one provider never serves another — not
 *   even its sealed token copied into the other provider's row;
 * - a state from another company finds nothing; a start of one member never
 *   becomes another member's grant;
 * - a stopped grant is unusable from the next call, and 「すべての鍵を止める」
 *   stops every provider;
 * - another company cannot see or stop a company's grant.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteKeyBrokerRepository } from '../../src/adapters/sqlite/key-broker'
import { localSecretCipher } from '../../src/adapters/local-secret-cipher'
import { randomIds, sha256TokenDigest, systemClock } from '../../src/adapters/system'
import { createBrokerVault } from '../../src/services/broker-vault'
import { createMemberOAuth, type MemberOAuth, type OAuthProviderDescriptor } from '../../src/services/member-oauth'
import type { ConnectorProvider } from '../../src/ports/connectors'

const TS = '2026-11-01T00:00:00.000Z'
const EMAILS: Record<string, string> = { u1: 'one@div.example', u2: 'two@div.example', u3: 'three@other.example' }
const MEMBERS: Record<string, string[]> = { c1: ['u1', 'u2'], c2: ['u3'] }

let conn: Database.Database
let oauth: MemberOAuth
/** The account the provider says signed in (by provider). */
const signedIn: Partial<Record<ConnectorProvider, string>> = {}
let revoked: string[]
let issued = 0

function provider(id: ConnectorProvider): OAuthProviderDescriptor {
  return {
    id, label: id, features: ['read'],
    unavailable: async () => null,
    authorizeUrl: params => `https://${id}.example/auth?${new URLSearchParams(params)}`,
    exchangeCode: async () => ({ ok: true, tokens: { accessToken: `at-${id}-${++issued}`, refreshToken: `rt-${id}-${issued}`, scopes: 'read' } }),
    identify: async () => ({ ok: true, email: signedIn[id]! }),
    revoke: async token => { revoked.push(token); return true },
    normalizeScopes: s => s.split(' ').filter(Boolean),
    featuresOf: s => [...s],
    forget: () => {},
    forgetCompany: () => {},
    pages: { granted: 'granted', expired: 'expired', denied: 'denied', unavailable: 'unavailable', failed: 'failed', email: 'email', noRefresh: 'noRefresh' },
  }
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  for (const id of ['c1', 'c2']) {
    conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', TS, TS)
  }
  revoked = []
  oauth = createMemberOAuth({
    companyData: sqliteCompanyData(conn),
    brokerVault: createBrokerVault({ brokerKeys: sqliteKeyBrokerRepository(conn), brokerCipher: { enabled: true, cipher: localSecretCipher(randomBytes(32)) } }),
    accounts: {
      byIds: ids => new Map(ids.filter(i => EMAILS[i]).map(i => [i, { id: i, email: EMAILS[i], name: i, image: null }])),
      bySessionToken: () => null,
    },
    clock: systemClock, ids: randomIds, tokenDigest: sha256TokenDigest,
    isMember: (companyId, userId) => (MEMBERS[companyId] ?? []).includes(userId),
    redirectUri: p => `https://acb.example/api/oauth/${p}/callback`,
    log: { warn: () => {} },
  })
  oauth.register(provider('google'))
  oauth.register(provider('slack'))
})

const member = (companyId: string, userId: string) => ({ companyId, userId, role: 'member' })

/** Starts 「… で許可」 and returns the state the browser carries. */
async function start(p: ConnectorProvider, companyId: string, userId: string): Promise<string> {
  const { authorizeUrl } = await oauth.start(p, member(companyId, userId), ['read'], x => ({ state: x.state, code_challenge: x.codeChallenge }))
  return new URL(authorizeUrl).searchParams.get('state')!
}

async function allow(p: ConnectorProvider, companyId: string, userId: string) {
  signedIn[p] = EMAILS[userId]
  return oauth.callback(p, { state: await start(p, companyId, userId), code: 'code' })
}

const grantCount = () => (conn.prepare('SELECT COUNT(*) AS n FROM connector_grants').get() as { n: number }).n

describe('member OAuth (every provider)', () => {
  it('a grant of one provider never serves another', async () => {
    expect((await allow('google', 'c1', 'u1'))!.granted).toBe(true)
    expect((await oauth.openRefreshToken('google', 'c1', 'u1'))?.token).toMatch(/^rt-google-/)
    expect(oauth.grant('slack', 'c1', 'u1')).toBeNull()
    expect(await oauth.openRefreshToken('slack', 'c1', 'u1')).toBeNull()
    // Even the sealed token moved into the other provider's row does not open there.
    conn.prepare("UPDATE connector_grants SET provider = 'slack' WHERE company_id = 'c1' AND user_id = 'u1'").run()
    await expect(oauth.openRefreshToken('slack', 'c1', 'u1')).rejects.toThrow()
  })

  it('a start of one provider is refused at another provider\'s callback, nothing stored', async () => {
    const state = await start('google', 'c1', 'u1')
    signedIn.slack = EMAILS.u1
    expect(await oauth.callback('slack', { state, code: 'code' })).toMatchObject({ granted: false, message: 'expired' })
    expect(grantCount()).toBe(0)
  })

  it('a state from another company finds nothing; one member\'s start never becomes another\'s grant', async () => {
    const state = await start('slack', 'c1', 'u1')
    signedIn.slack = EMAILS.u1
    expect(await oauth.callback('slack', { state: state.replace(/^c1\./, 'c2.'), code: 'code' })).toMatchObject({ granted: false, message: 'expired' })
    expect(grantCount()).toBe(0)

    // u1 started, but u2's account signed in: refused, the issued tokens revoked, nothing for either.
    signedIn.slack = EMAILS.u2
    expect(await oauth.callback('slack', { state: await start('slack', 'c1', 'u1'), code: 'code' })).toMatchObject({ granted: false, message: 'email' })
    expect(grantCount()).toBe(0)
    expect(revoked).toHaveLength(1)
  })

  it('a stopped grant is unusable from the next call; 「すべての鍵を止める」 stops every provider', async () => {
    await allow('google', 'c1', 'u1')
    await allow('slack', 'c1', 'u1')
    await allow('slack', 'c1', 'u2')
    expect(await oauth.stopGrant('slack', 'c1', 'u2', 'admin')).toBe(true)
    expect(await oauth.openRefreshToken('slack', 'c1', 'u2')).toBeNull()
    expect(oauth.grant('slack', 'c1', 'u2')?.status).toBe('stopped')

    expect(await oauth.stopAll('c1', 'owner')).toBe(2)
    expect(await oauth.openRefreshToken('google', 'c1', 'u1')).toBeNull()
    expect(await oauth.openRefreshToken('slack', 'c1', 'u1')).toBeNull()
  })

  it('another company can neither use nor stop a company\'s grant', async () => {
    await allow('google', 'c1', 'u1')
    expect(oauth.grant('google', 'c2', 'u1')).toBeNull()
    expect(await oauth.openRefreshToken('google', 'c2', 'u1')).toBeNull()
    expect(await oauth.stopGrant('google', 'c2', 'u1', 'other-admin')).toBe(false)
    expect(await oauth.stopAll('c2', 'other-owner')).toBe(0)
    expect(oauth.grant('google', 'c1', 'u1')?.status).toBe('active')
  })
})

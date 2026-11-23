/**
 * Holding tickets (private-folders.md "Access removed: holding tickets") against the real
 * schema: what `track` writes when a change takes a private folder away from someone, and the
 * gate that refuses such a change outside `track`.
 *
 * Guards:
 * - every storage step that can take read access away throws outside `track` (a new path that
 *   forgets the wrapper fails instead of leaving a member without a ticket);
 * - a lost reader gets one open ticket (renewed, never duplicated), with permission_history;
 * - reading the folder again cancels the open ticket;
 * - a folder made public is no loss;
 * - the clock closes tickets past 30 days, and only those;
 * - a change that rolls back leaves no ticket;
 * - one company's change never writes another's tickets.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'
import { createReaderChangeGate, UntrackedReaderChangeError } from '../../src/lib/reader-change-gate'
import { createHoldingTicketService, HOLDING_TICKET_DAYS } from '../../src/services/holding-tickets'
import { createServerClock } from '../../src/services/server-clock'
import type { CompanyDataSource } from '../../src/ports/company-data'
import type { ReaderChangeGate } from '../../src/ports/holding'

const T0 = Date.parse('2026-11-23T00:00:00.000Z')
let nowMs = T0
let conn: Database.Database
let gate: ReaderChangeGate
let source: CompanyDataSource
let holding: ReturnType<typeof createHoldingTicketService>
let n = 0

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', 'x', 'x')
}
function member(companyId: string, userId: string, role = 'member') {
  conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${++n}`, userId, companyId, role, 'x', 'x')
}
/** A private folder read by everyone in `readers` (user rules), as the private-folder adapter stores one. */
function privateFolder(companyId: string, scopeId: string, path: string, readers: string[]) {
  conn.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES (?, ?, ?, 'folder', ?, 'x')`).run(scopeId, companyId, path, `r-${scopeId}`)
  conn.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES (?, ?, ?, 'x')`).run(`r-${scopeId}`, companyId, scopeId)
  const rule = conn.prepare(`INSERT INTO scope_rules (id, company_id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'x')`)
  rule.run(`rule-${++n}`, companyId, scopeId, 'everyone', null, 0, 0)
  for (const r of readers) rule.run(`rule-${++n}`, companyId, scopeId, 'user', r, 1, 0)
}
const viewers = (...ids: string[]) => ({ viewers: ids, editors: [] })
const tickets = (companyId: string) => source.forCompany(companyId).holding.list()
const history = (companyId: string) => (conn.prepare(`SELECT action, detail, by_user FROM permission_history WHERE company_id = ? ORDER BY seq`).all(companyId) as Array<{ action: string; detail: string; by_user: string }>)
  .map(h => ({ action: h.action, by: h.by_user, ...JSON.parse(h.detail) }))

beforeEach(() => {
  nowMs = T0
  conn = new Database(':memory:')
  initDatabase(conn)
  gate = createReaderChangeGate()
  source = sqliteCompanyData(conn, { readerChanges: gate })
  const memberships = sqliteMembershipRepository(conn, gate)
  let id = 0
  holding = createHoldingTicketService({
    companyData: source, memberships, transactions: sqliteTransactions(conn), readerChanges: gate,
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => `ticket-${++id}`, newToken: () => 'token' },
  })
  company('a')
  company('b')
  for (const [u, role] of [['owner', 'owner'], ['admin', 'admin'], ['v1', 'member'], ['v2', 'member'], ['other', 'member']] as const) member('a', u, role)
  member('b', 'v1')
  privateFolder('a', 's-eval', '人事/評価', ['v1', 'v2'])
  privateFolder('b', 's-b', '経理/給与', ['v1'])
})

describe('the gate: storage steps that can take a private folder away run only inside track', () => {
  // One entry per gated step; removing any one assertWithin fails its row.
  const steps: Array<[string, () => unknown]> = [
    ['scopes.replaceRules', () => source.forCompany('a').scopes.replaceRules('人事/評価', [{ subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false }], 'owner')],
    ['scopes.upsertRule', () => source.forCompany('a').scopes.upsertRule('人事/評価', { subjectType: 'user', subjectId: 'v1', canRead: false, canWrite: false }, 'owner')],
    ['scopes.updateRuleAccess', () => source.forCompany('a').scopes.updateRuleAccess(source.forCompany('a').scopes.rulesOf('s-eval')[1].id, false, false)],
    ['scopes.deleteRule', () => source.forCompany('a').scopes.deleteRule(source.forCompany('a').scopes.rulesOf('s-eval')[1].id, source.forCompany('a').scopes.getById('s-eval')!)],
    ['scopes.clearRules', () => source.forCompany('a').scopes.clearRules(source.forCompany('a').scopes.getById('s-eval')!)],
    ['scopes.deleteUserRules', () => source.forCompany('a').scopes.deleteUserRules('v1')],
    ['privateFolders.replaceRules', () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner')],
    ['memberships.updateRole', () => sqliteMembershipRepository(conn, gate).updateRole('a', 'admin', 'member', 'x')],
    ['memberships.delete', () => sqliteMembershipRepository(conn, gate).delete('a', 'v1')],
  ]
  for (const [what, step] of steps) {
    it(`${what} throws outside track and changes nothing`, () => {
      const before = conn.prepare('SELECT COUNT(*) AS n FROM scope_rules').get()
      expect(step).toThrow(UntrackedReaderChangeError)
      expect(conn.prepare('SELECT COUNT(*) AS n FROM scope_rules').get()).toEqual(before)
      expect(sqliteMembershipRepository(conn).listByCompany('a')).toHaveLength(5)
    })
  }

  it('a deleted folder\'s rows are removed only through trackRows inside track (the delete itself: integration test)', () => {
    // The gate is per company: a change tracked for company b does not open company a.
    expect(() => gate.within('b', () => source.forCompany('a').scopes.deleteUserRules('v1'))).toThrow(UntrackedReaderChangeError)
  })
})

describe('track: tickets for whoever stops reading', () => {
  it('a reader taken off the folder gets one open ticket for 30 days, recorded in permission_history', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    const [t] = tickets('a')
    expect(tickets('a')).toHaveLength(1)
    expect(t).toMatchObject({
      userId: 'v1', scopeId: 's-eval', repoId: 'r-s-eval', folderPath: '人事/評価', cause: 'readers', state: 'open', byUser: 'owner',
      expiresAt: new Date(T0 + HOLDING_TICKET_DAYS * 86_400_000).toISOString(),
    })
    expect(history('a')).toEqual([{
      action: 'holding-ticket', by: 'owner', ticketId: t.id, scopeId: 's-eval', path: '人事/評価', userId: 'v1', cause: 'readers', expiresAt: t.expiresAt,
    }])
  })

  it('nobody who still reads gets one; owners / admins read every private folder', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v1', 'v2', 'other'), 'owner'))
    expect(tickets('a')).toEqual([])
    expect(history('a')).toEqual([])
  })

  it('a member removed from the company loses every private folder they read (and an admin removed: every one)', () => {
    holding.track('a', { cause: 'left-company', byUser: 'owner' }, () => {
      sqliteMembershipRepository(conn, gate).delete('a', 'admin')
      source.forCompany('a').scopes.deleteUserRules('admin')
    })
    expect(tickets('a').map(t => [t.userId, t.scopeId, t.cause])).toEqual([['admin', 's-eval', 'left-company']])
  })

  it('a demoted admin loses the private folders no rule names them on', () => {
    holding.track('a', { cause: 'role', byUser: 'owner' }, () => sqliteMembershipRepository(conn, gate).updateRole('a', 'admin', 'member', 'x'))
    expect(tickets('a').map(t => [t.userId, t.cause])).toEqual([['admin', 'role']])
  })

  it('a folder that is gone afterwards is `folder-deleted` for every reader, whatever the change said', () => {
    holding.track('a', { cause: 'rules', byUser: 'owner' }, () => {
      conn.prepare(`DELETE FROM scope_rules WHERE scope_id = 's-eval'`).run()
      conn.prepare(`DELETE FROM scopes WHERE id = 's-eval'`).run()
    })
    expect(tickets('a').map(t => [t.userId, t.cause]).sort()).toEqual([['admin', 'folder-deleted'], ['owner', 'folder-deleted'], ['v1', 'folder-deleted'], ['v2', 'folder-deleted']])
  })

  it('a folder made public is no loss: everyone reads it now', () => {
    holding.track('a', { cause: 'rules', byUser: 'owner' }, () => {
      conn.prepare(`UPDATE scope_rules SET can_read = 1 WHERE scope_id = 's-eval'`).run()
      conn.prepare(`UPDATE scopes SET repo_id = NULL WHERE id = 's-eval'`).run()
    })
    expect(tickets('a')).toEqual([])
  })

  it('losing it again while a ticket is open renews that ticket (one open ticket per member and folder)', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    nowMs = T0 + 5 * 86_400_000
    // A later change that leaves v1 where they are (not reading) writes nothing new for them.
    holding.track('a', { cause: 'rules', byUser: 'admin' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'admin'))
    expect(tickets('a')).toHaveLength(1)
    // Read again (cancelled), then lost again: a new open ticket, the old one stays cancelled.
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v1', 'v2'), 'owner'))
    holding.track('a', { cause: 'left-company', byUser: 'owner' }, () => {
      sqliteMembershipRepository(conn, gate).delete('a', 'v1')
      source.forCompany('a').scopes.deleteUserRules('v1')
    })
    expect(tickets('a').map(t => [t.state, t.cause]).sort()).toEqual([['cancelled', 'readers'], ['open', 'left-company']])
  })

  it('the open ticket is renewed, not duplicated, when the same member loses the folder twice (two causes)', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    const first = tickets('a')[0]
    // The repository's own rule: one open ticket per member and folder.
    nowMs = T0 + 3 * 86_400_000
    const again = source.forCompany('a').holding.open({
      id: 'other-id', userId: 'v1', scopeId: 's-eval', repoId: 'r-s-eval', folderPath: '人事/評価', cause: 'left-company',
      at: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(), byUser: 'admin',
    })
    expect(again).toEqual({ ticketId: first.id, extended: true })
    expect(tickets('a')).toHaveLength(1)
    expect(tickets('a')[0]).toMatchObject({ id: first.id, cause: 'left-company', expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString() })
  })

  it('reading the folder again cancels the open ticket, with permission_history', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    holding.track('a', { cause: 'readers', byUser: 'admin' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v1', 'v2'), 'admin'))
    expect(tickets('a')[0]).toMatchObject({ userId: 'v1', state: 'cancelled' })
    expect(history('a').at(-1)).toEqual({ action: 'holding-ticket-cancel', by: 'admin', scopeId: 's-eval', path: '人事/評価', userId: 'v1' })
  })

  it('a change that fails rolls back with its tickets', () => {
    expect(() => holding.track('a', { cause: 'readers', byUser: 'owner' }, () => {
      source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner')
      throw new Error('refused')
    })).toThrow('refused')
    expect(tickets('a')).toEqual([])
    expect(source.forCompany('a').scopes.rulesOf('s-eval').filter(r => r.subjectId === 'v1')).toHaveLength(1)
  })

  it('a change in company a writes no ticket of company b (same user, same kind of folder)', () => {
    holding.track('a', { cause: 'left-company', byUser: 'owner' }, () => {
      sqliteMembershipRepository(conn, gate).delete('a', 'v1')
      source.forCompany('a').scopes.deleteUserRules('v1')
    })
    expect(tickets('b')).toEqual([])
    expect(tickets('a').map(t => t.userId)).toEqual(['v1'])
  })
})

describe('expiry (the server clock)', () => {
  it('closes open tickets past their 30 days, and only those', () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    nowMs = T0 + 10 * 86_400_000
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers(), 'owner'))
    nowMs = T0 + HOLDING_TICKET_DAYS * 86_400_000 - 1
    expect(holding.expire('a')).toBe(0)
    nowMs = T0 + HOLDING_TICKET_DAYS * 86_400_000
    expect(holding.expire('a')).toBe(1)
    const byUser = Object.fromEntries(tickets('a').map(t => [t.userId, t]))
    expect(byUser.v1).toMatchObject({ state: 'expired', closedAt: new Date(nowMs).toISOString() })
    expect(byUser.v2.state).toBe('open')
    // Running twice changes nothing more.
    expect(holding.expire('a')).toBe(0)
  })

  it('the server clock closes them for every company, records on or off', async () => {
    holding.track('a', { cause: 'readers', byUser: 'owner' }, () => source.forCompany('a').privateFolders.replaceRules('s-eval', viewers('v2'), 'owner'))
    nowMs = T0 + HOLDING_TICKET_DAYS * 86_400_000
    const clock = createServerClock({
      companyIds: () => ['a', 'b'], companyData: source,
      clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
      writer: { transition: () => { throw new Error('not used') } }, notifications: { sweep: () => 0 },
      autoRunFor: () => false, timeZoneOf: () => 'Asia/Tokyo', yieldNow: async () => {}, log: () => {},
      expireHoldingTickets: companyId => holding.expire(companyId),
    })
    expect(source.forCompany('a').records.settings().enabled).toBe(false)
    expect((await clock.runOnce()).ticketsExpired).toBe(1)
    expect(tickets('a')[0].state).toBe('expired')
  })
})

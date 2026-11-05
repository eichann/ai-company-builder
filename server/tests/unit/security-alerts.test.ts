/**
 * 「気になる動き」 (services/security-alerts.ts, security-alerts.md) on the real schema and the
 * real handle, with a controllable clock.
 *
 * Guards (each fails when its rule or check is removed):
 * - sign-in: 10 wrong passwords in 15 minutes → one alert per company of the account; 9, or
 *   older ones, → none; a success after 5 → its own alert; an address that is no account → none;
 * - bulk download: far above the member's own normal → alert (with 深夜); a member's first
 *   download, or a member whose normal is high → none;
 * - refused pushes: many to many places → alert; the same change retried → none; no path in the text;
 * - contract-3 reads above the member's normal, reads refused by the pace, key use above normal;
 * - changes: someone made admin, a company key, 「全員が直せる」, an internal-host exception —
 *   not the founding owner, not changes older than a day;
 * - a second sweep writes nothing more; another company sees nothing of this one's;
 * - Slack only when turned on, once per owner / admin per sweep, never to a member;
 * - only owners / admins read the list.
 * Plus the server clock runs the sweep while the records feature is off.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { createSecurityAlertService, SECURITY_ALERT_RULES, type SecurityAlertService } from '../../src/services/security-alerts'
import { createServerClock } from '../../src/services/server-clock'
import type { Member } from '../../src/services/access'

const GIB = 1024 ** 3
const HOUR = 3600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-05T03:00:00.000Z') // 12:00 in Japan
const iso = (ms: number) => new Date(ms).toISOString()

let conn: Database.Database
let svc: SecurityAlertService
let nowMs: number
let dms: Array<{ co: string; user: string; text: string }>
let n = 0

const ROLES: Record<string, string> = { 'u-owner': 'owner', 'u-admin': 'admin', 'u-alice': 'member', 'u-bob': 'member' }
const EMAILS: Record<string, string> = { 'alice@example.com': 'u-alice', 'bob@example.com': 'u-bob' }
const owner: Member = { companyId: 'a', userId: 'u-owner', role: 'owner' }

function company(id: string, members: string[]) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u-owner', iso(T0 - 100 * DAY), iso(T0 - 100 * DAY))
  for (const u of members) {
    const at = iso(T0 - 100 * DAY)
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${id}-${u}`, u, id, ROLES[u], at, at)
  }
}

function build() {
  const companyData = sqliteCompanyData(conn)
  svc = createSecurityAlertService({
    companyData,
    memberships: sqliteMembershipRepository(conn),
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }])), bySessionToken: () => null },
    clock: { now: () => iso(nowMs), nowMs: () => nowMs },
    ids: { newId: () => `id-${++n}`, newToken: () => `tok-${++n}` },
    brokerDay: ms => new Date(ms + 9 * HOUR).toISOString().slice(0, 10),
    timeZoneOf: () => 'Asia/Tokyo',
    userIdOfEmail: email => EMAILS[email.toLowerCase()] ?? null,
    companiesOf: userId => (conn.prepare('SELECT company_id FROM memberships WHERE user_id = ?').all(userId) as Array<{ company_id: string }>).map(r => r.company_id),
    sendDm: async (co, user, text) => { dms.push({ co, user, text }); return { ok: true } },
    log: { warn: () => {} },
  })
}

const alerts = (co = 'a') => conn.prepare('SELECT kind, user_id, facts FROM security_alerts WHERE company_id = ? ORDER BY rowid').all(co) as Array<{ kind: string; user_id: string | null; facts: string }>
const kinds = (co = 'a') => alerts(co).map(a => a.kind)
const listed = () => { const r = svc.list(owner); if (!r.ok) throw new Error('refused'); return r.value.items }

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  nowMs = T0
  dms = []
  company('a', ['u-owner', 'u-admin', 'u-alice', 'u-bob'])
  company('b', ['u-owner', 'u-alice'])
  build()
})

describe('sign-in', () => {
  it('10 wrong passwords within 15 minutes alert every company of the account, once', () => {
    for (let i = 0; i < 9; i++) { svc.signInAttempt('alice@example.com', false); nowMs += 60_000 }
    expect(kinds()).toEqual([])
    svc.signInAttempt('Alice@example.com', false)
    expect(kinds()).toEqual(['sign_in_failures'])
    expect(kinds('b')).toEqual(['sign_in_failures'])
    svc.signInAttempt('alice@example.com', false)
    expect(kinds()).toEqual(['sign_in_failures'])
    expect(alerts()[0].user_id).toBe('u-alice')
  })

  it('failures older than 15 minutes do not count; an address that is no account is not counted', () => {
    for (let i = 0; i < 9; i++) svc.signInAttempt('alice@example.com', false)
    nowMs += 16 * 60_000
    svc.signInAttempt('alice@example.com', false)
    for (let i = 0; i < 20; i++) svc.signInAttempt('nobody@example.com', false)
    expect(kinds()).toEqual([])
    expect(kinds('b')).toEqual([])
  })

  it('a success after 5 wrong passwords is its own alert; after 4 it is not', () => {
    for (let i = 0; i < 4; i++) svc.signInAttempt('bob@example.com', false)
    svc.signInAttempt('bob@example.com', true)
    expect(kinds()).toEqual([])
    for (let i = 0; i < 5; i++) svc.signInAttempt('bob@example.com', false)
    svc.signInAttempt('bob@example.com', true)
    expect(kinds()).toEqual(['sign_in_after_failures'])
    expect(JSON.parse(alerts()[0].facts)).toEqual({ failures: 5 })
    expect(kinds('b')).toEqual([]) // bob is not in company b
  })
})

describe('bulk download', () => {
  const download = (user: string, atMs: number, bytes: number, co = 'a') => {
    const saved = nowMs
    nowMs = atMs
    svc.downloaded(co, user, bytes)
    nowMs = saved
  }

  it('far above the member\'s own normal → an alert (at night: said so); a second sweep adds nothing', async () => {
    for (let d = 2; d <= 10; d++) download('u-alice', T0 - d * DAY, 20 * 1024 ** 2)
    download('u-alice', Date.parse('2026-11-04T17:00:00.000Z'), 3 * GIB) // 02:00 in Japan
    expect(await svc.sweep('a')).toBe(1)
    expect(kinds()).toEqual(['bulk_download'])
    const view = listed()[0]
    expect(view.detail).toContain('3.0GB')
    expect(view.detail).toContain('深夜')
    expect(await svc.sweep('a')).toBe(0)
    expect(kinds('b')).toEqual([])
  })

  it('a member\'s first download (a new member) and a member whose normal is high are not alerted', async () => {
    download('u-bob', T0 - HOUR, 5 * GIB) // never counted before
    for (let d = 2; d <= 15; d++) download('u-alice', T0 - d * DAY, GIB) // 1 GB a day is her normal
    download('u-alice', T0 - HOUR, 3 * GIB)
    expect(await svc.sweep('a')).toBe(0)
  })

  it('below the floor nothing is looked at', async () => {
    download('u-alice', T0 - 10 * DAY, 1)
    download('u-alice', T0 - HOUR, SECURITY_ALERT_RULES.download.floorBytes - 1)
    expect(await svc.sweep('a')).toBe(0)
  })
})

describe('refused pushes', () => {
  const reject = (user: string, paths: string[], atMs = T0 - 10 * 60_000) =>
    conn.prepare("INSERT INTO push_rejections (id, company_id, user_id, marker, paths, created_at) VALUES (?, 'a', ?, 'WRITE_DENIED', ?, ?)").run(`r-${++n}`, user, JSON.stringify(paths), iso(atMs))

  it('many refusals to many places in an hour → an alert that names no path', async () => {
    for (let i = 0; i < 12; i++) reject('u-alice', [`人事部/給与-秘密/${i}.xlsx`])
    expect(await svc.sweep('a')).toBe(1)
    const view = listed()[0]
    expect(view.kind).toBe('push_probing')
    expect(JSON.stringify(view)).not.toContain('給与')
    expect(JSON.stringify(alerts())).not.toContain('給与')
  })

  it('the same change refused again and again (a stuck sync), or refusals older than an hour → none', async () => {
    for (let i = 0; i < 40; i++) reject('u-alice', ['営業部/a.md'])
    for (let i = 0; i < 12; i++) reject('u-bob', [`x/${i}`], T0 - 2 * HOUR)
    expect(await svc.sweep('a')).toBe(0)
  })
})

describe('plugin reads, key use', () => {
  const read = (user: string, atMs: number) => conn.prepare(`INSERT INTO plugin_access_log (id, company_id, plugin_id, call, user_id, actor_kind, refs, status, at)
    VALUES (?, 'a', 'p', 'portal/read', ?, 'ai', '[]', 'ok', ?)`).run(`l-${++n}`, user, iso(atMs))

  it('contract-3 reads far above the member\'s normal → alert; below the floor → none', async () => {
    for (let h = 2; h < 7 * 24; h += 24) read('u-alice', T0 - h * HOUR) // a few a week
    for (let i = 0; i < 400; i++) read('u-alice', T0 - 30 * 60_000)
    for (let i = 0; i < 250; i++) read('u-bob', T0 - 20 * 60_000)
    expect(await svc.sweep('a')).toBe(1)
    expect(alerts()[0]).toMatchObject({ kind: 'plugin_reads', user_id: 'u-alice' })
    expect(await svc.sweep('a')).toBe(0)
  })

  it('reads at the member\'s own normal → none', async () => {
    for (let h = 2; h < 7 * 24; h += 1) for (let i = 0; i < 60; i++) read('u-alice', T0 - h * HOUR)
    for (let i = 0; i < 400; i++) read('u-alice', T0 - 30 * 60_000)
    expect(await svc.sweep('a')).toBe(0)
  })

  it('reads refused by the pace, many in two hours → alert', async () => {
    const hour = iso(T0).slice(0, 13)
    conn.prepare("INSERT INTO plugin_call_paced (company_id, plugin_id, user_id, hour, count) VALUES ('a', 'p', 'u-alice', ?, 150)").run(hour)
    conn.prepare("INSERT INTO plugin_call_paced (company_id, plugin_id, user_id, hour, count) VALUES ('a', 'p', 'u-bob', ?, 50)").run(hour)
    expect(await svc.sweep('a')).toBe(1)
    expect(alerts()[0]).toMatchObject({ kind: 'plugin_paced', user_id: 'u-alice' })
  })

  it('key use far above the member\'s normal → alert; at a high normal → none; refusal counters are not use', async () => {
    const use = (user: string, day: string, requests: number, key = 'k1') =>
      conn.prepare("INSERT INTO broker_usage (company_id, key_id, user_id, day, requests, tokens) VALUES ('a', ?, ?, ?, ?, 0)").run(key, user, day, requests)
    const today = '2026-11-05'
    use('u-alice', '2026-11-03', 100)
    use('u-alice', today, 3000)
    for (const d of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) use('u-bob', d, 1000)
    use('u-bob', today, 3000)
    use('u-owner', today, 5000, 'person-relay:google:refused')
    expect(await svc.sweep('a')).toBe(1)
    expect(alerts()[0]).toMatchObject({ kind: 'key_use', user_id: 'u-alice' })
  })
})

describe('changes', () => {
  it('someone made admin, a company key, 「全員が直せる」, an internal-host exception → one alert each, once', async () => {
    const at = iso(T0 - HOUR)
    conn.prepare("UPDATE memberships SET role = 'admin', updated_at = ? WHERE company_id = 'a' AND user_id = 'u-bob'").run(at)
    conn.prepare(`INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id, destinations, audience, caps, created_at, created_by, updated_at, updated_by, secret_updated_at)
      VALUES ('k1', 'a', 'company', NULL, 'hubspot', '営業用', 'abcd', 's', 'c', 'n', 't', 'w', 'kek', '[]', '{}', '{}', ?, 'u-admin', ?, 'u-admin', ?)`).run(at, at, at)
    conn.prepare(`INSERT INTO broker_keys (id, company_id, scope, owner_user_id, service, display_name, last4, cipher_scheme, ciphertext, nonce, tag, wrapped_key, kek_id, destinations, audience, caps, created_at, created_by, updated_at, updated_by, secret_updated_at)
      VALUES ('k2', 'a', 'user', 'u-alice', 'openai', '自分の', 'abcd', 's', 'c', 'n', 't', 'w', 'kek', '[]', '{}', '{}', ?, 'u-alice', ?, 'u-alice', ?)`).run(at, at, at)
    conn.prepare("INSERT INTO skill_editing_settings (company_id, everyone, updated_at, updated_by) VALUES ('a', 1, ?, 'u-admin')").run(at)
    conn.prepare("INSERT INTO broker_history (id, company_id, key_id, action, changed_at, changed_by, change) VALUES ('h1', 'a', NULL, 'settings', ?, 'u-admin', ?)")
      .run(at, JSON.stringify({ action: 'settings', before: { memberKeysAllowed: true, internalHosts: [] }, after: { memberKeysAllowed: true, internalHosts: ['intra.example'] } }))
    conn.prepare("INSERT INTO broker_history (id, company_id, key_id, action, changed_at, changed_by, change) VALUES ('h2', 'a', NULL, 'settings', ?, 'u-admin', ?)")
      .run(at, JSON.stringify({ action: 'settings', before: { memberKeysAllowed: true }, after: { memberKeysAllowed: false } }))
    expect(await svc.sweep('a')).toBe(4)
    expect(kinds().sort()).toEqual(['company_key_added', 'internal_hosts_added', 'role_raised', 'skill_editing_opened'])
    expect(alerts().find(a => a.kind === 'role_raised')?.user_id).toBe('u-bob')
    expect(await svc.sweep('a')).toBe(0)
    expect(kinds('b')).toEqual([])
  })

  it('the founding owner and changes older than a day are not alerted', async () => {
    conn.prepare("UPDATE companies SET created_at = ? WHERE id = 'a'").run(iso(T0 - HOUR))
    conn.prepare("UPDATE memberships SET created_at = ?, updated_at = ? WHERE company_id = 'a' AND user_id = 'u-owner'").run(iso(T0 - HOUR), iso(T0 - HOUR))
    conn.prepare("UPDATE memberships SET role = 'admin', updated_at = ? WHERE company_id = 'a' AND user_id = 'u-bob'").run(iso(T0 - 2 * DAY))
    expect(await svc.sweep('a')).toBe(0)
  })
})

describe('delivery and who reads', () => {
  const raise = () => conn.prepare("UPDATE memberships SET role = 'admin', updated_at = ? WHERE company_id = 'a' AND user_id = 'u-bob'").run(iso(nowMs - 60_000))

  it('no Slack DM unless the company turned it on; then one per owner / admin per sweep, never to a member, never again', async () => {
    raise()
    await svc.sweep('a')
    expect(dms).toEqual([])
    const saved = svc.saveSettings(owner, { slackDm: true })
    expect(saved.ok).toBe(true)
    nowMs += 5 * 60_000
    for (let i = 0; i < 10; i++) svc.signInAttempt('alice@example.com', false)
    await svc.sweep('a')
    expect(dms.map(d => d.user).sort()).toEqual(['u-admin', 'u-bob', 'u-owner'])
    expect(dms[0].text).toContain('パスワードの間違い')
    expect(dms.every(d => d.co === 'a')).toBe(true)
    await svc.sweep('a')
    expect(dms).toHaveLength(3)
  })

  it('only owners and admins read the list and change the setting; another company\'s alerts are not listed', async () => {
    raise()
    await svc.sweep('a')
    expect(svc.list({ companyId: 'a', userId: 'u-alice', role: 'member' }).ok).toBe(false)
    expect(svc.saveSettings({ companyId: 'a', userId: 'u-alice', role: 'member' }, { slackDm: true }).ok).toBe(false)
    expect(svc.saveSettings(owner, { slackDm: 'yes' }).ok).toBe(false)
    expect(svc.forHome({ companyId: 'a', userId: 'u-alice', role: 'member' })).toEqual([])
    expect(listed().map(i => i.kind)).toEqual(['role_raised'])
    expect(listed()[0].title).toBe('Name u-bobさんが管理者になりました')
    const other = svc.list({ companyId: 'b', userId: 'u-owner', role: 'owner' })
    expect(other.ok && other.value.items).toEqual([])
  })
})

describe('the server clock', () => {
  it('runs the sweep for every company, also while the records feature is off', async () => {
    const swept: string[] = []
    const clock = createServerClock({
      companyIds: () => ['a', 'b'],
      companyData: sqliteCompanyData(conn),
      clock: { now: () => iso(nowMs), nowMs: () => nowMs },
      writer: { transition: () => { throw new Error('not expected') } },
      notifications: { sweep: () => 0 },
      autoRunFor: () => false,
      timeZoneOf: () => 'Asia/Tokyo',
      securitySweep: async co => { swept.push(co); return co === 'a' ? 1 : 0 },
      yieldNow: async () => {},
      log: () => {},
    })
    const run = await clock.runOnce()
    expect(swept).toEqual(['a', 'b'])
    expect(run.alerts).toBe(1)
  })
})

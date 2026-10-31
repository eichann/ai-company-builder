/**
 * The AI action log (services/agent-events.ts) on an in-memory database with
 * the real schema and repositories, a controllable clock and fake accounts:
 * per-event validation (shared/types/agent-events.ts), implausible times,
 * the per-member budget and its window, a manager's department scope and
 * masking (a private folder they cannot read leaks neither through the target
 * nor through the search), and the retention cut-off.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteAgentEventRepository, sqliteAgentEventSettingsRepository } from '../../src/adapters/sqlite/agent-events'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import { replaceDepartmentManagers } from '../../src/adapters/sqlite/permission-store'
import { createAgentEventService, parseListQuery, type AgentEventService } from '../../src/services/agent-events'
import type { Member } from '../../src/services/access'
import { parseAgentToolEvent, type AgentToolEvent } from '../../shared/types/agent-events'

const CO = 'co'
const T0 = Date.parse('2026-10-25T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

let conn: Database.Database
let nowMs = T0
let service: AgentEventService
let seq = 0

const member = (userId: string, role: string): Member => ({ companyId: CO, userId, role })
const OWNER = member('owner', 'owner')
const MANAGER = member('manager', 'member')
const MEMBER = member('member', 'member')

function event(over: Partial<AgentToolEvent> = {}): AgentToolEvent {
  seq++
  return {
    version: 1, id: `e-${seq}`, callId: `toolu_${seq}`, at: new Date(nowMs).toISOString(), agent: 'claude-code',
    tool: 'Read', category: 'read', target: { kind: 'file', path: '営業部/a.md' }, decision: 'auto-allowed', outcome: 'ok', ...over,
  }
}

function ingest(m: Member, events: unknown[]) {
  const r = service.ingest(m, { events }, '0.0.1+abc1234.20261025000000')
  if (!r.ok) throw new Error(JSON.stringify(r.body))
  return r.value
}

beforeEach(() => {
  nowMs = T0
  conn = new Database(':memory:')
  initDatabase(conn)
  const ts = new Date(T0).toISOString()
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'owner', ts, ts)
  for (const [u, r] of [['owner', 'owner'], ['manager', 'member'], ['member', 'member']]) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${u}`, u, CO, r, ts, ts)
  }
  for (const [id, folder, order] of [['d-sales', '営業部', 0], ['d-hr', '人事', 1]] as const) {
    conn.prepare('INSERT INTO departments (id, company_id, name, folder, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, CO, folder, folder, order, ts, ts)
  }
  initDatabase(conn) // company + department scopes, everyone read + write
  replaceDepartmentManagers(conn, CO, 'd-sales', ['manager'], 'owner')
  // A private folder inside 営業部 that only `member` may read.
  conn.prepare(`INSERT INTO scope_repos (id, company_id, scope_id, created_at) VALUES ('r1', ?, 's-secret', ?)`).run(CO, ts)
  conn.prepare(`INSERT INTO scopes (id, company_id, path, kind, repo_id, created_at) VALUES ('s-secret', ?, '営業部/秘密', 'folder', 'r1', ?)`).run(CO, ts)
  conn.prepare(`INSERT INTO scope_rules (id, scope_id, subject_type, subject_id, can_read, can_write, created_at) VALUES ('ru1', 's-secret', 'everyone', NULL, 0, 0, ?), ('ru2', 's-secret', 'user', 'member', 1, 1, ?)`).run(ts, ts)

  service = createAgentEventService({
    agentEvents: sqliteAgentEventRepository(conn),
    agentEventSettings: sqliteAgentEventSettingsRepository(conn),
    memberships: sqliteMembershipRepository(conn),
    companyData: sqliteCompanyData(conn),
    accounts: { byIds: ids => new Map(ids.map(id => [id, { email: `${id}@example.com`, name: `Name ${id}` }])), bySessionToken: () => null },
    clock: { now: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    ids: { newId: () => `id-${++seq}`, newToken: () => 'token' },
  })
})

describe('validation (parseAgentToolEvent)', () => {
  it('keeps the fields of an event, NFC paths, drops unknown fields and invalid optional values', () => {
    const parsed = parseAgentToolEvent({
      ...event({ target: { kind: 'files', files: [{ kind: 'file', path: '営業部/./x.md'.replace('/./', '/') }, { kind: 'outside', sensitive: 'ssh' }] } }),
      department: '営業部/'.normalize('NFD'),
      guardReason: 'made-up',
      prompt: 'secret text',
      durationMs: -5,
    })
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('prompt')
    expect(parsed).not.toHaveProperty('guardReason')
    expect(parsed).not.toHaveProperty('durationMs')
    expect(parsed?.department).toBe('営業部')
    expect(parsed?.target).toEqual({ kind: 'files', files: [{ kind: 'file', path: '営業部/x.md' }, { kind: 'outside', sensitive: 'ssh' }] })
  })

  it('rejects an event whose required fields are not valid', () => {
    const bad = [
      { ...event(), version: 2 },
      { ...event(), id: 'has space' },
      { ...event(), at: 'yesterday' },
      { ...event(), agent: 'gpt' },
      { ...event(), category: 'magic' },
      { ...event(), decision: 'maybe' },
      { ...event(), tool: 'x'.repeat(101) },
      { ...event(), target: { kind: 'file', path: '../etc/passwd' } },
      { ...event(), target: { kind: 'command', programs: ['rm\n-rf'] } },
      { ...event(), target: { kind: 'teleport' } },
      'not an object',
      null,
    ]
    for (const raw of bad) expect(parseAgentToolEvent(raw), JSON.stringify(raw)).toBeNull()
  })

  it('caps lists: more than 5 files or programs are counted in `more`', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ kind: 'file', path: `a/${i}.md` }))
    expect(parseAgentToolEvent({ ...event(), target: { kind: 'files', files, more: 2 } })?.target).toMatchObject({ more: 5 })
    expect(parseAgentToolEvent({ ...event(), target: { kind: 'command', programs: ['a', 'b', 'c', 'd', 'e', 'f'], redirect: true } })?.target)
      .toEqual({ kind: 'command', programs: ['a', 'b', 'c', 'd', 'e'], more: 1, redirect: true })
  })

  it('list query: enums, limit, cursor and dates are checked', () => {
    expect(parseListQuery({ category: 'magic' }).ok).toBe(false)
    expect(parseListQuery({ decision: 'maybe' }).ok).toBe(false)
    expect(parseListQuery({ limit: '0' }).ok).toBe(false)
    expect(parseListQuery({ limit: '201' }).ok).toBe(false)
    expect(parseListQuery({ cursor: 'garbage' }).ok).toBe(false)
    expect(parseListQuery({ from: 'not a date' }).ok).toBe(false)
    const q = parseListQuery({ from: '2026-10-01T09:00:00+09:00', limit: '10', category: 'write', q: ' 営業 ' })
    expect(q.ok && q.value).toMatchObject({ filter: { from: '2026-10-01T00:00:00.000Z', category: 'write', q: '営業' }, limit: 10 })
  })
})

describe('ingest', () => {
  it('stores valid events under the session user, skips invalid ones, ignores re-sends', () => {
    const a = event()
    expect(ingest(MEMBER, [a, { ...event(), agent: 'gpt' }, event()])).toEqual({ accepted: 2, duplicates: 0, rejected: 1 })
    expect(ingest(MEMBER, [a])).toEqual({ accepted: 0, duplicates: 1, rejected: 0 })
    const page = service.list(OWNER, {})
    expect(page.ok && page.value.events.map(e => [e.userId, e.clientVersion])).toEqual([['member', '0.0.1+abc1234.20261025000000'], ['member', '0.0.1+abc1234.20261025000000']])
  })

  it('an implausible time is stored as the time it arrived, flagged, with what the app said', () => {
    const old = event({ at: new Date(T0 - 9 * DAY).toISOString() })
    const future = event({ at: new Date(T0 + 10 * 60 * 1000).toISOString() })
    const fine = event({ at: new Date(T0 - 7 * DAY).toISOString() })
    ingest(MEMBER, [old, future, fine])
    const page = service.list(OWNER, { limit: '10' })
    if (!page.ok) throw new Error('list')
    const byId = new Map(page.value.events.map(e => [e.id, e]))
    expect(byId.get(old.id)).toMatchObject({ at: new Date(T0).toISOString(), atAdjusted: true })
    expect(byId.get(future.id)).toMatchObject({ at: new Date(T0).toISOString(), atAdjusted: true })
    expect(byId.get(fine.id)).toMatchObject({ at: fine.at, atAdjusted: false })
    expect((conn.prepare('SELECT client_at FROM agent_events WHERE id = ?').get(old.id) as { client_at: string }).client_at).toBe(old.at)
  })

  it('per-member budget: 3,000 events per 10 minutes, then 429 until the window ends', () => {
    for (let i = 0; i < 15; i++) ingest(MEMBER, Array.from({ length: 200 }, () => event()))
    const refused = service.ingest(MEMBER, { events: [event()] }, null)
    expect(refused).toMatchObject({ ok: false, kind: 'rate-limited', body: { code: 'RATE_LIMITED', retryAfterSeconds: 600 } })
    // Someone else's budget is their own.
    expect(ingest(OWNER, [event()]).accepted).toBe(1)
    nowMs += 10 * 60 * 1000
    expect(ingest(MEMBER, [event()]).accepted).toBe(1)
  })

  it('more than 200 events in one request, or no events array, is refused as a whole', () => {
    expect(service.ingest(MEMBER, { events: Array.from({ length: 201 }, () => event()) }, null)).toMatchObject({ ok: false, kind: 'too-large' })
    expect(service.ingest(MEMBER, { events: 'x' }, null)).toMatchObject({ ok: false, kind: 'bad-request' })
    expect(service.ingest(MEMBER, [], null)).toMatchObject({ ok: false, kind: 'bad-request' })
  })
})

describe('who reads what', () => {
  function seed() {
    ingest(MEMBER, [
      event({ id: 'sales', department: '営業部', target: { kind: 'file', path: '営業部/a.md' } }),
      event({ id: 'hr', department: '人事', target: { kind: 'file', path: '人事/b.md' } }),
      event({ id: 'mixed', department: '人事', target: { kind: 'files', files: [{ kind: 'file', path: '営業部/秘密/x.md' }, { kind: 'file', path: '人事/c.md' }] } }),
      event({ id: 'cmd', category: 'command', tool: 'Bash', target: { kind: 'command', programs: ['git push'] } }),
      event({ id: 'case', department: 'Eigyo', target: { kind: 'file', path: '営業部/秘密' } }),
    ])
  }
  const ids = (r: ReturnType<AgentEventService['list']>) => (r.ok ? r.value.events.map(e => e.id).sort() : r)

  it('owner/admin always see everything; managers only when the settings allow; members never', () => {
    seed()
    expect(ids(service.list(OWNER, {}))).toEqual(['case', 'cmd', 'hr', 'mixed', 'sales'])
    expect(service.list(MANAGER, {})).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(service.list(MEMBER, {})).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(service.updateSettings(OWNER, { viewers: 'admins-and-managers' }).ok).toBe(true)
    expect(service.list(MEMBER, {})).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(service.summary(MEMBER, {})).toMatchObject({ ok: false, kind: 'forbidden' })
  })

  it('a manager sees their departments’ part, with the private folder they cannot read hidden', () => {
    seed()
    service.updateSettings(OWNER, { viewers: 'admins-and-managers' })
    const page = service.list(MANAGER, {})
    if (!page.ok) throw new Error('list')
    const byId = new Map(page.value.events.map(e => [e.id, e]))
    expect([...byId.keys()].sort()).toEqual(['case', 'mixed', 'sales'])
    expect(byId.get('sales')?.target).toEqual({ kind: 'file', path: '営業部/a.md' })
    expect(byId.get('mixed')?.target).toEqual({ kind: 'files', files: [{ kind: 'hidden' }, { kind: 'file', path: '人事/c.md' }] })
    expect(byId.get('case')?.target).toEqual({ kind: 'hidden' })
    expect(JSON.stringify(page.value)).not.toContain('秘密')
    // The search does not see what the manager cannot: no hit through the hidden path.
    expect(ids(service.list(MANAGER, { q: '秘密' }))).toEqual([])
    expect(ids(service.list(MANAGER, { q: '人事/C' }))).toEqual(['mixed'])
    expect(ids(service.list(OWNER, { q: '秘密' }))).toEqual(['case', 'mixed'])
    // Summary: the same scope.
    const summary = service.summary(MANAGER, {})
    expect(summary.ok && summary.value.days.reduce((n, d) => n + d.total, 0)).toBe(3)
  })

  it('the viewer of the private folder sees it unmasked as a manager too', () => {
    seed()
    service.updateSettings(OWNER, { viewers: 'admins-and-managers' })
    replaceDepartmentManagers(conn, CO, 'd-sales', ['manager', 'member'], 'owner')
    const page = service.list(MEMBER, {})
    expect(page.ok && JSON.stringify(page.value)).toContain('営業部/秘密/x.md')
  })
})

describe('retention', () => {
  it('prune deletes what is older than the company’s retention; the preview counts the same', async () => {
    ingest(MEMBER, [event({ id: 'old' })])
    nowMs += 100 * DAY
    ingest(MEMBER, [event({ id: 'recent' })])
    nowMs += 81 * DAY // old: 181 days, recent: 81 days
    expect(service.retentionPreview(OWNER, '180')).toMatchObject({ ok: true, value: { days: 180, wouldDelete: 1, olderThan: new Date(nowMs - 180 * DAY).toISOString() } })
    expect(service.retentionPreview(OWNER, '30')).toMatchObject({ ok: true, value: { wouldDelete: 2 } })
    expect(service.retentionPreview(OWNER, '6').ok).toBe(false)
    expect(service.retentionPreview(MANAGER, '30')).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await service.prune()).toEqual({ deleted: 1 })
    service.updateSettings(OWNER, { retentionDays: 30 })
    expect(await service.prune()).toEqual({ deleted: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS n FROM agent_events').get()).toEqual({ n: 0 })
  })

  it('prunes in chunks', async () => {
    for (let i = 0; i < 7; i++) ingest(MEMBER, Array.from({ length: 200 }, () => event()))
    nowMs += 200 * DAY
    expect(await service.prune()).toEqual({ deleted: 1400 })
  })
})

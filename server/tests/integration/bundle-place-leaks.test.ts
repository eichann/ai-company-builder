/**
 * Integration Test: what is made for an owner-only or members-only まとまり is never seen by more
 * people than the まとまり (records.md "A task and its 案件・プロジェクト" → "Other records made for a
 * まとまり"; outbound-mail.md "Where a draft is placed") — through the real routes, a person's session
 * and their AI's record token, in a company without the shared folder (its departments are rows).
 *
 * Guards (each mutation-checked):
 * - a 決めたこと linked to an owner-only まとまり is its owner's alone — also when a department folder
 *   is given (by the person) or none (by the AI) — and one linked to a members-only まとまり is that
 *   list's alone: anyone else (a member of the department, an admin, the company owner) gets a
 *   missing record's answer on the detail and its history, and no query, 探す, 「あなたの番」 or
 *   見られる人 shows it;
 * - a mail draft (送るもの) made only from such a まとまり (`bundleId`) is placed the same way, by a
 *   person and by the AI.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'

const currentUser = vi.hoisted(() => ({ id: 'bl-owner' as string | null }))
vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id ? { id: currentUser.id, email: `${currentUser.id}@bl.example`, name: currentUser.id, image: null, emailVerified: true } : null),
  getUsersByIds: vi.fn().mockImplementation((ids: string[]) => new Map(ids.map(id => [id, { email: `${id}@bl.example`, name: id }]))),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { companiesRoute } from '../../src/routes/companies'
import { recordsRoute } from '../../src/routes/records'
import { recordsAiRoute } from '../../src/routes/records-ai'
import { outboundMailRoute } from '../../src/routes/outbound-mail'
import { viewersRoute } from '../../src/routes/viewers'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const app = new Hono()
app.route('/api/companies', companiesRoute)
app.route('/api/companies/:companyId', recordsRoute)
app.route('/api/companies/:companyId', outboundMailRoute)
app.route('/api/companies/:companyId', viewersRoute)
app.route('/api/records-ai', recordsAiRoute)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

let co: string
const TODAY = '2026-11-20'
/** Not on any list below: a member of the department, an admin, the company owner. */
const OUTSIDERS = ['bl-carol', 'bl-admin', 'bl-owner']

async function call(user: string | null, method: string, path: string, body?: unknown, token?: string) {
  currentUser.id = user
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let json: Json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const person = (user: string, method: string, path: string, body?: unknown) => call(user, method, `/api/companies/${co}${path}`, body)
const ai = (token: string, method: string, path: string, body?: unknown) => call(null, method, `/api/records-ai${path}`, body, token)

async function tokenFor(user: string): Promise<string> {
  const r = await person(user, 'POST', '/me/record-tokens', { conversationId: `conv-${user}`, agent: 'claude-code', scope: 'act' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data.token
}

/** A まとまり (the core プロジェクト) made by `user`: owner-only, or shown to a list. */
async function bundle(user: string, place: { personal: true } | { members: string[] }, title: string): Promise<string> {
  const r = await person(user, 'POST', '/records/item', { type: 'project', title, ...place })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data.record.id
}

/** Nobody in `who` finds the record anywhere: detail, history, query, 探す, 「あなたの番」, 見られる人. */
async function unseenBy(who: string[], id: string, type: string, word: string) {
  const missing = `${type}-0000000000000000`
  for (const u of who) {
    const detail = await person(u, 'GET', `/records/item/${id}`)
    const none = await person(u, 'GET', `/records/item/${missing}`)
    expect(detail.status, `${u} reads ${id}`).toBe(404)
    expect(JSON.stringify(detail.body).replaceAll(id, missing)).toBe(JSON.stringify(none.body))
    expect((await person(u, 'GET', `/records/item/${id}/history`)).status).toBe(404)
    const q = await person(u, 'POST', '/records/query', { type })
    expect(q.status).toBe(200)
    expect(q.body.data.records.map((r: Json) => r.id)).not.toContain(id)
    const text = await person(u, 'POST', '/records/query', { text: word })
    expect(text.body.data.records.map((r: Json) => r.id)).not.toContain(id)
    const found = await person(u, 'POST', '/records/find', { text: word, today: TODAY })
    expect(found.status).toBe(200)
    expect(JSON.stringify(found.body)).not.toContain(id)
    expect(JSON.stringify(found.body)).not.toContain(word)
    const turn = await person(u, 'GET', '/records/my-turn')
    expect(JSON.stringify(turn.body)).not.toContain(id)
    const v = await person(u, 'POST', '/viewers', { records: [id] })
    expect(v.status).toBe(200)
    expect(JSON.stringify(v.body)).not.toContain(id)
  }
}

beforeAll(async () => {
  initDatabase()
  process.env.OPERATOR_USER_IDS = 'bl-owner'
  const created = await call('bl-owner', 'POST', '/api/companies', { name: 'Bundle Leak Co', folderKind: 'none' })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  co = created.body.data.id
  const now = new Date().toISOString()
  for (const [u, role] of [['bl-admin', 'admin'], ['bl-alice', 'member'], ['bl-bob', 'member'], ['bl-carol', 'member']]) {
    db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(`m-${co}-${u}`, u, co, role, now, now)
  }
})

describe('決めたこと for an owner-only まとまり', () => {
  it('a person’s decision stays its owner’s, even with a department folder given', async () => {
    const b = await bundle('bl-alice', { personal: true }, '転職の相談')
    const r = await person('bl-alice', 'POST', '/records/decisions', {
      folder: '営業部', title: '内定を辞退する', why: '条件が合わないため辞退する', source: '自分で決めた', links: { bundle: b },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.record).toMatchObject({ personal: true })
    expect((await person('bl-alice', 'GET', `/records/item/${r.body.data.record.id}`)).status).toBe(200)
    await unseenBy([...OUTSIDERS, 'bl-bob'], r.body.data.record.id, 'decision', '辞退')
  })

  it('the AI’s decision (no folder) stays its owner’s', async () => {
    const b = await bundle('bl-alice', { personal: true }, '副業の相談')
    const token = await tokenFor('bl-alice')
    const r = await ai(token, 'POST', '/decisions', { title: '副業は始めない', why: '本業に集中するため副業は見送る', source: 'AI との相談', links: { bundle: b } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.record).toMatchObject({ personal: true })
    await unseenBy([...OUTSIDERS, 'bl-bob'], r.body.data.record.id, 'decision', '副業')
  })

  it('a decision for a まとまり in a department still needs its folder (nothing else changed)', async () => {
    const open = await person('bl-alice', 'POST', '/records/item', { type: 'project', title: '展示会', folder: '営業部' })
    expect(open.status).toBe(201)
    const bundleId = open.body.data.record.id
    const none = await person('bl-alice', 'POST', '/records/decisions', { title: '出展する', why: '集客のため', source: '会議', links: { bundle: bundleId } })
    expect(none.status).toBe(400)
    const made = await person('bl-alice', 'POST', '/records/decisions', { folder: '営業部', title: '出展する', why: '集客のため', source: '会議', links: { bundle: bundleId } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect((await person('bl-carol', 'GET', `/records/item/${made.body.data.record.id}`)).status).toBe(200)
  })
})

describe('決めたこと for a members-only まとまり', () => {
  it('a listed member’s decision is the list’s alone, by a person and by the AI', async () => {
    const b = await bundle('bl-alice', { members: ['bl-bob'] }, '人事評価の見直し')
    const byPerson = await person('bl-bob', 'POST', '/records/decisions', {
      folder: '営業部', title: '評価面談を年2回にする', why: '評価の納得感を上げるため面談を増やす', source: '打ち合わせ', links: { bundle: b },
    })
    expect(byPerson.status, JSON.stringify(byPerson.body)).toBe(201)
    expect(byPerson.body.data.record).toMatchObject({ membersOnly: true })
    const token = await tokenFor('bl-alice')
    const byAi = await ai(token, 'POST', '/decisions', { title: '評価基準を公開しない', why: '評価基準はまだ案のため公開しない', source: 'AI との相談', links: { bundle: b } })
    expect(byAi.status, JSON.stringify(byAi.body)).toBe(201)
    for (const id of [byPerson.body.data.record.id, byAi.body.data.record.id]) {
      for (const u of ['bl-alice', 'bl-bob']) expect((await person(u, 'GET', `/records/item/${id}`)).status).toBe(200)
      await unseenBy(OUTSIDERS, id, 'decision', '評価')
    }
  })
})

describe('送るもの made only from an owner-only / members-only まとまり', () => {
  async function draft(user: string, bundleId: string, subject: string, token?: string) {
    const recipients = token
      ? await ai(token, 'POST', '/outbound-recipients', { bundleId })
      : await person(user, 'POST', '/outbound-recipients', { bundleId })
    expect(recipients.status, JSON.stringify(recipients.body)).toBe(200)
    const to = recipients.body.data.recipients.find((r: Json) => r.source === 'member').ref
    const body = { bundleId, toRefs: [to], subject, body: 'ご確認をお願いします。' }
    const r = token ? await ai(token, 'POST', '/outbound', body) : await person(user, 'POST', '/outbound', body)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.data.draft.id as string
  }

  it('an owner-only まとまり’s draft is its owner’s, by a person and by the AI', async () => {
    const b = await bundle('bl-alice', { personal: true }, '退職の段取り')
    const token = await tokenFor('bl-alice')
    for (const id of [await draft('bl-alice', b, '退職のご相談'), await draft('bl-alice', b, '退職日のご相談', token)]) {
      expect((await person('bl-alice', 'GET', `/records/item/${id}`)).status).toBe(200)
      await unseenBy([...OUTSIDERS, 'bl-bob'], id, 'outbound_message', '退職')
    }
  })

  it('a members-only まとまり’s draft is the list’s, by a person and by the AI', async () => {
    const b = await bundle('bl-alice', { members: ['bl-bob'] }, '買収の検討')
    const token = await tokenFor('bl-bob')
    for (const id of [await draft('bl-alice', b, '買収条件のご相談'), await draft('bl-bob', b, '買収価格のご相談', token)]) {
      for (const u of ['bl-alice', 'bl-bob']) expect((await person(u, 'GET', `/records/item/${id}`)).status).toBe(200)
      await unseenBy(OUTSIDERS, id, 'outbound_message', '買収')
    }
  })
})

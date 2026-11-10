/**
 * 公開のお願い: the publish of a request checks, inside its own transaction, that the request is
 * still pending with the version the approver looked at (`ShelfPut.fromRequest`), and writes nothing
 * otherwise. The service checks the same before; this guards the moment between the two.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import type { ShelfPut, SkillShelfRepository } from '../../src/ports/skill-shelf'
import { SHELF_REQUEST_LIMITS } from '../../shared/core/skill-shelf'

const TS = '2026-11-09T00:00:00.000Z'
const V1 = '1'.repeat(64)
const V2 = '2'.repeat(64)
let conn: Database.Database
let shelf: SkillShelfRepository

const files = [{ path: 'SKILL.md', base64: Buffer.from('x').toString('base64') }]

function ask(newId: string, version: string) {
  const written = shelf.putRequest({
    newId, departmentId: null, name: 'estimate', by: 'u-bob', at: TS, version, files,
    fileCount: 1, totalBytes: 1, autorun: false, limits: SHELF_REQUEST_LIMITS,
  })
  if (!written.ok) throw new Error(written.reason)
  return written.id
}

const publish = (fromRequest: { id: string; version: string }): ReturnType<SkillShelfRepository['put']> => shelf.put({
  newItemId: 'item-1', kind: 'skill', departmentId: null, name: 'estimate', expected: null, version: fromRequest.version,
  files, fileCount: 1, totalBytes: 1, autorun: false, companyLimitBytes: 1_000_000, at: TS, by: 'u-owner',
  requestedBy: 'u-bob', fromRequest,
} satisfies ShelfPut)

const nothingPublished = () => expect(shelf.itemAt('skill', null, 'estimate')).toBeNull()

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('a', 'a', 'a', 'u-owner', TS, TS)
  for (const u of ['u-owner', 'u-bob']) {
    conn.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`a-${u}`, u, 'a', u === 'u-owner' ? 'owner' : 'member', TS, TS)
  }
  shelf = sqliteCompanyData(conn).forCompany('a').skillShelf
})

describe('publishing from a request (adapter)', () => {
  it('another version than the request holds: nothing is written', () => {
    const id = ask('r-1', V1)
    expect(publish({ id, version: V2 })).toEqual({ ok: false, reason: 'request-changed' })
    nothingPublished()
    expect(shelf.request(id)).toMatchObject({ state: 'pending', version: V1 })
  })

  it('a request that is gone (sent again under a new id): nothing is written', () => {
    const old = ask('r-1', V1)
    const now = ask('r-2', V2)
    expect(shelf.request(old)).toBeNull()
    expect(publish({ id: old, version: V1 })).toEqual({ ok: false, reason: 'request-changed' })
    nothingPublished()
    expect(shelf.request(now)).toMatchObject({ state: 'pending' })
  })

  it('a request already decided: nothing is written', () => {
    const id = ask('r-1', V1)
    expect(shelf.declineRequest(id, V1, { by: 'u-owner', at: TS, reason: null })).toBe(true)
    expect(publish({ id, version: V1 })).toEqual({ ok: false, reason: 'request-changed' })
    nothingPublished()
    expect(shelf.request(id)).toMatchObject({ state: 'declined' })
  })

  it('the version looked at, still pending: published and marked in the same write', () => {
    const id = ask('r-1', V1)
    expect(publish({ id, version: V1 })).toMatchObject({ ok: true, changed: true })
    expect(shelf.itemAt('skill', null, 'estimate')).toMatchObject({ currentVersion: V1 })
    expect(shelf.request(id)).toMatchObject({ state: 'published', publishedVersion: V1, decidedBy: 'u-owner' })
    expect(shelf.requestFiles(id)).toBeNull()
  })
})

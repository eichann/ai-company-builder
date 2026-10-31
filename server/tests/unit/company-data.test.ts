/**
 * The company handle (ports/company-data.ts) against the real schema: a
 * handle opened for company A cannot see, change, reorder or delete company
 * B's rows, even when given B's ids — the guarantee every service relies on
 * instead of checking "is this id in my company?" first.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyData } from '../../src/adapters/sqlite/company-data'
import type { CompanyDataSource } from '../../src/ports/company-data'

const TS = '2026-10-31T00:00:00.000Z'
let conn: Database.Database
let source: CompanyDataSource

function company(id: string) {
  conn.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, id, 'u', TS, TS)
}

function department(companyId: string, id: string, folder: string, sortOrder: number) {
  source.forCompany(companyId).departments.insert({
    id, name: folder, nameEn: null, folder, icon: 'Folder', color: '#000000', description: null, sortOrder, createdAt: TS, createdBy: 'u',
  })
}

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
  source = sqliteCompanyData(conn)
  company('a')
  company('b')
  department('a', 'a-sales', '営業部', 0)
  department('b', 'b-sales', '営業部', 0)
  department('b', 'b-hr', '人事', 1)
})

const rowOf = (id: string) => conn.prepare('SELECT * FROM departments WHERE id = ?').get(id)

describe('company handle: departments', () => {
  it('a new row belongs to the handle’s company', () => {
    expect(rowOf('a-sales')).toMatchObject({ company_id: 'a' })
    expect(rowOf('b-hr')).toMatchObject({ company_id: 'b' })
  })

  it('reads only its own company', () => {
    const a = source.forCompany('a').departments
    expect(a.list().map(d => d.id)).toEqual(['a-sales'])
    expect(a.listUnordered().map(d => d.id)).toEqual(['a-sales'])
    expect(a.folders()).toEqual([{ id: 'a-sales', folder: '営業部' }])
    expect(a.count()).toBe(1)
    expect(a.maxSortOrder()).toBe(0)
    expect(a.find('b-hr')).toBeUndefined()
    expect(a.exists('b-hr')).toBe(false)
    expect(a.find('a-sales')).toMatchObject({ id: 'a-sales', company_id: 'a' })
  })

  it('cannot change, reorder or delete another company’s department', () => {
    const a = source.forCompany('a').departments
    const before = rowOf('b-hr')
    a.update('b-hr', { name: '乗っ取り', folder: 'x', isActive: false }, '2026-11-01T00:00:00.000Z')
    a.setSortOrders([{ id: 'b-hr', sortOrder: 99 }], '2026-11-01T00:00:00.000Z')
    a.delete('b-hr')
    expect(rowOf('b-hr')).toEqual(before)
    expect(source.forCompany('b').departments.count()).toBe(2)
  })

  it('changes its own department', () => {
    const a = source.forCompany('a').departments
    a.update('a-sales', { name: '営業' }, '2026-11-01T00:00:00.000Z')
    expect(a.find('a-sales')).toMatchObject({ name: '営業', updated_at: '2026-11-01T00:00:00.000Z' })
    a.delete('a-sales')
    expect(a.count()).toBe(0)
  })

  it('refuses to open a handle without a company', () => {
    expect(() => source.forCompany('')).toThrow()
  })
})

/**
 * The SQLite repositories against a fresh in-memory database with the real
 * schema (initDatabase). The routes' integration tests cover them through
 * the API; this pins what callers rely on: orderings, row shapes, the
 * invitation compare-and-set and transaction rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase } from '../../src/db'
import { sqliteCompanyRepository } from '../../src/adapters/sqlite/companies'
import { sqliteMembershipRepository } from '../../src/adapters/sqlite/memberships'
import { sqliteInvitationRepository } from '../../src/adapters/sqlite/invitations'
import { sqliteDepartmentRepository } from '../../src/adapters/sqlite/departments'
import { sqliteTransactions } from '../../src/adapters/sqlite/transactions'

let conn: Database.Database

beforeEach(() => {
  conn = new Database(':memory:')
  initDatabase(conn)
})

function company(id: string, createdAt: string) {
  sqliteCompanyRepository(conn).insert({ id, name: `Co ${id}`, slug: `co-${id}`, ownerId: 'u1', repoPath: null, createdAt })
}

describe('companies', () => {
  it('lists a user’s companies newest first, every column plus the role', () => {
    const repo = sqliteCompanyRepository(conn)
    const members = sqliteMembershipRepository(conn)
    company('a', '2026-01-01T00:00:00.000Z')
    company('b', '2026-02-01T00:00:00.000Z')
    members.insert({ id: 'm1', userId: 'u1', companyId: 'a', role: 'owner', createdAt: '2026-01-01T00:00:00.000Z' })
    members.insert({ id: 'm2', userId: 'u1', companyId: 'b', role: 'member', createdAt: '2026-02-01T00:00:00.000Z' })

    const rows = repo.listForUser('u1')
    expect(rows.map(r => [r.id, r.role])).toEqual([['b', 'member'], ['a', 'owner']])
    expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'id', 'name', 'owner_id', 'repo_path', 'role', 'slug', 'updated_at'])
    expect(rows[0].updated_at).toBe(rows[0].created_at)
    expect(repo.listForUser('nobody')).toEqual([])
  })

  it('finds, renames and knows taken slugs', () => {
    const repo = sqliteCompanyRepository(conn)
    company('a', '2026-01-01T00:00:00.000Z')
    expect(repo.isSlugTaken('co-a')).toBe(true)
    expect(repo.isSlugTaken('co-b')).toBe(false)
    repo.rename('a', '新しい名前', '2026-03-01T00:00:00.000Z')
    expect(repo.findById('a')).toMatchObject({ name: '新しい名前', updated_at: '2026-03-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' })
    expect(repo.findById('missing')).toBeUndefined()
  })
})

describe('memberships', () => {
  it('roles, oldest-first listing, owner count, role change and removal', () => {
    company('a', '2026-01-01T00:00:00.000Z')
    const repo = sqliteMembershipRepository(conn)
    repo.insert({ id: 'm2', userId: 'u2', companyId: 'a', role: 'member', createdAt: '2026-01-02T00:00:00.000Z' })
    repo.insert({ id: 'm1', userId: 'u1', companyId: 'a', role: 'owner', createdAt: '2026-01-01T00:00:00.000Z' })

    expect(repo.roleOf('a', 'u1')).toBe('owner')
    expect(repo.roleOf('a', 'nobody')).toBeNull()
    expect(repo.listByCompany('a')).toEqual([
      { id: 'm1', user_id: 'u1', company_id: 'a', role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', user_id: 'u2', company_id: 'a', role: 'member', created_at: '2026-01-02T00:00:00.000Z' },
    ])
    expect(repo.countOwners('a')).toBe(1)

    repo.updateRole('a', 'u2', 'owner', '2026-01-03T00:00:00.000Z')
    expect(repo.countOwners('a')).toBe(2)
    expect(conn.prepare('SELECT updated_at FROM memberships WHERE id = ?').get('m2')).toEqual({ updated_at: '2026-01-03T00:00:00.000Z' })

    repo.delete('a', 'u2')
    expect(repo.roleOf('a', 'u2')).toBeNull()
    expect(() => repo.insert({ id: 'm3', userId: 'u1', companyId: 'a', role: 'member', createdAt: 'x' })).toThrow(/UNIQUE/)
  })
})

describe('invitations', () => {
  it('lists newest first with the company name, finds by token, consumes once', () => {
    company('a', '2026-01-01T00:00:00.000Z')
    const repo = sqliteInvitationRepository(conn)
    repo.insert({ id: 'i1', companyId: 'a', token: 't1', role: 'member', createdBy: 'u1', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    repo.insert({ id: 'i2', companyId: 'a', token: 't2', role: 'admin', createdBy: 'u1', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })

    const rows = repo.listByCompany('a')
    expect(rows.map(r => r.id)).toEqual(['i2', 'i1'])
    expect(rows[0]).toMatchObject({ company_name: 'Co a', used_by: null, signup_claimed_at: null, signup_user_id: null })
    expect(repo.findByToken('t1')?.id).toBe('i1')
    expect(repo.findByToken('nope')).toBeUndefined()
    expect(repo.existsInCompany('i1', 'a')).toBe(true)
    expect(repo.existsInCompany('i1', 'b')).toBe(false)

    expect(repo.consume('i1', 'u9')).toBe(true)
    expect(repo.consume('i1', 'u8')).toBe(false)
    expect(repo.findByToken('t1')?.used_by).toBe('u9')

    repo.delete('i2')
    expect(repo.findByToken('t2')).toBeUndefined()
  })
})

describe('departments', () => {
  it('inserts a top-level active department', () => {
    company('a', '2026-01-01T00:00:00.000Z')
    sqliteDepartmentRepository(conn).insert({
      id: 'd1', companyId: 'a', name: '営業部', nameEn: 'Sales', folder: '営業部', icon: 'Storefront',
      color: '#3b82f6', description: null, sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1',
    })
    expect(conn.prepare('SELECT * FROM departments').get()).toMatchObject({
      id: 'd1', parent_id: null, is_active: 1, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', created_by: 'u1',
    })
  })
})

describe('transactions', () => {
  it('commits together or rolls back together', () => {
    company('a', '2026-01-01T00:00:00.000Z')
    const tx = sqliteTransactions(conn)
    const members = sqliteMembershipRepository(conn)
    expect(() => tx.run(() => {
      members.insert({ id: 'm1', userId: 'u1', companyId: 'a', role: 'member', createdAt: 'x' })
      throw new Error('boom')
    })).toThrow('boom')
    expect(members.roleOf('a', 'u1')).toBeNull()
    expect(tx.run(() => {
      members.insert({ id: 'm1', userId: 'u1', companyId: 'a', role: 'member', createdAt: 'x' })
      return tx.run(() => 42)
    })).toBe(42)
    expect(members.roleOf('a', 'u1')).toBe('member')
  })
})

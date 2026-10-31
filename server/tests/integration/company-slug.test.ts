/**
 * Integration Test: a new company's slug says nothing about other companies
 * (2026-10-31).
 *
 * Slugs are unique across the server. The old rule handed out `abe`, or
 * `abe-2` when another company already had `abe` — so whoever created a
 * company learned that another tenant used that name. Now every new slug is
 * the sanitized base plus a suffix from the new company's own id, the same
 * whether or not the base is in use; existing slugs stay as they are.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

vi.setConfig({ testTimeout: 180_000 }) // four company creations (repository + seeding) on a busy runner

import { db, initDatabase } from '../../src/db'
import { services } from '../../src/composition'

const ownSuffix = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)

beforeAll(() => {
  initDatabase()
  const at = new Date().toISOString()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('slug-legacy', 'Legacy', 'abe', 'u-legacy', at, at)
})

describe('company slugs', () => {
  it('a slug another company already has gives the same kind of answer as a free one, and the old slug is untouched', async () => {
    const taken = await services.companies.create('u-a', 'Abe Shoten', 'abe') // `abe` belongs to slug-legacy
    const free = await services.companies.create('u-b', 'Free', 'nobody-has-this')
    const byName = await services.companies.create('u-c', 'Abe Shoten', undefined)
    const japanese = await services.companies.create('u-d', '阿部商店', undefined)

    expect(taken.slug).toBe(`abe-${ownSuffix(taken.id)}`)
    expect(free.slug).toBe(`nobody-has-this-${ownSuffix(free.id)}`)
    expect(byName.slug).toBe(`abe-shoten-${ownSuffix(byName.id)}`)
    expect(japanese.slug).toBe(`company-${ownSuffix(japanese.id)}`)
    // nothing like the old `abe-2`
    for (const c of [taken, free, byName, japanese]) expect(c.slug).not.toMatch(/-\d$/)

    expect((db.prepare('SELECT slug FROM companies WHERE id = ?').get('slug-legacy') as { slug: string }).slug).toBe('abe')
  })
})

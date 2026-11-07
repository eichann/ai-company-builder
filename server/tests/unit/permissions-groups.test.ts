/**
 * Unit Test: the rule subject 'group' and read-restricted places (shared/core/permissions.ts,
 * server.md "Groups", owner decisions 2026-11-07) — pure, no DB.
 *
 * Guards:
 * - a group rule matches exactly the members in it (`memberIds`); absent = nobody;
 * - precedence: user > (department ∪ group, one level) > role > everyone — a group never takes
 *   away what the person's department gives on the same place, a user rule still decides alone;
 * - a read-restricted place gates everything inside it (narrow only), like a private folder:
 *   a deeper rule cannot widen past it; owners/admins always read;
 * - a place that is not marked read-restricted is not a gate (companies with the shared folder:
 *   unchanged);
 * - writeAccessSummary / scopesKnownTo leave out a read-restricted place the member cannot read
 *   (its name), and keep it for its readers.
 */
import { describe, it, expect } from 'vitest'
import {
  canReadGate,
  isGate,
  resolveAccess,
  scopesKnownTo,
  writeAccessSummary,
  type PermissionRepository,
  type ScopeRule,
  type ScopeWithRules,
} from '../../shared/core/permissions'
import { placeWithin } from '../../src/services/record-engine/bundle-place'

const CO = 'co'
let seq = 0
const rule = (subjectType: ScopeRule['subjectType'], subjectId: string | null, rw: string, memberIds?: string[]): ScopeRule => ({
  id: `r${++seq}`, subjectType, subjectId, canRead: rw.includes('r'), canWrite: rw.includes('w'), ...(memberIds ? { memberIds } : {}),
})
const everyone = (rw: string) => rule('everyone', null, rw)
const user = (id: string, rw: string) => rule('user', id, rw)
const group = (id: string, rw: string, memberIds?: string[]) => rule('group', id, rw, memberIds)
const department = (id: string, rw: string, memberIds?: string[]) => rule('department', id, rw, memberIds)
const scope = (id: string, path: string, rules: ScopeRule[], extra: Partial<ScopeWithRules> = {}): ScopeWithRules => ({
  id, path, kind: path === '' ? 'company' : path.includes('/') ? 'folder' : 'department', departmentId: null, repoId: null, rules, ...extra,
})
const ROLES: Record<string, string> = { owner: 'owner', admin: 'admin', alice: 'member', bob: 'member', carol: 'member' }
const repo = (scopes: ScopeWithRules[]): PermissionRepository => ({
  getMemberRole: (companyId, userId) => (companyId === CO ? ROLES[userId] ?? null : null),
  listScopes: () => scopes,
})
const access = (scopes: ScopeWithRules[], who: string, path: string) => {
  const a = resolveAccess(CO, who, path, repo(scopes))
  return `${a.read ? 'r' : '-'}${a.write ? 'w' : '-'}`
}

describe('the group subject', () => {
  const root = scope('root', '', [everyone('rw')])

  it('matches exactly the members in it; absent members match nobody', () => {
    const hr = scope('hr', '人事部', [everyone('-'), group('g-saiyo', 'r', ['alice'])], { readRestricted: true })
    expect(access([root, hr], 'alice', '人事部')).toBe('r-')
    expect(access([root, hr], 'bob', '人事部')).toBe('--')
    const noMembers = scope('hr', '人事部', [everyone('-'), group('g-saiyo', 'rw')], { readRestricted: true })
    expect(access([root, noMembers], 'alice', '人事部')).toBe('--')
  })

  it('shares the department level: someone in both gets the union, never less than their department gives', () => {
    const hr = scope('hr', '人事部', [everyone('-'), department('d-hr', 'rw', ['alice', 'bob']), group('g-saiyo', 'r', ['alice', 'carol'])], { readRestricted: true })
    expect(access([root, hr], 'alice', '人事部')).toBe('rw')
    expect(access([root, hr], 'bob', '人事部')).toBe('rw')
    expect(access([root, hr], 'carol', '人事部')).toBe('r-')
  })

  it('beats role and everyone, and is beaten by a user rule', () => {
    const place = scope('p', '営業部', [everyone('rw'), rule('role', 'member', 'rw'), group('g', 'r', ['alice', 'bob']), user('bob', '-')])
    expect(access([root, place], 'alice', '営業部')).toBe('r-')
    expect(access([root, place], 'bob', '営業部')).toBe('--')
    expect(access([root, place], 'carol', '営業部')).toBe('rw')
  })

  it('owners and admins read and write whatever a group says', () => {
    const hr = scope('hr', '人事部', [everyone('-'), group('g', 'r', ['alice'])], { readRestricted: true })
    expect(access([root, hr], 'owner', '人事部/採用')).toBe('rw')
    expect(access([root, hr], 'admin', '人事部')).toBe('rw')
  })
})

describe('read-restricted places gate what is inside them', () => {
  const root = scope('root', '', [everyone('rw')])
  const hr = scope('hr', '人事部', [everyone('-'), group('g', 'rw', ['alice'])], { readRestricted: true })

  it('a deeper rule cannot widen past the place', () => {
    const inside = scope('in', '人事部/採用', [everyone('rw')])
    expect(access([root, hr, inside], 'bob', '人事部/採用')).toBe('--')
    expect(access([root, hr, inside], 'alice', '人事部/採用')).toBe('rw')
    // …but it narrows.
    const narrow = scope('in', '人事部/採用', [everyone('-'), user('carol', 'r')], { readRestricted: true })
    expect(access([root, hr, narrow], 'alice', '人事部/採用')).toBe('--')
    expect(access([root, hr, narrow], 'carol', '人事部/採用')).toBe('--')
    expect(access([root, hr, narrow], 'owner', '人事部/採用')).toBe('rw')
  })

  it('the same rules without the mark (a company with the shared folder) are not a gate — unchanged', () => {
    const plain = scope('hr', '人事部', [everyone('-'), group('g', 'rw', ['alice'])])
    const inside = scope('in', '人事部/採用', [everyone('rw')])
    expect(isGate(plain)).toBe(false)
    expect(access([root, plain, inside], 'bob', '人事部/採用')).toBe('rw')
  })

  it('a task is "wider" than its まとまり when a group member reads only the task (bundle-place representatives)', () => {
    const roleOf = (id: string) => ROLES[id] ?? null
    const task = { id: 'task-1', type: 'task', scopeId: null, path: null, folder: '人事部', personalOwner: null, members: null }
    const bundle = { ...task, id: 'project-1', type: 'project', folder: '人事部/採用' }
    const scopes = [
      root,
      scope('hr', '人事部', [everyone('-'), group('g', 'rw', ['alice', 'carol'])], { readRestricted: true }),
      scope('in', '人事部/採用', [everyone('-'), user('alice', 'rw')], { readRestricted: true }),
    ]
    // carol is named by nothing but the group: she reads the task, not the まとまり.
    expect(placeWithin(CO, scopes, roleOf, task, bundle)).toBe(false)
    expect(placeWithin(CO, scopes, roleOf, bundle, task)).toBe(true)
  })

  it('a member who cannot read the place does not learn of it; its readers do', () => {
    const inside = scope('in', '人事部/採用', [everyone('-'), user('alice', 'rw')], { readRestricted: true })
    // The company root read-only, so the summary lists places instead of answering `all: true`.
    const all = [scope('root', '', [everyone('r')]), hr, inside]
    expect(canReadGate(hr, 'bob', 'member')).toBe(false)
    expect(scopesKnownTo(all, 'bob', 'member').map(s => s.path)).toEqual([''])
    expect(scopesKnownTo(all, 'alice', 'member').map(s => s.path)).toEqual(['', '人事部', '人事部/採用'])
    expect(scopesKnownTo(all, 'admin', 'admin')).toHaveLength(3)
    expect(JSON.stringify(writeAccessSummary(all, 'bob', 'member'))).not.toContain('人事部')
    expect(writeAccessSummary(all, 'alice', 'member').scopes.map(s => s.path)).toEqual(['', '人事部', '人事部/採用'])
  })
})

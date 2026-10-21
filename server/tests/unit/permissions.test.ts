/**
 * Unit Test: effective permission resolution (lib/permissions.ts) — pure, no DB.
 */
import { describe, it, expect } from 'vitest'
import {
  compareScopePaths,
  normalizeScopePath,
  resolveAccess,
  summarizeRules,
  type PermissionRepository,
  type ScopeRule,
  type ScopeWithRules,
} from '../../src/lib/permissions'

const CO = 'co'

let ruleSeq = 0
const rule = (subjectType: ScopeRule['subjectType'], subjectId: string | null, rw: 'rw' | 'r' | 'w' | '-'): ScopeRule => ({
  id: `r${++ruleSeq}`,
  subjectType,
  subjectId,
  canRead: rw.includes('r'),
  canWrite: rw.includes('w'),
})
const everyone = (rw: 'rw' | 'r' | 'w' | '-') => rule('everyone', null, rw)
const role = (name: string, rw: 'rw' | 'r' | 'w' | '-') => rule('role', name, rw)
const user = (id: string, rw: 'rw' | 'r' | 'w' | '-') => rule('user', id, rw)

const scope = (id: string, path: string, rules: ScopeRule[], kind: ScopeWithRules['kind'] = 'folder'): ScopeWithRules => ({
  id, path, kind, departmentId: kind === 'department' ? `d-${id}` : null, repoId: null, rules,
})

function repoOf(scopes: ScopeWithRules[], roles: Record<string, string>): PermissionRepository {
  return {
    getMemberRole: (companyId, userId) => (companyId === CO ? roles[userId] ?? null : null),
    listScopes: (companyId) => (companyId === CO ? scopes : []),
  }
}

const ROLES = { owner: 'owner', admin: 'admin', alice: 'member', bob: 'member', mgr: 'member' }

// The seeded default: company-wide everyone rw, departments with no rules.
const DEFAULT = [
  scope('company', '', [everyone('rw')], 'company'),
  scope('content', 'コンテンツ', [], 'department'),
  scope('sales', '営業部', [], 'department'),
]

// A company that has started restricting things.
const RESTRICTED = [
  scope('company', '', [everyone('r')], 'company'),
  scope('content', 'コンテンツ', [everyone('rw')], 'department'),
  scope('students', 'コンテンツ/受講生情報', [user('alice', 'rw'), role('member', 'r')]),
  scope('empty', 'コンテンツ/受講生情報/添付', []),
  scope('hr', '人事部', [user('bob', 'r'), user('bob', 'w')], 'department'),
  scope('secret', '人事部/給与', [everyone('-')]),
  scope('nobody', '経理部', [user('ghost', 'rw')], 'department'),
]

describe('resolveAccess', () => {
  const cases: Array<{
    name: string
    scopes: ScopeWithRules[]
    user: string
    path: string
    read: boolean
    write: boolean
    reason: string
    scopeId: string | null
  }> = [
    // Default = today's behaviour: everyone reads and writes everything.
    { name: 'default: member at the root', scopes: DEFAULT, user: 'alice', path: '', read: true, write: true, reason: 'rule', scopeId: 'company' },
    { name: 'default: member in a department inherits from company', scopes: DEFAULT, user: 'alice', path: 'コンテンツ/記事/a.md', read: true, write: true, reason: 'rule', scopeId: 'company' },
    { name: 'default: member at a path with no scope', scopes: DEFAULT, user: 'bob', path: 'misc/notes', read: true, write: true, reason: 'rule', scopeId: 'company' },

    // owner / admin always rw, whatever the rules say.
    { name: 'owner where everyone is denied', scopes: RESTRICTED, user: 'owner', path: '人事部/給与', read: true, write: true, reason: 'role', scopeId: null },
    { name: 'admin where only alice is listed', scopes: RESTRICTED, user: 'admin', path: '経理部', read: true, write: true, reason: 'role', scopeId: null },

    // Deeper scope with rules overrides the parent.
    { name: 'company read-only applies outside departments', scopes: RESTRICTED, user: 'bob', path: '総務/x', read: true, write: false, reason: 'rule', scopeId: 'company' },
    { name: 'department rw overrides company r', scopes: RESTRICTED, user: 'bob', path: 'コンテンツ/ブログ', read: true, write: true, reason: 'rule', scopeId: 'content' },
    { name: 'deny-all folder overrides department grant', scopes: RESTRICTED, user: 'bob', path: '人事部/給与/2026.xlsx', read: false, write: false, reason: 'no-rule', scopeId: 'secret' },

    // user > role > everyone, union within a level.
    { name: 'user rule beats role rule', scopes: RESTRICTED, user: 'alice', path: 'コンテンツ/受講生情報/list.csv', read: true, write: true, reason: 'rule', scopeId: 'students' },
    { name: 'role rule applies when no user rule matches', scopes: RESTRICTED, user: 'bob', path: 'コンテンツ/受講生情報', read: true, write: false, reason: 'rule', scopeId: 'students' },
    { name: 'multiple user rules are unioned', scopes: RESTRICTED, user: 'bob', path: '人事部/評価', read: true, write: true, reason: 'rule', scopeId: 'hr' },
    { name: 'a scope with rules but none for the user denies', scopes: RESTRICTED, user: 'alice', path: '経理部/月次', read: false, write: false, reason: 'no-rule', scopeId: 'nobody' },
    { name: 'user rule narrows everyone on the same scope', scopes: [scope('c', '', [everyone('rw'), user('alice', 'r')], 'company')], user: 'alice', path: 'x', read: true, write: false, reason: 'rule', scopeId: 'c' },

    // Scopes without rules are transparent.
    { name: 'empty scope inherits from nearest ruled ancestor', scopes: RESTRICTED, user: 'bob', path: 'コンテンツ/受講生情報/添付/a.pdf', read: true, write: false, reason: 'rule', scopeId: 'students' },
    { name: 'no scope with rules anywhere denies', scopes: [scope('c', '', [], 'company')], user: 'alice', path: 'x', read: false, write: false, reason: 'no-rule', scopeId: null },

    // Department managers get nothing extra from being manager.
    { name: 'manager has only what the rules give', scopes: RESTRICTED, user: 'mgr', path: '人事部/給与', read: false, write: false, reason: 'no-rule', scopeId: 'secret' },

    // Not a member.
    { name: 'non-member gets nothing', scopes: DEFAULT, user: 'stranger', path: '', read: false, write: false, reason: 'not-member', scopeId: null },

    // Path normalisation.
    { name: 'leading/trailing/double slashes and backslashes are normalised', scopes: RESTRICTED, user: 'bob', path: '/コンテンツ\\\\受講生情報//', read: true, write: false, reason: 'rule', scopeId: 'students' },
    { name: 'NFD input matches an NFC scope', scopes: RESTRICTED, user: 'bob', path: 'コンテンツ/ブログ'.normalize('NFD'), read: true, write: true, reason: 'rule', scopeId: 'content' },
    { name: 'a sibling with a common prefix is not a child', scopes: [scope('c', '', [everyone('r')], 'company'), scope('a', 'ab', [everyone('rw')])], user: 'bob', path: 'abc', read: true, write: false, reason: 'rule', scopeId: 'c' },
    { name: 'path escaping the repo is denied', scopes: DEFAULT, user: 'bob', path: '../other', read: false, write: false, reason: 'not-member', scopeId: null },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      const r = resolveAccess(CO, tc.user, tc.path, repoOf(tc.scopes, ROLES))
      expect({ read: r.read, write: r.write, reason: r.source.reason, scopeId: r.source.scopeId })
        .toEqual({ read: tc.read, write: tc.write, reason: tc.reason, scopeId: tc.scopeId })
    })
  }

  it('reports the deciding scope path', () => {
    const r = resolveAccess(CO, 'bob', 'コンテンツ/受講生情報/添付', repoOf(RESTRICTED, ROLES))
    expect(r.source.path).toBe('コンテンツ/受講生情報')
  })
})

describe('helpers', () => {
  it('normalizeScopePath', () => {
    expect(normalizeScopePath('')).toBe('')
    expect(normalizeScopePath('/')).toBe('')
    expect(normalizeScopePath('a//b/')).toBe('a/b')
    expect(normalizeScopePath('a\\b')).toBe('a/b')
    expect(normalizeScopePath('a/./b')).toBeNull()
    expect(normalizeScopePath('a/../b')).toBeNull()
    expect(normalizeScopePath('ガ'.normalize('NFD'))).toBe('ガ')
  })

  it('compareScopePaths puts parents before children', () => {
    const sorted = ['b', 'a/b', '', 'a', 'a/a', 'ab'].sort(compareScopePaths)
    expect(sorted).toEqual(['', 'a', 'a/a', 'a/b', 'ab', 'b'])
  })

  it('summarizeRules', () => {
    expect(summarizeRules([everyone('rw')])).toBe('everyone-rw')
    expect(summarizeRules([everyone('rw'), user('a', 'rw')])).toBe('everyone-rw')
    expect(summarizeRules([everyone('rw'), user('a', 'r')])).toBe('everyone-r')
    expect(summarizeRules([everyone('r')])).toBe('everyone-r')
    expect(summarizeRules([everyone('r'), role('admin', 'rw')])).toBe('everyone-r')
    expect(summarizeRules([everyone('rw'), user('a', '-')])).toBe('restricted')
    expect(summarizeRules([user('a', 'rw')])).toBe('restricted')
    expect(summarizeRules([])).toBe('restricted')
  })
})

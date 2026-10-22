/**
 * Unit tests: private folders' pure parts.
 *
 * - resolveAccess: a private folder's own rules gate everything inside it;
 *   a deeper rule can narrow, never widen; a private scope without rules denies.
 * - writeAccessSummary hides private folders the member cannot read.
 * - push-check policy: reserved paths (company repository only), NFC + A–Z
 *   folding, the pusher's own spelling of the reserved prefix; the scope
 *   repository's write gate prefixes paths; the company repository's write
 *   gate ignores private scopes.
 * - Path normalisation in shared/ and isPathUsable (POST /paths/check).
 */
import { describe, it, expect } from 'vitest'
import {
  resolveAccess,
  writeAccessSummary,
  type PermissionRepository,
  type ScopeRule,
  type ScopeWithRules,
} from '../../src/lib/permissions'
import { reservedPathsFor, reservedPrefixOf, writeGateFor, parsePushPolicy, type PushPolicy } from '../../src/lib/push-check/policy'
import { isPathUsable } from '../../src/lib/private-folders'
import {
  normalizeReservedPath,
  reservedPathCandidates,
  reservedPathMessage,
} from '../../shared/types/private-folders'

const rule = (subjectType: ScopeRule['subjectType'], subjectId: string | null, canRead: boolean, canWrite: boolean): ScopeRule =>
  ({ id: `${subjectType}-${subjectId}-${canRead}-${canWrite}`, subjectType, subjectId, canRead, canWrite })

const ROOT: ScopeWithRules = { id: 'root', path: '', kind: 'company', departmentId: null, repoId: null, rules: [rule('everyone', null, true, true)] }
const HR: ScopeWithRules = { id: 'hr', path: '人事', kind: 'department', departmentId: 'd-hr', repoId: null, rules: [] }
const EVAL: ScopeWithRules = {
  id: 'eval', path: '人事/評価', kind: 'folder', departmentId: null, repoId: 'repo-eval',
  rules: [rule('everyone', null, false, false), rule('user', 'viewer', true, false), rule('user', 'editor', true, true)],
}

function repoOf(scopes: ScopeWithRules[], roles: Record<string, string>): PermissionRepository {
  return { getMemberRole: (_c, u) => roles[u] ?? null, listScopes: () => scopes }
}
const ROLES = { owner: 'owner', viewer: 'member', editor: 'member', other: 'member' }

describe('resolveAccess with private folders', () => {
  const repo = repoOf([ROOT, HR, EVAL], ROLES)
  it('only the folder\'s viewers read it; editors write; owners always', () => {
    expect(resolveAccess('c', 'other', '人事/評価/x.md', repo)).toMatchObject({ read: false, write: false })
    expect(resolveAccess('c', 'viewer', '人事/評価/x.md', repo)).toMatchObject({ read: true, write: false })
    expect(resolveAccess('c', 'editor', '人事/評価', repo)).toMatchObject({ read: true, write: true })
    expect(resolveAccess('c', 'owner', '人事/評価', repo)).toMatchObject({ read: true, write: true })
    expect(resolveAccess('c', 'other', '人事/その他.md', repo)).toMatchObject({ read: true, write: true })
  })

  it('a rule deeper inside cannot widen access past the private folder\'s own rules', () => {
    const sub: ScopeWithRules = { id: 'sub', path: '人事/評価/共有', kind: 'folder', departmentId: null, repoId: null, rules: [rule('everyone', null, true, true)] }
    const r = repoOf([ROOT, HR, EVAL, sub], ROLES)
    expect(resolveAccess('c', 'other', '人事/評価/共有/a.md', r)).toMatchObject({ read: false, write: false })
    expect(resolveAccess('c', 'viewer', '人事/評価/共有/a.md', r)).toMatchObject({ read: true, write: true })
  })

  it('a private scope without rules denies instead of inheriting', () => {
    const bare = { ...EVAL, rules: [] }
    const r = repoOf([ROOT, HR, bare], ROLES)
    expect(resolveAccess('c', 'other', '人事/評価/x', r)).toMatchObject({ read: false, write: false })
  })
})

describe('writeAccessSummary', () => {
  it('leaves out private folders the member cannot read (no names)', () => {
    const s = writeAccessSummary([ROOT, HR, EVAL], 'other', 'member')
    expect(JSON.stringify(s)).not.toContain('評価')
    expect(s.all).toBe(true)
  })
  it('lists a readable one with the member\'s write', () => {
    expect(writeAccessSummary([ROOT, HR, EVAL], 'viewer', 'member').scopes).toContainEqual({ path: '人事/評価', write: false })
    expect(writeAccessSummary([ROOT, HR, EVAL], 'editor', 'member')).toEqual({ all: true, scopes: [] })
  })
})

describe('push-check policy: reserved paths and scope repositories', () => {
  const policy: PushPolicy = { version: 1, companyId: 'c', pusher: { id: 'other', role: 'member' }, scopes: [ROOT, HR, EVAL] }

  it('reserves private paths in the company repository only', () => {
    expect(reservedPathsFor(policy)).toEqual(['人事/評価'])
    expect(reservedPathsFor({ ...policy, scopePath: '人事/評価' })).toEqual([])
  })

  it('matches at or under, NFC and A–Z folded, and returns the pusher\'s spelling', () => {
    const reserved = reservedPathsFor({ ...policy, scopes: [ROOT, { ...EVAL, path: 'Sales/Secret' }] })
    expect(reservedPrefixOf('sales/SECRET/a.md', reserved)).toBe('sales/SECRET')
    expect(reservedPrefixOf('Sales/Secret', reserved)).toBe('Sales/Secret')
    expect(reservedPrefixOf('Sales/Secrets/a.md', reserved)).toBeNull()
    expect(reservedPrefixOf('Sales', reserved)).toBeNull()
    const nfd = '人事/評価'.normalize('NFD') + '/x.md'
    expect(reservedPrefixOf(nfd, reservedPathsFor(policy))).toBe('人事/評価'.normalize('NFD'))
    // Full-width / accented letters are not folded (as everywhere in the checker).
    expect(reservedPrefixOf('ｓales/secret/a', reservedPathsFor({ ...policy, scopes: [{ ...EVAL, path: 'sales/secret' }] }))).toBeNull()
  })

  it('company repository write gate ignores private scopes (no WRITE_DENIED there, only RESERVED_PATH)', () => {
    expect(writeGateFor(policy).kind).toBe('allow-all')
  })

  it('scope repository write gate checks <scopePath>/<path>', () => {
    const viewer = writeGateFor({ ...policy, pusher: { id: 'viewer', role: 'member' }, scopePath: '人事/評価' })
    const editor = writeGateFor({ ...policy, pusher: { id: 'editor', role: 'member' }, scopePath: '人事/評価' })
    expect(viewer.kind).toBe('check')
    expect(viewer.kind === 'check' && viewer.canWrite('a.md')).toBe(false)
    expect(editor.kind === 'check' && editor.canWrite('a.md')).toBe(true)
    expect(writeGateFor({ ...policy, pusher: { id: 'o', role: 'owner' }, scopePath: '人事/評価' }).kind).toBe('allow-all')
    expect(writeGateFor({ ...policy, pusher: null, scopePath: '人事/評価' }).kind).toBe('deny-all')
  })

  it('a snapshot naming a scopePath that is not a private folder is invalid', () => {
    expect(() => parsePushPolicy(JSON.stringify({ ...policy, scopePath: '人事' }))).toThrow()
    expect(parsePushPolicy(JSON.stringify({ ...policy, scopePath: '人事/評価' })).scopePath).toBe('人事/評価')
  })
})

describe('reserved paths (shared/types/private-folders.ts, isPathUsable)', () => {
  it('normalises NFC, A–Z only, slashes', () => {
    expect(normalizeReservedPath('/Sales//Secret/')).toBe('sales/secret')
    expect(normalizeReservedPath('人事/評価'.normalize('NFD'))).toBe('人事/評価')
    expect(normalizeReservedPath('ＡＢ/É')).toBe('ＡＢ/É')
  })

  it('a path is unusable at or under a private folder the member cannot read (any spelling), usable for a reader', () => {
    const priv: ScopeWithRules = { id: 'p', path: 'Sales/評価', kind: 'folder', departmentId: null, repoId: 'r', rules: [rule('everyone', null, false, false), rule('user', 'u-v', true, false)] }
    const scopes = [ROOT, priv]
    for (const p of ['sales/評価', 'SALES/評価/x.md', `sales/${'評価'.normalize('NFD')}/a`]) {
      expect(isPathUsable(scopes, 'u-x', 'member', p)).toBe(false)
      expect(isPathUsable(scopes, 'u-v', 'member', p)).toBe(true)
      expect(isPathUsable(scopes, 'u-o', 'owner', p)).toBe(true)
    }
    // above it, next to it: usable
    expect(isPathUsable(scopes, 'u-x', 'member', 'sales')).toBe(true)
    expect(isPathUsable(scopes, 'u-x', 'member', 'sales/評価2')).toBe(true)
  })

  it('candidates are every prefix, shortest first; the message names only the folder', () => {
    expect(reservedPathCandidates('人事/評価/2026/a.md')).toEqual(['人事', '人事/評価', '人事/評価/2026', '人事/評価/2026/a.md'])
    expect(reservedPathMessage('人事/評価')).toBe('『人事/評価』というフォルダ名は使えません。別の名前にしてください。')
  })
})

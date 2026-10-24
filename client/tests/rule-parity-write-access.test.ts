// Rule parity: may this member write this path? — the desktop app's answer
// must equal the server's, for every generated company.
//
// Server (the authority): the push gate a member's push meets
// (server/src/lib/push-check/policy.ts writeGateFor = resolveAccess() as
// spelled AND with A–Z folded), the [RESERVED_PATH] check for the company
// repository, and the scope repository's gate for a readable private folder.
//
// Client: what the chat write guard decides from what the server sends it —
// GET /me/write-access (writeAccessSummary) evaluated by evaluateWrite
// (both in shared/core — the app's client/shared/write-access.ts re-exports it), the cached GET /me/scopes answer
// (canWriteInPrivateFolder) and POST /paths/check (isPathUsable) through the
// app's path checker — i.e. checkWritePath + decideReservedWrite in
// client/electron/write-guard.ts, wired like main.ts privateFolderGuardView.
//
// Generated: scope trees with everyone / role / user rules, private folders,
// owner / admin / members (a department manager is a member: managing grants
// no file access), Japanese names, A–Z case variants, NFC and NFD spellings,
// deep paths. Seeded, so a failure names its seed and the world.
//
// A mismatch is a bug in one of the two copies. Mismatches that are known and
// reported (not fixed here) are listed in KNOWN_DIFFERENCES; anything else
// fails. Each known difference must still occur, so fixing one makes this
// test ask for its entry to be removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canReadPrivateScope,
  isSameOrAncestorPath,
  writeAccessSummary,
  type ScopeRule,
  type ScopeWithRules,
} from '../../shared/core/permissions'
import {
  reservedAncestorOf,
  reservedPathsFor,
  reservedPrefixOf,
  writeGateFor,
  PUSH_POLICY_VERSION,
  type PushPolicy,
} from '../../server/src/lib/push-check/policy'
import { canWriteInPrivateFolder } from '../../server/src/lib/private-folders'
import { isPathUsable } from '../../shared/core/reserved-paths'
import { pathKey as serverPathKey } from '../../shared/core/paths'
import { normalizeReservedPath, type MyPrivateScope } from '../../shared/types/private-folders'
import { type WriteAccess } from '../shared/write-access'
import { checkWritePath, decideReservedWrite, type WriteGuard } from '../electron/write-guard'
import { readableScopeOf } from '../electron/sync/private-folders'
import { createPathChecker } from '../electron/sync/path-check'

const CO = 'co'
const ROOT = '/company'

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Folder names: Japanese (incl. a voiced kana that has an NFD form), ASCII in
// several cases, Latin with a precomposed accent (NFD differs), full-width
// letters (not A–Z: never folded), a dot folder.
const SEGMENTS = [
  '営業', '人事', '評価', 'がいど', 'Sales', 'sales', 'SALES', 'Docs', 'docs', 'Café', 'café', 'ｓａｌｅｓ', 'Ｓａｌｅｓ', 'x', 'X', '.claude',
]

const USERS: Array<{ id: string; role: string }> = [
  { id: 'u-owner', role: 'owner' },
  { id: 'u-admin', role: 'admin' },
  { id: 'u-m1', role: 'member' },
  { id: 'u-m2', role: 'member' }, // stands for a department manager: same file access as a member
  { id: 'u-m3', role: 'member' },
]

interface World {
  seed: number
  scopes: ScopeWithRules[]
}

function generateWorld(seed: number): World {
  const r = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const chance = (p: number) => r() < p
  let seq = 0
  const flags = (): Pick<ScopeRule, 'canRead' | 'canWrite'> => {
    const canRead = chance(0.7)
    return { canRead, canWrite: chance(canRead ? 0.6 : 0.15) }
  }
  const randomRules = (min: number): ScopeRule[] => {
    const n = min + Math.floor(r() * 4)
    const rules: ScopeRule[] = []
    for (let i = 0; i < n; i++) {
      const kind = pick(['everyone', 'everyone', 'role', 'user', 'user'] as const)
      const subjectId = kind === 'everyone' ? null : kind === 'role' ? pick(['member', 'member', 'admin']) : pick(['u-m1', 'u-m2', 'u-m3'])
      rules.push({ id: `r${++seq}`, subjectType: kind, subjectId, ...flags() })
    }
    return rules
  }
  const randomPath = (maxDepth: number) => {
    const depth = 1 + Math.floor(r() * maxDepth)
    return Array.from({ length: depth }, () => pick(SEGMENTS)).join('/')
  }

  const scopes: ScopeWithRules[] = []
  const has = (p: string) => scopes.some(s => s.path === p)
  scopes.push({ id: 's-root', path: '', kind: 'company', departmentId: null, repoId: null, rules: chance(0.9) ? randomRules(1) : [] })
  // Ordinary folder scopes (departments and folders; some without rules = transparent).
  const folderCount = Math.floor(r() * 7)
  for (let i = 0; i < folderCount; i++) {
    const path = randomPath(3)
    if (has(path)) continue
    const depth = path.split('/').length
    scopes.push({ id: `s${++seq}`, path, kind: depth === 1 ? 'department' : 'folder', departmentId: null, repoId: null, rules: chance(0.85) ? randomRules(1) : [] })
  }
  // Private folders: never nested, never two at the same path in any case/NFC
  // spelling (the server refuses both), rules = everyone none + named users.
  const privateCount = Math.floor(r() * 3)
  for (let i = 0; i < privateCount; i++) {
    const path = randomPath(3)
    const key = serverPathKey(path)
    const clash = scopes.some(s => s.repoId !== null && (
      isSameOrAncestorPath(serverPathKey(s.path), key) || isSameOrAncestorPath(key, serverPathKey(s.path))))
    if (clash || has(path)) continue
    const rules: ScopeRule[] = [{ id: `r${++seq}`, subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false }]
    for (const u of ['u-m1', 'u-m2', 'u-m3']) {
      if (chance(0.5)) rules.push({ id: `r${++seq}`, subjectType: 'user', subjectId: u, canRead: true, canWrite: chance(0.5) })
    }
    scopes.push({ id: `p${++seq}`, path, kind: 'folder', departmentId: null, repoId: `repo${seq}`, rules })
    // A narrowing rule inside it now and then.
    if (chance(0.5)) {
      const inner = `${path}/${pick(SEGMENTS)}`
      if (!has(inner)) scopes.push({ id: `s${++seq}`, path: inner, kind: 'folder', departmentId: null, repoId: null, rules: randomRules(1) })
    }
  }
  return { seed, scopes }
}

/** Swap the case of the A–Z letters of some segments. */
function caseVariant(path: string, r: () => number): string {
  return path.split('/').map(seg => (r() < 0.5 ? seg : seg.replace(/[A-Za-z]/g, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())))).join('/')
}

/** File paths to ask about: in, at, below and beside every scope, in several spellings. */
function queryPaths(world: World): string[] {
  const r = mulberry32(world.seed * 7919 + 1)
  const out = new Set<string>(['f.md', `${SEGMENTS[Math.floor(r() * SEGMENTS.length)]}/f.md`])
  for (const s of world.scopes) {
    const bases = s.path === '' ? [''] : [s.path, caseVariant(s.path, r), s.path.normalize('NFD')]
    for (const b of bases) {
      const prefix = b === '' ? '' : `${b}/`
      out.add(`${prefix}f.md`)
      out.add(`${prefix}${SEGMENTS[Math.floor(r() * SEGMENTS.length)]}/deep/g.md`)
      if (b !== '') out.add(b) // a file named like the folder
      const parent = b.split('/').slice(0, -1).join('/')
      if (parent) out.add(`${parent}/sibling.md`)
    }
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// The two answers
// ---------------------------------------------------------------------------

type ServerAnswer = { write: boolean; via: 'company' | 'scope-repo' | 'reserved' | 'reserved-ancestor' }

/** What the server does with a push of `path` by `user` (the authority). */
function serverDecision(scopes: ScopeWithRules[], user: { id: string; role: string }, path: string): ServerAnswer | null {
  const policy: PushPolicy = { version: PUSH_POLICY_VERSION, companyId: CO, pusher: { id: user.id, role: user.role }, scopes }
  const allow = (p: PushPolicy, rel: string) => {
    const gate = writeGateFor(p)
    return gate.kind === 'allow-all' || (gate.kind === 'check' && gate.canWrite(rel))
  }
  // Inside a private folder (on the member's case-insensitive disk: any A–Z
  // spelling lands in the clone): a reader's file goes to its own repository.
  const key = serverPathKey(path)
  const priv = scopes.find(s => s.repoId !== null && isSameOrAncestorPath(serverPathKey(s.path), key))
  if (priv && canReadPrivateScope(priv, user.id, user.role)) {
    const depth = priv.path.split('/').length
    const rel = path.normalize('NFC').split('/').filter(Boolean).slice(depth).join('/')
    if (rel === '') return null // a file replacing the private folder itself: not a write the guard is asked about
    return { write: allow({ ...policy, scopePath: priv.path }, rel), via: 'scope-repo' }
  }
  const reserved = reservedPathsFor(policy)
  if (reservedPrefixOf(path, reserved) !== null) return { write: false, via: 'reserved' }
  if (reservedAncestorOf(path, reserved) !== null) return { write: false, via: 'reserved-ancestor' }
  return { write: allow(policy, path), via: 'company' }
}

/** What the desktop app's chat guard decides, from the server's own answers. */
async function clientDecision(scopes: ScopeWithRules[], user: { id: string; role: string }, path: string): Promise<boolean> {
  // GET /me/write-access
  const access: WriteAccess = { version: 'v', role: user.role, ...writeAccessSummary(scopes, user.id, user.role) }
  // GET /me/scopes (cached by sync)
  const myScopes: MyPrivateScope[] = scopes
    .filter(s => s.repoId !== null && canReadPrivateScope(s, user.id, user.role))
    .map(s => ({ scopeId: s.id, path: s.path, cloneUrl: '', clonePath: '', canWrite: canWriteInPrivateFolder(scopes, s, CO, user.id, user.role) }))
  // POST /paths/check
  const checker = createPathChecker(async (_companyId, paths) =>
    paths.map(p => ({ path: p, usable: isPathUsable(scopes, user.id, user.role, normalizeReservedPath(p)) })))
  const guard: WriteGuard = {
    root: ROOT,
    getAccess: () => access,
    getPrivateFolderView: () => ({
      // main.ts privateFolderGuardView (without its "exists on disk" shortcut).
      reservedFolderOf: async (rel: string) => (readableScopeOf(myScopes, rel) ? null : checker.reservedFolderOf(CO, rel)),
      readOnlyFolderOf: (rel: string) => {
        const s = readableScopeOf(myScopes, rel)
        return s && !s.canWrite ? s.path : null
      },
    }),
  }
  const target = `${ROOT}/${path}`
  if (checkWritePath(guard, target).deny) return false
  return !(await decideReservedWrite(guard, 'Write', { file_path: target })).deny
}

// ---------------------------------------------------------------------------
// Known, reported differences (not fixed here — see the PR description)
// ---------------------------------------------------------------------------

interface Mismatch {
  seed: number
  user: string
  role: string
  path: string
  server: ServerAnswer
  client: boolean
  scopes: ScopeWithRules[]
}

const KNOWN_DIFFERENCES: Array<{ id: string; describe: string; matches: (m: Mismatch) => boolean }> = [
  {
    id: 'file-above-private-folder',
    describe: 'A FILE at a strict ancestor of a private folder (e.g. a file "人事" while "人事/評価" is private): '
      + 'the push check refuses it ([RESERVED_PATH], reservedAncestorOf) but paths/check — and so the chat '
      + 'guard — only knows "at or under", so the app lets the AI write it and sync recovers after the rejection.',
    matches: m => m.server.via === 'reserved-ancestor' && m.client,
  },
]

function describeMismatch(m: Mismatch): string {
  return [
    `seed ${m.seed}: ${m.user} (${m.role}) writes ${JSON.stringify(m.path)}: server ${m.server.write} (${m.server.via}), client ${m.client}`,
    `  scopes: ${JSON.stringify(m.scopes.map(s => ({ path: s.path, private: s.repoId !== null, rules: s.rules.map(r => `${r.subjectType}${r.subjectId ? `:${r.subjectId}` : ''}=${r.canRead ? 'r' : '-'}${r.canWrite ? 'w' : '-'}`) })))}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SEEDS = Number(process.env.RULE_PARITY_SEEDS ?? 600)

test(`client write decisions equal the server's push decisions (${SEEDS} generated companies)`, async () => {
  const unexplained: Mismatch[] = []
  const seen = new Map<string, Mismatch>()
  let compared = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const world = generateWorld(seed)
    for (const user of USERS) {
      for (const path of queryPaths(world)) {
        const server = serverDecision(world.scopes, user, path)
        if (server === null) continue
        // The database returns scopes in no promised order: the push check's
        // answer must not depend on it (two scopes whose paths differ only in
        // A–Z case: the one sorting first decides, on both sides).
        assert.equal(serverDecision([...world.scopes].reverse(), user, path)?.write, server.write,
          `seed ${seed}: ${user.id} ${JSON.stringify(path)}: the push check depends on the order of the scopes`)
        const client = await clientDecision(world.scopes, user, path)
        compared++
        if (client === server.write) continue
        const m: Mismatch = { seed, user: user.id, role: user.role, path, server, client, scopes: world.scopes }
        const known = KNOWN_DIFFERENCES.find(k => k.matches(m))
        if (known) { if (!seen.has(known.id)) seen.set(known.id, m) } else unexplained.push(m)
      }
    }
  }
  console.log(`[rule-parity] write access: ${compared} decisions compared, ${unexplained.length} unexplained, known: ${[...seen.keys()].join(', ') || 'none'}`)
  for (const [id, m] of seen) console.log(`[rule-parity] known difference ${id}, e.g.\n${describeMismatch(m)}`)
  assert.equal(unexplained.length, 0, `client and server disagree:\n${unexplained.slice(0, 5).map(describeMismatch).join('\n')}`)
  for (const k of KNOWN_DIFFERENCES) {
    assert.ok(seen.has(k.id), `known difference "${k.id}" no longer occurs — remove it from KNOWN_DIFFERENCES: ${k.describe}`)
  }
})

test('reserved names: the app names the same folder the push check refuses (paths/check vs [RESERVED_PATH])', async () => {
  let compared = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const world = generateWorld(seed)
    if (!world.scopes.some(s => s.repoId !== null)) continue
    const policyFor = (user: { id: string; role: string }): PushPolicy =>
      ({ version: PUSH_POLICY_VERSION, companyId: CO, pusher: { id: user.id, role: user.role }, scopes: world.scopes })
    for (const user of USERS) {
      // Only the private folders this member cannot read are names they may not use.
      const hidden = world.scopes.filter(s => s.repoId !== null && !canReadPrivateScope(s, user.id, user.role))
      const hiddenKeys = reservedPathsFor({ ...policyFor(user), scopes: hidden })
      const checker = createPathChecker(async (_c, paths) =>
        paths.map(p => ({ path: p, usable: isPathUsable(world.scopes, user.id, user.role, normalizeReservedPath(p)) })))
      for (const path of queryPaths(world)) {
        const pushRefuses = reservedPrefixOf(path, hiddenKeys)
        const appNames = await checker.reservedFolderOf(CO, path)
        compared++
        assert.equal(appNames?.normalize('NFC') ?? null, pushRefuses?.normalize('NFC') ?? null,
          `seed ${seed}: ${user.id} ${JSON.stringify(path)}: the push refuses at ${JSON.stringify(pushRefuses)}, the app names ${JSON.stringify(appNames)}`)
        // The usable answer for the path itself agrees with the push check too.
        assert.equal(isPathUsable(world.scopes, user.id, user.role, normalizeReservedPath(path)), pushRefuses === null)
      }
    }
  }
  console.log(`[rule-parity] reserved names: ${compared} paths compared`)
})

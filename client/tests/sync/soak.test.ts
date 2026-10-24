// Randomized multi-member soak for git:sync. Seeded and deterministic: the
// same seed replays the same operations, answers and sync order.
//
// K members do random edits (text, binary, Japanese paths, renames,
// deletions, .personal/ files, protected config, nested repositories,
// department folder deletion, .gitignore edits), go offline, have a teammate push in between,
// answer dialogs at random — for R rounds. Every sync must terminate cleanly;
// after every round no committed work may be lost; at the end everyone syncs
// twice and must converge to the server tree.
//
//   SYNC_SOAK_SEEDS=1,2,3   seeds to run (default: 1,2)
//   SYNC_SOAK_MEMBERS=3     members per world (default: 3)
//   SYNC_SOAK_ROUNDS=6      rounds (default: 6)
//   SYNC_SOAK_MIXED_SEEDS=101,102  seeds for the mixed world (default: 101,102)
//   SYNC_SOAK_PARTIAL=2     partial-clone members in the mixed world, on top
//                           of the full ones (default: 2)
//   SYNC_SOAK_PRIVATE_SEEDS=201,202  seeds for the private-folder world
//                           (default: 201,202)
//
// The private-folder world has private folders (人事/評価, hr/Secret) that
// some members may read: readers edit inside them, non-readers create the
// same names in every spelling (NFD, A–Z case), the owner grants and revokes
// access and now and then makes a folder public (then creates a new one),
// readers leave a folder out in settings and download it again. After every
// round no private content may be in the company repository or on a
// non-reader's disk.
//
// The mixed world adds partial-clone members (first setup with one
// department picked, World.addPartialMember). They edit only what they have
// downloaded, and now and then add the other department in settings
// (online or not). In the mixed world every member also leaves sub-folders
// out (営業部/顧客, 開発部/資料) or downloads them again, and now and then
// writes into a folder it does not have (sync must hold that back).
//
// A failure prints the seed and the operation log; rerun with that seed.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { World, privateMarker, type HarnessPrivateFolder, type Member, type Role } from '../sync-harness/world'
import { assertConverged, assertNoLostWork, assertPrivacy } from '../sync-harness/invariants'
import { readSparseConfig } from '../../electron/sync/sparse'
import { isNotDownloaded } from '../../shared/sparse-paths'

const SEEDS = (process.env.SYNC_SOAK_SEEDS ?? '1,2').split(',').map(s => Number(s.trim())).filter(Number.isFinite)
const MEMBERS = Number(process.env.SYNC_SOAK_MEMBERS) || 3
const ROUNDS = Number(process.env.SYNC_SOAK_ROUNDS) || 6
const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const MIXED_SEEDS = (process.env.SYNC_SOAK_MIXED_SEEDS ?? '101,102').split(',').map(s => Number(s.trim())).filter(Number.isFinite)
const PARTIAL = Number(process.env.SYNC_SOAK_PARTIAL ?? 2)
const PRIVATE_SEEDS = (process.env.SYNC_SOAK_PRIVATE_SEEDS ?? '201,202').split(',').map(s => Number(s.trim())).filter(Number.isFinite)

/** mulberry32 — small, fast, good enough for test choices. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle: <T>(xs: T[]): T[] => {
      const out = [...xs]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
}

const TEXT_PATHS = [
  '営業部/提案書.md', '営業部/顧客/一覧.md', '営業部/週報.md',
  '開発部/設計.md', '開発部/notes.md', '開発部/資料/仕様.md', 'shared/readme.md', '総務/規程 2026.md',
]
const BINARY_PATHS = ['営業部/図.png', 'shared/logo.png']
/** Sub-folders members leave out (or download again) in the mixed world. */
const SUB_FOLDERS = ['営業部/顧客', '開発部/資料']

/** Failure shapes that are expected mid-run; anything else is a bug. */
function expectedFailure(result: { error?: string; errorType?: string; secretDetected?: boolean }): boolean {
  if (result.errorType === 'push_failed' || result.errorType === 'protected_config') return true
  return /^同期を中止しました|^同期がキャンセルされました/.test(result.error ?? '')
}

async function soak(seed: number, t: { after: (fn: () => void) => void; diagnostic: (s: string) => void }, partialMembers = 0) {
  const rnd = prng(seed)
  const roles: Role[] = ['admin', 'member', 'member', 'owner', 'member']
  const world = World.create(t, {
    members: Array.from({ length: MEMBERS }, (_, i) => ({ name: `m${i}`, role: roles[i % roles.length] })),
    departments: ['営業部', '開発部'],
    seed: {
      '営業部/提案書.md': 'seed\n', '営業部/顧客/一覧.md': 'seed\n', '開発部/資料/仕様.md': 'seed\n', '開発部/設計.md': 'seed\n', '営業部/図.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
      '.mcp.json': '{"mcpServers":{}}\n',
    },
  })
  for (let i = 0; i < partialMembers; i++) {
    await world.addPartialMember(`p${i}`, { departments: [i % 2 === 0 ? '営業部' : '開発部'] })
  }
  const opLog: string[] = []
  const log = (s: string) => opLog.push(s)
  let counter = 0

  // A member only edits what it has downloaded (the departments a partial
  // member did not pick and the folders anyone left out in settings are not
  // on its disk); writes there anyway are a separate operation below.
  const inCone = (m: Member, p: string) => !isNotDownloaded(readSparseConfig(m.dir).excluded, p)
  const pickIn = (m: Member, xs: readonly string[]): string | null => {
    const allowed = xs.filter(p => inCone(m, p))
    return allowed.length > 0 ? rnd.pick(allowed) : null
  }

  // Tracked files the member still has on disk.
  const tracked = (m: Member) => m.git(['ls-files', '-z']).split('\0').filter(f => f && f !== '.gitignore' && !f.endsWith('.gitkeep') && m.exists(f))

  const randomOp = async (m: Member) => {
    const n = ++counter
    if (m.partial && rnd.chance(0.08)) {
      // Settings → 追加する (downloads the department; fails cleanly offline).
      const missing = readSparseConfig(m.dir).excluded
      if (missing.length > 0) {
        const dept = rnd.pick(missing)
        const r = await m.addDepartment(dept)
        log(`${m.name} adds department ${dept} → ${r.success ? 'ok' : r.error}`)
        assert.ok(r.success || r.offline, `adding a department failed: ${JSON.stringify(r)}`)
      }
      return
    }
    if (partialMembers > 0 && rnd.chance(0.08)) {
      // Settings → ダウンロードするフォルダ: leave a sub-folder out, or
      // download it again (fails cleanly offline in a partial clone).
      const folder = rnd.pick(SUB_FOLDERS)
      const excluded = readSparseConfig(m.dir).excluded
      if (isNotDownloaded(excluded, folder)) {
        if (excluded.includes(folder)) {
          const r = await m.includeFolder(folder)
          log(`${m.name} downloads folder ${folder} → ${r.success ? 'ok' : r.error}`)
          assert.ok(r.success || r.offline, `downloading a folder failed: ${JSON.stringify(r)}`)
        }
      } else {
        const r = await m.excludeFolder(folder)
        log(`${m.name} leaves out folder ${folder} → ${r.success ? 'ok' : r.error}`)
        assert.ok(r.success, `leaving out a folder failed: ${JSON.stringify(r)}`)
      }
      return
    }
    if (partialMembers > 0 && rnd.chance(0.03)) {
      // A write into a folder that is not downloaded (a Bash `cp`, another
      // tool): sync holds it back instead of sharing it.
      const excluded = readSparseConfig(m.dir).excluded
      if (excluded.length > 0) {
        const p = `${rnd.pick(excluded)}/stray-${m.name}-${n}.md`
        m.write(p, `stray ${n}\n`)
        log(`${m.name} writes into a folder that is not downloaded: ${p}`)
      }
      return
    }
    const roll = rnd.int(100)
    if (roll < 35) {
      const p = pickIn(m, TEXT_PATHS)
      if (p) {
        m.write(p, `${m.name} #${n}\n${'line\n'.repeat(rnd.int(4))}`)
        log(`${m.name} write ${p}`)
      }
    } else if (roll < 45) {
      const p = pickIn(m, TEXT_PATHS)
      if (p) {
        m.append(p, `${m.name} appends #${n}\n`)
        log(`${m.name} append ${p}`)
      }
    } else if (roll < 52) {
      const p = pickIn(m, BINARY_PATHS)
      if (p) {
        m.write(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, n & 0xff, rnd.int(256), 0, 0xff]))
        log(`${m.name} binary ${p}`)
      }
    } else if (roll < 60) {
      const files = tracked(m)
      if (files.length > 0) {
        const p = rnd.pick(files)
        m.remove(p)
        log(`${m.name} delete ${p}`)
      }
    } else if (roll < 66) {
      const files = tracked(m).filter(f => !f.startsWith('.'))
      if (files.length > 0) {
        const from = rnd.pick(files)
        const to = `${pickIn(m, ['営業部', '開発部', 'shared', 'archive'])}/moved-${n}-${from.split('/').pop()}`
        if (!m.exists(to)) {
          m.rename(from, to)
          log(`${m.name} rename ${from} -> ${to}`)
        }
      }
    } else if (roll < 71) {
      const dept = pickIn(m, ['営業部', '開発部'])
      if (dept) {
        m.write(`${dept}/.personal/memo-${n}.md`, `private ${n}\n`)
        log(`${m.name} personal file`)
      }
    } else if (roll < 77) {
      m.write('.mcp.json', `{"mcpServers":{"s${n}":{"command":"x"}}}\n`)
      log(`${m.name} (${m.role}) edits .mcp.json`)
    } else if (roll < 80) {
      m.write(`.claude/skills/s${n}/SKILL.md`, rnd.chance(0.5) ? `---\nname: s${n}\nhooks: {}\n---\n` : `---\nname: s${n}\n---\nbody\n`)
      log(`${m.name} (${m.role}) adds skill s${n}`)
    } else if (roll < 83) {
      // A new nested repo is kept on the member's computer only
      // (.git/info/exclude); a stray .git inside an already shared folder is
      // removed (its files shared) or kept local, as the member answers.
      const shared = [...new Set(tracked(m).filter(f => f.includes('/') && !f.startsWith('.')).map(f => f.split('/')[0]))]
      if (rnd.chance(0.5) || shared.length === 0) {
        m.initNestedRepo(`ext-${n}`)
        log(`${m.name} creates nested repo ext-${n}`)
      } else {
        const dir = rnd.pick(shared)
        m.initNestedRepo(dir, { [`inner-${n}.md`]: `inner ${n}\n` })
        log(`${m.name} plants a .git in shared folder ${dir}`)
      }
    } else if (roll < 85) {
      if (m.exists('営業部')) {
        m.remove('営業部')
        log(`${m.name} deletes department folder 営業部`)
      }
    } else if (roll < 92) {
      if (rnd.chance(0.5)) { m.offline(); log(`${m.name} offline`) } else { m.online(); log(`${m.name} online`) }
    } else if (roll < 97) {
      m.write(`shared/new-${m.name}-${n}.md`, `new ${n}\n`)
      log(`${m.name} new file`)
    } else {
      const file = pickIn(m, ['.gitignore', '営業部/.gitignore', '開発部/.gitignore'])
      if (file) {
        m.append(file, `*.tmp${n}\n`)
        log(`${m.name} edits ${file}`)
      }
    }
  }

  const scriptAnswers = (m: Member) => {
    m.clearAnswers()
    m.willAnswer('deletedFiles', rnd.pick(['sync-deletions', 'sync-deletions', 'restore', 'cancel'] as const))
    m.willAnswer('protectedConfig', rnd.pick(['restore', 'restore', 'cancel'] as const))
    m.willAnswer('externalNestedRepo', rnd.pick(['exclude', 'exclude', 'cancel'] as const))
    m.willAnswer('sharedNestedRepo', rnd.pick(['keep-sharing', 'exclude', 'cancel'] as const))
  }

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      log(`--- round ${round}`)
      for (const m of world.members) {
        const ops = rnd.int(4)
        for (let i = 0; i < ops; i++) await randomOp(m)
      }
      for (const m of rnd.shuffle(world.members)) {
        if (!rnd.chance(0.85)) continue
        scriptAnswers(m)
        if (rnd.chance(0.15)) {
          const other = rnd.pick(world.members.filter(x => x !== m))
          other.write(`shared/race-${++counter}.md`, 'race\n')
          m.beforeNextPush(async () => { log(`  ${other.name} pushes first`); await other.sync() })
        }
        const out = await m.sync()
        log(`${m.name} sync → ${out.result.success ? 'ok' : `${out.result.errorType ?? 'fail'}: ${(out.result.error ?? '').split('\n')[0]}`}` +
          `${out.dialogs.length ? ` [${out.dialogs.map(d => `${d.kind}:${d.answer}`).join(', ')}]` : ''}`)
        if (!out.result.success) {
          assert.ok(expectedFailure(out.result), `unexpected failure: ${JSON.stringify(out.result)}`)
        }
      }
      assertNoLostWork(world, { allowUnpushed: true })
    }
    log('--- settle')
    for (const m of world.members) m.online()
    await world.settle(2)
    assertConverged(world)
    assertNoLostWork(world)
    t.diagnostic(`seed ${seed}: ${opLog.length} steps, ${world.members.reduce((n, m) => n + m.results.length, 0)} syncs, ` +
      `${world.members.reduce((n, m) => n + m.results.filter(r => r.hadConflicts).length, 0)} with conflicts` +
      (partialMembers > 0
        ? `, ${opLog.filter(l => / (leaves out|downloads) folder /.test(l)).length} folder choices, ` +
          `${world.members.reduce((n, m) => n + m.results.filter(r => r.outsideCheckoutFiles).length, 0)} syncs held files back`
        : ''))
  } catch (error) {
    throw new Error(`soak seed ${seed} failed: ${error instanceof Error ? error.message : String(error)}\n\noperations:\n${opLog.join('\n')}`)
  }
}

describe(`git:sync soak (${MEMBERS} members × ${ROUNDS} rounds)`, { concurrency: CONCURRENCY }, () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async t => soak(seed, t))
  }
})

describe(`git:sync soak, mixed full and partial clones (${MEMBERS} full + ${PARTIAL} partial × ${ROUNDS} rounds)`, { concurrency: CONCURRENCY }, () => {
  for (const seed of PARTIAL > 0 ? MIXED_SEEDS : []) {
    test(`seed ${seed}`, async t => soak(seed, t, PARTIAL))
  }
})

async function privateSoak(seed: number, t: { after: (fn: () => void) => void; diagnostic: (s: string) => void }) {
  const rnd = prng(seed)
  const roles: Role[] = ['owner', 'member', 'member', 'member', 'admin']
  const count = Math.max(MEMBERS, 3)
  const world = World.create(t, {
    members: Array.from({ length: count }, (_, i) => ({ name: `m${i}`, role: roles[i % roles.length] })),
    departments: ['人事', '営業部', 'hr'],
    seed: { '人事/規程.md': 'seed\n', '営業部/提案.md': 'seed\n', 'hr/policy.md': 'seed\n' },
  })
  const opLog: string[] = []
  const log = (s: string) => opLog.push(s)
  let counter = 0
  const names = world.members.map(m => m.name)
  world.createPrivateFolder('人事/評価', { viewers: ['m1'] })
  world.createPrivateFolder('hr/Secret', { viewers: ['m1', 'm2'], editors: ['m1'] })
  /** Members whose access was taken away and who have not synced since. */
  const revokedPending = new Set<string>()
  let generation = 0

  const variants = (p: string) => [p, p.normalize('NFD'), p.toUpperCase(), p.toLowerCase(), p.replace(/^hr\//, 'HR/')]
  const cloned = (m: Member, f: HarnessPrivateFolder) => fs.existsSync(path.join(m.path(f.path), '.git'))

  const randomOp = async (m: Member) => {
    const n = ++counter
    const folders = [...world.privateFolders.values()]
    const roll = rnd.int(100)
    if (roll < 40) {
      const mine = folders.filter(f => world.canRead(f, m.name) && cloned(m, f))
      if (mine.length > 0) {
        const f = rnd.pick(mine)
        const p = `${f.path}/${rnd.pick(['評価表.md', 'notes.md', 'sub/詳細.md'])}`
        if (rnd.chance(0.3) && m.exists(p)) m.append(p, `${m.name} appends #${n}\n`)
        else m.write(p, `${privateMarker(f)}\n${m.name} #${n}\n`)
        log(`${m.name} writes private ${p}`)
        return
      }
    }
    if (roll < 60) {
      const p = rnd.pick(['人事/規程.md', '営業部/提案.md', 'hr/policy.md', `営業部/new-${m.name}-${n}.md`])
      m.write(p, `${m.name} #${n}\n`)
      log(`${m.name} writes ${p}`)
    } else if (roll < 75) {
      // The same name as a private folder the member cannot see (or a variant).
      const unreadable = folders.filter(f => !world.canRead(f, m.name))
      if (unreadable.length > 0) {
        const f = rnd.pick(unreadable)
        const p = `${rnd.pick(variants(f.path))}/mine-${n}.md`
        m.write(p, `own notes ${n}\n`)
        log(`${m.name} writes into a reserved name: ${p}`)
      }
    } else if (roll < 82) {
      if (rnd.chance(0.5)) { m.offline(); log(`${m.name} offline`) } else { m.online(); log(`${m.name} online`) }
    } else if (roll < 90) {
      const readable = folders.filter(f => world.canRead(f, m.name))
      if (readable.length > 0) {
        const f = rnd.pick(readable)
        const excluded = readSparseConfig(m.dir).excluded.includes(f.path)
        const r = excluded ? await m.includeFolder(f.path) : await m.excludeFolder(f.path)
        const reports = await m.applyPrivateFolderChoices()
        log(`${m.name} ${excluded ? 'downloads' : 'leaves out'} ${f.path} → ${r.success ? 'ok' : r.error} ${JSON.stringify(reports.map(x => [x.success, x.removed, x.cloned]))}`)
      }
    }
  }

  const ownerOps = () => {
    const folders = [...world.privateFolders.values()]
    if (folders.length === 0) return
    const f = rnd.pick(folders)
    const roll = rnd.int(100)
    if (roll < 15) {
      const who = rnd.pick(names.filter(x => !world.canRead(f, x)))
      if (who) { world.grantPrivate(f.path, who, { write: rnd.chance(0.7) }); log(`owner grants ${f.path} to ${who}`) }
    } else if (roll < 28) {
      const who = rnd.pick([...f.viewers.keys()])
      if (who && world.member(who).role === 'member') {
        world.revokePrivate(f.path, who)
        revokedPending.add(who)
        log(`owner revokes ${f.path} from ${who}`)
      }
    } else if (roll < 33) {
      world.makePublic(f.path)
      log(`owner makes ${f.path} public`)
      const next = `人事/評価${++generation}`
      world.createPrivateFolder(next, { viewers: [rnd.pick(names)] })
      log(`owner creates private folder ${next}`)
    }
  }

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      log(`--- round ${round}`)
      ownerOps()
      for (const m of world.members) {
        const ops = rnd.int(4)
        for (let i = 0; i < ops; i++) await randomOp(m)
      }
      for (const m of rnd.shuffle(world.members)) {
        if (!revokedPending.has(m.name) && !rnd.chance(0.85)) continue
        if (revokedPending.has(m.name)) m.online()
        m.clearAnswers()
        const out = await m.sync()
        log(`${m.name} sync → ${out.result.success ? 'ok' : `${out.result.errorType ?? 'fail'}: ${(out.result.error ?? '').split('\n').slice(0, 2).join(' / ')}`}`)
        if (out.result.success) revokedPending.delete(m.name)
        else {
          assert.ok(['push_failed', 'network', 'write_denied'].includes(out.result.errorType ?? '') || expectedFailure(out.result),
            `unexpected failure: ${JSON.stringify(out.result)}`)
          if (revokedPending.has(m.name) && out.result.lostPrivateFolders) revokedPending.delete(m.name)
        }
      }
      assertNoLostWork(world, { allowUnpushed: true })
      if (revokedPending.size === 0) assertPrivacy(world)
    }
    log('--- settle')
    for (const m of world.members) m.online()
    await world.settle(2)
    assertConverged(world)
    assertNoLostWork(world)
    assertPrivacy(world, { converged: true })
    t.diagnostic(`private seed ${seed}: ${opLog.length} steps, ${world.members.reduce((n, m) => n + m.results.length, 0)} syncs, ` +
      `${world.members.reduce((n, m) => n + m.results.filter(r => r.reservedPathFiles).length, 0)} held back reserved names, ` +
      `${world.members.reduce((n, m) => n + m.results.filter(r => r.lostPrivateFolders).length, 0)} lost access, ` +
      `${world.members.reduce((n, m) => n + m.results.filter(r => r.madePublicFolders).length, 0)} made public`)
  } catch (error) {
    throw new Error(`private soak seed ${seed} failed: ${error instanceof Error ? error.message : String(error)}\n\noperations:\n${opLog.join('\n')}`)
  }
}

describe(`git:sync soak, private folders (${Math.max(MEMBERS, 3)} members × ${ROUNDS} rounds)`, { concurrency: CONCURRENCY }, () => {
  for (const seed of PRIVATE_SEEDS) {
    test(`seed ${seed}`, async t => privateSoak(seed, t))
  }
})

// Randomized multi-member soak for git:sync. Seeded and deterministic: the
// same seed replays the same operations, answers and sync order.
//
// K members do random edits (text, binary, Japanese paths, renames,
// deletions, .personal/ files, protected config, nested repositories,
// department folder deletion), go offline, have a teammate push in between,
// answer dialogs at random — for R rounds. Every sync must terminate cleanly;
// after every round no committed work may be lost; at the end everyone syncs
// twice and must converge to the server tree.
//
//   SYNC_SOAK_SEEDS=1,2,3   seeds to run (default: 1,2)
//   SYNC_SOAK_MEMBERS=3     members per world (default: 3)
//   SYNC_SOAK_ROUNDS=6      rounds (default: 6)
//   SYNC_HARNESS_KNOWN_ISSUES=1  also create nested repos that get excluded
//
// A failure prints the seed and the operation log; rerun with that seed.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { World, type Member, type Role } from '../sync-harness/world'
import { assertConverged, assertNoLostWork } from '../sync-harness/invariants'

const SEEDS = (process.env.SYNC_SOAK_SEEDS ?? '1,2').split(',').map(s => Number(s.trim())).filter(Number.isFinite)
const MEMBERS = Number(process.env.SYNC_SOAK_MEMBERS) || 3
const ROUNDS = Number(process.env.SYNC_SOAK_ROUNDS) || 6
const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
/** Also exercise the paths behind known, unfixed issues (see findings.test.ts). */
const KNOWN = !!process.env.SYNC_HARNESS_KNOWN_ISSUES

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
  '開発部/設計.md', '開発部/notes.md', 'shared/readme.md', '総務/規程 2026.md',
]
const BINARY_PATHS = ['営業部/図.png', 'shared/logo.png']

/** Failure shapes that are expected mid-run; anything else is a bug. */
function expectedFailure(result: { error?: string; errorType?: string; secretDetected?: boolean }): boolean {
  if (result.errorType === 'push_failed' || result.errorType === 'protected_config') return true
  return /^同期を中止しました|^同期がキャンセルされました/.test(result.error ?? '')
}

async function soak(seed: number, t: { after: (fn: () => void) => void; diagnostic: (s: string) => void }) {
  const rnd = prng(seed)
  const roles: Role[] = ['admin', 'member', 'member', 'owner', 'member']
  const world = World.create(t, {
    members: Array.from({ length: MEMBERS }, (_, i) => ({ name: `m${i}`, role: roles[i % roles.length] })),
    departments: ['営業部', '開発部'],
    seed: {
      '営業部/提案書.md': 'seed\n', '開発部/設計.md': 'seed\n', '営業部/図.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
      '.mcp.json': '{"mcpServers":{}}\n',
    },
  })
  const opLog: string[] = []
  const log = (s: string) => opLog.push(s)
  let counter = 0

  // Tracked files the member still has on disk.
  const tracked = (m: Member) => m.git(['ls-files', '-z']).split('\0').filter(f => f && f !== '.gitignore' && !f.endsWith('.gitkeep') && m.exists(f))

  const randomOp = (m: Member) => {
    const n = ++counter
    const roll = rnd.int(100)
    if (roll < 35) {
      const p = rnd.pick(TEXT_PATHS)
      m.write(p, `${m.name} #${n}\n${'line\n'.repeat(rnd.int(4))}`)
      log(`${m.name} write ${p}`)
    } else if (roll < 45) {
      const p = rnd.pick(TEXT_PATHS)
      m.append(p, `${m.name} appends #${n}\n`)
      log(`${m.name} append ${p}`)
    } else if (roll < 52) {
      const p = rnd.pick(BINARY_PATHS)
      m.write(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, n & 0xff, rnd.int(256), 0, 0xff]))
      log(`${m.name} binary ${p}`)
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
        const to = `${rnd.pick(['営業部', '開発部', 'shared', 'archive'])}/moved-${n}-${from.split('/').pop()}`
        if (!m.exists(to)) {
          m.rename(from, to)
          log(`${m.name} rename ${from} -> ${to}`)
        }
      }
    } else if (roll < 71) {
      m.write(`${rnd.pick(['営業部', '開発部'])}/.personal/memo-${n}.md`, `private ${n}\n`)
      log(`${m.name} personal file`)
    } else if (roll < 77) {
      m.write('.mcp.json', `{"mcpServers":{"s${n}":{"command":"x"}}}\n`)
      log(`${m.name} (${m.role}) edits .mcp.json`)
    } else if (roll < 80) {
      m.write(`.claude/skills/s${n}/SKILL.md`, rnd.chance(0.5) ? `---\nname: s${n}\nhooks: {}\n---\n` : `---\nname: s${n}\n---\nbody\n`)
      log(`${m.name} (${m.role}) adds skill s${n}`)
    } else if (roll < 83) {
      // Excluding a nested repo writes .gitignore, which runs into the known
      // issue in findings.test.ts; without SYNC_HARNESS_KNOWN_ISSUES the soak
      // only plants a stray .git inside an already shared folder.
      const shared = [...new Set(tracked(m).filter(f => f.includes('/') && !f.startsWith('.')).map(f => f.split('/')[0]))]
      if (KNOWN) {
        m.initNestedRepo(`ext-${n}`)
        log(`${m.name} creates nested repo ext-${n}`)
      } else if (shared.length > 0) {
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
    } else {
      m.write(`shared/new-${m.name}-${n}.md`, `new ${n}\n`)
      log(`${m.name} new file`)
    }
  }

  const scriptAnswers = (m: Member) => {
    m.clearAnswers()
    m.willAnswer('deletedFiles', rnd.pick(['sync-deletions', 'sync-deletions', 'restore', 'cancel'] as const))
    m.willAnswer('protectedConfig', rnd.pick(['restore', 'restore', 'cancel'] as const))
    m.willAnswer('externalNestedRepo', rnd.pick(['exclude', 'exclude', 'cancel'] as const))
    m.willAnswer('sharedNestedRepo', rnd.pick(KNOWN ? ['keep-sharing', 'exclude', 'cancel'] as const : ['keep-sharing', 'keep-sharing', 'cancel'] as const))
  }

  try {
    for (let round = 1; round <= ROUNDS; round++) {
      log(`--- round ${round}`)
      for (const m of world.members) {
        const ops = rnd.int(4)
        for (let i = 0; i < ops; i++) randomOp(m)
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
      `${world.members.reduce((n, m) => n + m.results.filter(r => r.hadConflicts).length, 0)} with conflicts`)
  } catch (error) {
    throw new Error(`soak seed ${seed} failed: ${error instanceof Error ? error.message : String(error)}\n\noperations:\n${opLog.join('\n')}`)
  }
}

describe(`git:sync soak (${MEMBERS} members × ${ROUNDS} rounds)`, { concurrency: CONCURRENCY }, () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, async t => soak(seed, t))
  }
})

// A normalized record of what sync did in a world: every result, dialog and
// log line, and the final state of the server and of every member. Used to
// characterize sync behaviour (tests/sync/characterization.test.ts).

import fs from 'node:fs'
import path from 'node:path'
import { blobId, type Member, type SyncOutcome, type World } from './world'

export interface SyncStep {
  member: string
  result: unknown
  dialogs: Array<{ kind: string; answer: string; options: unknown }>
  logs: string[]
}

export interface Transcript {
  steps: SyncStep[]
  final: {
    serverTree: Record<string, string>
    serverSubjects: string[]
    members: Record<string, {
      headIsServer: boolean
      status: string
      tree: Record<string, string>
      pendingPush: boolean
      gitignore: string | null
      userName: string
      sparse: string
      backups: Array<{ metadata: unknown; files: Record<string, string> }>
    }>
  }
}

/** Replace run-specific values (temp paths, wall-clock timestamps, hashes). */
export function normalize(value: unknown, world: World, opts: { hashes: boolean }): unknown {
  const norm = (s: string) => {
    let out = s.split(world.root).join('<ROOT>')
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}[-.]\d{3}Z?/g, '<TS>')
    if (opts.hashes) out = out.replace(/\b[0-9a-f]{40}\b/g, '<HASH>')
    return out
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return norm(v)
    if (v instanceof Error) return `Error: ${norm(v.message)}`
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        if (val === undefined) continue
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(value)
}

export class Recorder {
  readonly steps: SyncStep[] = []
  constructor(private readonly world: World, private readonly opts: { hashes: boolean; fullLogs: boolean }) {}

  async sync(m: Member, message?: string): Promise<SyncOutcome> {
    const out = await m.sync(message)
    this.steps.push({
      member: m.name,
      result: normalize(out.result, this.world, this.opts),
      dialogs: out.dialogs.map(d => normalize({ kind: d.kind, answer: d.answer, options: d.options }, this.world, this.opts) as SyncStep['dialogs'][number]),
      logs: out.logs.map(([level, ...args]) => {
        const shown = this.opts.fullLogs ? args : args.slice(0, 1)
        return `${level}: ${shown.map(a => typeof a === 'string' ? a : JSON.stringify(normalize(a instanceof Error ? a : a, this.world, this.opts))).join(' ')}`
      }).map(l => normalize(l, this.world, this.opts) as string),
    })
    return out
  }

  finish(): Transcript {
    const world = this.world
    const treeOf = (cwd: string, rev: string) => {
      const out: Record<string, string> = {}
      for (const entry of world.git(cwd, ['ls-tree', '-r', '-z', rev]).split('\0')) {
        if (!entry) continue
        const [meta, file] = entry.split('\t')
        out[file] = meta.split(' ')[2]
      }
      return out
    }
    const members: Transcript['final']['members'] = {}
    for (const m of world.members) {
      const readOpt = (rel: string) => (m.exists(rel) ? m.readText(rel) : null)
      members[m.name] = {
        headIsServer: m.head() === world.serverHead(),
        status: m.git(['status', '--porcelain', '--untracked-files=all']),
        tree: treeOf(m.dir, 'HEAD'),
        pendingPush: m.hasPendingPush(),
        gitignore: readOpt('.gitignore'),
        userName: m.git(['config', '--get', 'user.name']).trim(),
        sparse: (() => {
          try { return m.git(['sparse-checkout', 'list']) } catch { return '(not sparse)' }
        })(),
        backups: m.backups().map(b => ({
          metadata: normalize(b.metadata, world, this.opts),
          files: Object.fromEntries(b.files.map(f => [f, blobId(fs.readFileSync(path.join(m.dir, '.backups', b.folder, f)))])),
        })),
      }
    }
    return {
      steps: this.steps,
      final: {
        serverTree: treeOf(world.bare, 'main'),
        serverSubjects: world.git(world.bare, ['log', '--format=%s', 'main']).split('\n').filter(Boolean),
        members,
      },
    }
  }
}

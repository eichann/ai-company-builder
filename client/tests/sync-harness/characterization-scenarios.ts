// Fixed scenarios covering every branch of sync that existed before it was
// extracted from main.ts. Their transcripts were recorded from the original
// handler (tests/sync/characterization.golden.json); the extracted sync must
// reproduce them exactly.

import fs from 'node:fs'
import { World, FAKE_AWS_KEY, type SyncImplFactory, type WorldOptions } from './world'
import { Recorder, type Transcript } from './transcript'

type Scenario = (world: World, rec: Recorder) => Promise<void>

interface Characterization {
  options: WorldOptions
  run: Scenario
}

const PNG = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, n, 0xff, n])

export const CHARACTERIZATIONS: Record<string, Characterization> = {
  'no-op and plain push/pull': {
    options: { members: [{ name: 'a' }, { name: 'b' }], departments: ['営業部'] },
    run: async (w, rec) => {
      const [a, b] = w.members
      await rec.sync(a)
      a.write('営業部/a.md', 'a\n')
      await rec.sync(a, 'custom message')
      await rec.sync(b)
    },
  },
  'conflicts: UU + DU + binary in Japanese paths': {
    options: {
      members: [{ name: 'a' }, { name: 'b' }],
      seed: { '営業部/提案書.md': '0\n', '営業部/削除予定.md': '0\n', '営業部/図.png': PNG(1), 'keep.md': 'k\n' },
    },
    run: async (w, rec) => {
      const [a, b] = w.members
      b.write('営業部/提案書.md', 'b\n').write('営業部/図.png', PNG(2)).remove('営業部/削除予定.md')
      await rec.sync(b)
      a.write('営業部/提案書.md', 'a\n').write('営業部/図.png', PNG(3)).write('営業部/削除予定.md', 'a edit\n').write('keep.md', 'k2\n')
      await rec.sync(a)
    },
  },
  'offline commits, PENDING_PUSH, multi-pick conflicts': {
    options: { members: [{ name: 'a' }, { name: 'b' }], seed: { 'f1.md': '0\n', 'f2.md': '0\n' } },
    run: async (w, rec) => {
      const [a, b] = w.members
      a.offline().write('f1.md', 'a1\n')
      await rec.sync(a, 'one')
      a.write('f2.md', 'a2\n').write('a.md', 'a\n')
      await rec.sync(a, 'two')
      b.write('f1.md', 'b1\n').write('f2.md', 'b2\n')
      await rec.sync(b)
      a.online()
      await rec.sync(a)
    },
  },
  'race: teammate pushes between pull and push': {
    options: { members: [{ name: 'a' }, { name: 'b' }] },
    run: async (w, rec) => {
      const [a, b] = w.members
      a.write('a.md', 'a\n').beforeNextPush(async () => { b.write('b.md', 'b\n'); await rec.sync(b) })
      await rec.sync(a)
      await rec.sync(a)
    },
  },
  'nested repositories: shared keep / shared exclude / external cancel / external exclude / no window': {
    options: { members: [{ name: 'a' }, { name: 'b' }], seed: { 's1/x.md': '1\n', 's2/x.md': '2\n' } },
    run: async (w, rec) => {
      const [a, b] = w.members
      a.initNestedRepo('s1').willAnswer('sharedNestedRepo', 'keep-sharing')
      await rec.sync(a)
      a.initNestedRepo('s2').willAnswer('sharedNestedRepo', 'exclude')
      await rec.sync(a)
      a.initNestedRepo('ext').willAnswer('externalNestedRepo', 'cancel')
      await rec.sync(a)
      await rec.sync(a)
      b.hasWindow = false
      b.initNestedRepo('ext-b')
      await rec.sync(b)
    },
  },
  'deleted files: cancel / restore / sync; department folder restore': {
    options: { members: [{ name: 'a' }], departments: ['営業部', '../evil'], seed: { 'one.md': '1\n', '営業部/c.md': 'c\n' } },
    run: async (w, rec) => {
      const [a] = w.members
      a.remove('one.md').willAnswer('deletedFiles', 'cancel')
      await rec.sync(a)
      a.willAnswer('deletedFiles', 'restore')
      await rec.sync(a)
      a.remove('one.md')
      await rec.sync(a)
      a.remove('営業部')
      await rec.sync(a)
    },
  },
  'protected config: cancel, restore, no window, admin, skill squash path': {
    options: { members: [{ name: 'a' }, { name: 'admin', role: 'admin' }], seed: { '.mcp.json': '{}\n' } },
    run: async (w, rec) => {
      const [a, admin] = w.members
      a.write('.mcp.json', '{"x":1}\n').write('n.md', 'n\n').willAnswer('protectedConfig', 'cancel')
      await rec.sync(a)
      await rec.sync(a)
      a.hasWindow = false
      a.write('.claude/settings.json', '{}\n')
      await rec.sync(a)
      a.hasWindow = true
      await rec.sync(a)
      a.write('.claude/skills/s/SKILL.md', '---\nhooks: {}\n---\n').willAnswer('protectedConfig', 'cancel')
      await rec.sync(a)
      a.write('.claude/skills/s/SKILL.md', '---\nname: s\n---\n')
      await rec.sync(a)
      admin.write('.mcp.json', '{"admin":1}\n')
      await rec.sync(admin)
      await rec.sync(a)
    },
  },
  'personal path and secret rejection': {
    options: { members: [{ name: 'a' }], legacySeed: { 'd/.personal/m.md': 'old\n' } },
    run: async (w, rec) => {
      const [a] = w.members
      a.write('d/.personal/m.md', 'new\n').write('d/r.md', 'r\n')
      await rec.sync(a)
      a.write('s.md', `${FAKE_AWS_KEY}\n`)
      await rec.sync(a)
      a.write('s.md', 'gone\n')
      await rec.sync(a)
    },
  },
  'stale rebase and merge recovery': {
    options: { members: [{ name: 'a' }, { name: 'b' }], seed: { 'x.md': '0\n' } },
    run: async (w, rec) => {
      const [a, b] = w.members
      b.write('x.md', 'b\n')
      await rec.sync(b)
      a.write('x.md', 'a\n')
      a.git(['commit', '-qam', 'local'])
      a.git(['fetch', '-q'])
      try { a.git(['rebase', 'origin/main']) } catch { /* stops on the conflict */ }
      await rec.sync(a)
      b.write('x.md', 'b2\n')
      await rec.sync(b)
      a.write('x.md', 'a2\n')
      a.git(['commit', '-qam', 'local 2'])
      a.git(['fetch', '-q'])
      try { a.git(['merge', 'origin/main']) } catch { /* stops on the conflict */ }
      await rec.sync(a)
    },
  },
  'gitignore essentials, large files, sparse exclusions': {
    options: { members: [{ name: 'a' }, { name: 'b' }], gitignore: 'custom/\n', seed: { '開発部/x.md': 'x\n', '営業部/y.md': 'y\n' } },
    run: async (w, rec) => {
      const [a, b] = w.members
      // A sparse file: >100MB on stat, nothing on disk.
      const big = a.path('media/huge.mov')
      fs.mkdirSync(a.path('media'), { recursive: true })
      fs.closeSync(fs.openSync(big, 'w'))
      fs.truncateSync(big, 101 * 1024 * 1024)
      a.write('media/small.txt', 's\n')
      await rec.sync(a)
      fs.writeFileSync(b.path('.git/acb-sparse-config.json'), JSON.stringify({ excluded: ['開発部'] }))
      await rec.sync(b)
      b.git(['sparse-checkout', 'disable'])
      fs.rmSync(b.path('.git/acb-sparse-config.json'))
      b.git(['sparse-checkout', 'set', '営業部'])
      await rec.sync(b)
    },
  },
}

export async function runCharacterization(
  name: string,
  impl: SyncImplFactory | undefined,
  t: { after: (fn: () => void) => void },
  opts: { hashes: boolean; fullLogs: boolean },
): Promise<Transcript> {
  const c = CHARACTERIZATIONS[name]
  const world = World.create(t, { ...c.options, impl })
  const rec = new Recorder(world, opts)
  await c.run(world, rec)
  return rec.finish()
}

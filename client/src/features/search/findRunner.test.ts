// One 探す search at a time (findRunner.ts). Guards: an older search's answers that arrive late
// never paint over the newer words; clearing the box drops whatever is still on its way; the file
// names are read once while fresh, not on every keystroke; a file's time is read only for files shown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FindResult } from '../../../shared/record-views'
import { createFindRunner, type FindPorts, type FindState } from './findRunner'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const records = (title: string): FindResult => ({
  success: true, available: true, total: 1, hubs: [],
  hits: [{ record: { id: `task-${title}`, type: 'task', typeLabel: 'やること', kind: 'task', title, summary: '', stateLabel: null, updatedAt: '', thing: 'task' }, department: null, mine: false }],
})

test('a slow answer to older words never replaces the newer search', async () => {
  const slow = deferred<FindResult>()
  const slowGrep = deferred<{ success: boolean; results: Array<{ file: string; line: number; text: string }> }>()
  const states: Array<FindState | null> = []
  const ports: FindPorts = {
    findRecords: text => (text === 'みつ' ? slow.promise : Promise.resolve(records(text))),
    grep: text => (text === 'みつ' ? slowGrep.promise : Promise.resolve({ success: true, results: [{ file: 'a/見積.md', line: 1, text }] })),
    listFiles: async () => ({ success: true, files: [] }),
    fileTimes: async () => ({}),
  }
  const runner = createFindRunner(ports, s => states.push(s))
  const first = runner.run('みつ', '', '2026-11-03')
  await runner.run('見積', '', '2026-11-03')
  slow.resolve(records('みつ'))
  slowGrep.resolve({ success: true, results: [{ file: 'a/old.md', line: 1, text: 'みつ' }] })
  await first
  const last = states[states.length - 1]!
  assert.equal(last.query, '見積')
  assert.deepEqual(last.hits.map(h => h.record.title), ['見積'])
  assert.deepEqual(last.lines.map(l => l.file), ['a/見積.md'])
  assert.equal(last.pending, 0)
})

test('clearing the box drops answers still on their way', async () => {
  const slow = deferred<FindResult>()
  const states: Array<FindState | null> = []
  const runner = createFindRunner({
    findRecords: () => slow.promise,
    grep: async () => ({ success: true, results: [] }),
    listFiles: async () => ({ success: true, files: [] }),
    fileTimes: async () => ({}),
  }, s => states.push(s))
  const first = runner.run('見積', '', '2026-11-03')
  await runner.run('  ', '', '2026-11-03')
  slow.resolve(records('見積'))
  await first
  assert.equal(states[states.length - 1], null)
})

test('file names are read once while fresh; times only for the files found', async () => {
  let lists = 0
  const timed: string[][] = []
  let clock = 0
  const runner = createFindRunner({
    grep: async () => ({ success: true, results: [{ file: '営業部/中身.md', line: 2, text: '見積' }] }),
    listFiles: async () => { lists++; return { success: true, files: ['営業部/見積.md', '営業部/ほか.md', '営業部/中身.md'] } },
    fileTimes: async paths => { timed.push([...paths]); return {} },
  }, () => {}, () => clock)
  await runner.run('見', '', '2026-11-03')
  await runner.run('見積', '', '2026-11-03')
  assert.equal(lists, 1)
  assert.deepEqual(timed[1].sort(), ['営業部/中身.md', '営業部/見積.md'])
  clock = 60_000
  await runner.run('見積', '', '2026-11-03')
  assert.equal(lists, 2)
})

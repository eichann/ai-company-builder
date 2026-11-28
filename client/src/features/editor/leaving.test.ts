// Leaving (sign-out, closing the window) never drops an edit silently: the rounds
// go on until every tab's text is saved or kept as it is at the last look.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leaveAfterSaving, type LeaveQuestion } from './leaving.ts'

/** Tabs path → { text, disk, kept }; `typing` runs while a round awaits (the member types meanwhile). */
function editors(tabs: Record<string, { text: string; disk: string; canSave?: boolean }>) {
  const kept = new Map<string, string>()
  const asked: string[] = []
  let duringKeep: Array<() => void> = []
  const unsaved = () => Object.entries(tabs).filter(([, t]) => t.text !== t.disk).map(([p]) => p)
  return {
    tabs, kept, asked,
    typeDuringNextKeep: (fn: () => void) => { duringKeep.push(fn) },
    steps: (answer: (q: LeaveQuestion) => boolean) => ({
      save: async () => {
        for (const p of unsaved()) if (tabs[p].canSave !== false) tabs[p].disk = tabs[p].text
        return unsaved()
      },
      keep: async (paths: readonly string[]) => {
        const at = new Map(paths.map(p => [p, tabs[p].text]))
        await Promise.resolve()
        const typing = duringKeep
        duringKeep = []
        for (const fn of typing) fn()
        for (const [p, text] of at) kept.set(p, text)
        return paths.filter(p => tabs[p].text !== at.get(p))
      },
      unsettled: () => unsaved().filter(p => kept.get(p) !== tabs[p].text),
      ask: async (q: LeaveQuestion) => { asked.push(q.confirmText); return answer(q) },
    }),
  }
}

test('typing in a saved tab while the last keep runs: that tab is saved before leaving goes on', async () => {
  const e = editors({ a: { text: 'a2', disk: 'a', canSave: false }, b: { text: 'b', disk: 'b' } })
  e.typeDuringNextKeep(() => { e.tabs.b.text = 'b + typed meanwhile' })
  assert.equal(await leaveAfterSaving(e.steps(() => true)), true)
  assert.equal(e.tabs.b.disk, 'b + typed meanwhile')
  assert.equal(e.kept.get('a'), 'a2')
  assert.deepEqual(e.asked, ['保存せずに進む'])
})

test('typing in a tab that cannot be saved, during its keep: kept again as it is now', async () => {
  const e = editors({ a: { text: 'a2', disk: 'a', canSave: false } })
  e.typeDuringNextKeep(() => { e.tabs.a.text = 'a3' })
  assert.equal(await leaveAfterSaving(e.steps(() => true)), true)
  assert.equal(e.kept.get('a'), 'a3')
  assert.deepEqual(e.asked, ['保存せずに進む'])
})

test('typing still going on during the next keep too: asked, never counted as kept', async () => {
  const e = editors({ a: { text: 'a2', disk: 'a', canSave: false } })
  e.typeDuringNextKeep(() => {
    e.tabs.a.text = 'a3'
    e.typeDuringNextKeep(() => { e.tabs.a.text = 'a4' })
  })
  assert.equal(await leaveAfterSaving(e.steps(q => q.confirmText === '保存せずに進む')), false)
  assert.deepEqual(e.asked, ['保存せずに進む', 'それでも進む'])
})

test('everything saved at once: nobody is asked', async () => {
  const e = editors({ a: { text: 'a2', disk: 'a' } })
  assert.equal(await leaveAfterSaving(e.steps(() => { throw new Error('asked') })), true)
  assert.equal(e.tabs.a.disk, 'a2')
})

test('キャンセル: leaving stops and nothing is kept', async () => {
  const e = editors({ a: { text: 'a2', disk: 'a', canSave: false } })
  assert.equal(await leaveAfterSaving(e.steps(() => false)), false)
  assert.equal(e.kept.size, 0)
})

test('an unsettled tab that cannot be settled (a check always naming it) asks instead of going on', async () => {
  const e = editors({ a: { text: 'a', disk: 'a' } })
  const steps = { ...e.steps(() => false), unsettled: () => ['a'] }
  assert.equal(await leaveAfterSaving(steps), false)
  assert.deepEqual(e.asked, ['保存せずに進む'])
})

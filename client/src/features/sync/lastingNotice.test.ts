import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forgetNotices, keepNotice, keptNotice } from './lastingNotice'

const c1 = { userId: 'u1', companyId: 'c1' }

function store(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    get length() { return items.size },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v) },
    removeItem: (k: string) => { items.delete(k) },
  }
}

const moved = { type: 'warning' as const, message: '移しました', backupPath: '/b/x' }

test('a notice about moved work comes back at the next launch until the member dismisses it', () => {
  const s = store()
  keepNotice(c1, moved, s)
  assert.deepEqual(keptNotice(c1, s), moved)
  assert.deepEqual(keptNotice(c1, s), moved, 'reading does not use it up')
  assert.equal(keptNotice({ userId: 'u1', companyId: 'c2' }, s), null, 'per company')
  keepNotice(c1, null, s)
  assert.equal(keptNotice(c1, s), null)
})

test('a failure with a backup is kept; a plain failure or success is not, and does not replace what is kept', () => {
  const s = store()
  keepNotice(c1, { type: 'error', message: '失敗', backupPath: '/b/y' }, s)
  assert.equal(keptNotice(c1, s)?.backupPath, '/b/y')
  keepNotice(c1, { type: 'error', message: '接続できません' }, s)
  keepNotice(c1, { type: 'success', message: '同期しました' }, s)
  assert.equal(keptNotice(c1, s)?.backupPath, '/b/y')
})

test('what is stored cannot break the app, and storage that refuses changes nothing for the session', () => {
  assert.equal(keptNotice(c1, store({ 'acb.sync.lastingNotice:u1:c1': '{broken' })), null)
  assert.equal(keptNotice(c1, store({ 'acb.sync.lastingNotice:u1:c1': '{"type":"success","message":"x"}' })), null)
  assert.doesNotThrow(() => keepNotice(c1, moved, { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('full') } }))
})

test('a notice can name a private folder: the next account on this PC never sees it, and sign-out removes it', () => {
  const s = store()
  keepNotice(c1, moved, s)
  keepNotice({ userId: 'u1', companyId: 'c2' }, moved, s)
  keepNotice({ userId: 'u2', companyId: 'c1' }, { ...moved, message: 'u2' }, s)
  assert.deepEqual(keptNotice(c1, s), moved)
  assert.equal(keptNotice({ userId: 'u3', companyId: 'c1' }, s), null)
  forgetNotices('u1', s)
  assert.equal(keptNotice(c1, s), null)
  assert.equal(keptNotice({ userId: 'u1', companyId: 'c2' }, s), null)
  assert.equal(keptNotice({ userId: 'u2', companyId: 'c1' }, s)?.message, 'u2')
})

test('a later warning joins an unseen recovery notice instead of replacing it', () => {
  const s = store()
  const recovery = { type: 'warning' as const, message: '止まっていた間のファイルを保存しました', backupPath: '/b/r', mustSee: true }
  keepNotice(c1, recovery, s)
  const shown = keepNotice(c1, { type: 'warning', message: '部署フォルダを復元しました' }, s)
  assert.match(shown?.message ?? '', /保存しました/)
  assert.match(shown?.message ?? '', /復元しました/)
  assert.equal(shown?.backupPath, '/b/r')
  assert.deepEqual(keptNotice(c1, s), shown)
  assert.equal(keepNotice(c1, null, s), null, 'dismissing it still works')
  assert.equal(keptNotice(c1, s), null)
})

test('an ordinary warning is simply replaced by the next one', () => {
  const s = store()
  keepNotice(c1, { type: 'warning', message: '一つ目' }, s)
  assert.equal(keepNotice(c1, { type: 'warning', message: '二つ目' }, s)?.message, '二つ目')
})

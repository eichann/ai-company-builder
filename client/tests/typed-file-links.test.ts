// A company without the shared folder (records.md "Drive and PC file links", tasks-ui.md
// "Linking files"). Guards: the card keeps a PC file and a Drive file apart from company files, and a
// Drive file's name only when the server says the member linked it; a file dropped with `local` is sent
// as the member's own target (a plain drop stays a company path); removing sends only a working-folder
// path or a Drive id; 「Google Drive のファイルをつなぐ」 links each pick at the version the previous link
// moved to, nothing when the member picked nothing; a pasted link hands the Picker only Drive ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { RecordDetail, RecordSummary } from '../../shared/types/records'
import { driveFileUrl, taskCardOf } from '../shared/task-card'
import { createTasksApi, type TasksDeps } from '../electron/features/tasks/ipc'

const defs = new Map(coreTypeDefinitions().map(d => [d.name, d]))
const task: RecordSummary = { id: 'task-0000aa', type: 'task', typeVersion: 13, title: '見積書', summary: '', path: null, state: 'todo', fields: { assignee: 'u-me' }, version: 4, updatedAt: '2026-11-08T01:00:00.000Z' }

test('the card keeps PC and Drive files apart; a Drive file is named only when the member linked it', () => {
  const detail = {
    record: task,
    links: [
      { name: 'files', direction: 'out', local: { path: '営業/メモ.md' } },
      { name: 'files', direction: 'out', drive: { fileId: '1AbCdEfGhIjKl', mine: true, name: 'A社 提案書' } },
      // A name an older or broken answer sends for someone else's link is never shown.
      { name: 'files', direction: 'out', drive: { fileId: '1ZyXwVuTsRqPo', mine: false, name: '他人の名前' } },
      { name: 'files', direction: 'out', path: '営業/見積.md' },
    ],
  } as unknown as RecordDetail
  const c = taskCardOf({ me: 'u-me', detail, def: defs.get('task'), defs, entries: [], people: {}, runs: [] })
  assert.deepEqual(c.localFiles, [{ path: '営業/メモ.md' }])
  assert.deepEqual(c.driveFiles, [{ fileId: '1AbCdEfGhIjKl', mine: true, name: 'A社 提案書' }, { fileId: '1ZyXwVuTsRqPo', mine: false, name: null }])
  assert.deepEqual(c.files.map(f => f.path), ['営業/見積.md'])
  assert.equal(driveFileUrl('1AbC/../x'), 'https://drive.google.com/file/d/1AbC%2F..%2Fx/view')
})

function harness(over: Partial<TasksDeps> = {}) {
  const sent: Array<{ path: string; body: unknown }> = []
  let version = 3
  const api = createTasksApi({
    baseUrl: () => 'https://acb.test', cookies: () => ['s=1'], log: { warn: () => {} },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace('/api/companies/co1', '')
      if (path === '/records/types') return Response.json({ data: { types: [...defs.values()].map(definition => ({ definition })) } })
      if (/^\/records\/item\/[^/]+$/.test(path) && (!init.method || init.method === 'GET')) {
        return Response.json({ data: { record: { ...task, version: 3 }, links: [] } })
      }
      sent.push({ path, body: JSON.parse(String(init.body)) })
      version += 1
      return Response.json({ data: { entry: { version }, changed: true } })
    }) as unknown as typeof fetch,
    ...over,
  })
  return { api, sent }
}

test('a dropped file of the working folder is linked as the member’s own; a plain drop stays a company path', async () => {
  const h = harness()
  const r = await h.api.dropLink('co1', 'task-0000aa', { kind: 'path', path: '経理/請求書.xlsx', local: true })
  assert.equal(r.success && 'done' in r && r.done.text, '「請求書.xlsx」をつなぎました（あなただけに見えます）')
  await h.api.dropLink('co1', 'task-0000aa', { kind: 'path', path: '経理/請求書.xlsx' })
  assert.deepEqual(h.sent.map(s => s.body), [
    { target: { kind: 'local', path: '経理/請求書.xlsx' }, link: 'files', expectedVersion: 3 },
    { path: '経理/請求書.xlsx', link: 'files', expectedVersion: 3 },
  ])
  // Outside the working folder: never sent.
  assert.equal((await h.api.dropLink('co1', 'task-0000aa', { kind: 'path', path: '../秘密.md', local: true })).success, false)
  assert.equal(h.sent.length, 2)
})

test('taking a file off sends only a working-folder path or a Drive id', async () => {
  const h = harness()
  assert.equal((await h.api.unlinkTarget('co1', 'task-0000aa', { kind: 'local', path: '営業/メモ.md' }, 3)).success, true)
  assert.equal((await h.api.unlinkTarget('co1', 'task-0000aa', { kind: 'drive', fileId: '1AbCdEfGhIjKl' }, 4)).success, true)
  for (const bad of [{ kind: 'local', path: '/Users/me/秘密.md' }, { kind: 'local', path: '../x' }, { kind: 'drive', fileId: '../../x' }, { kind: 'drive', fileId: 'short' }, { kind: 'other', path: 'a' }]) {
    assert.equal((await h.api.unlinkTarget('co1', 'task-0000aa', bad as never, 5)).success, false, JSON.stringify(bad))
  }
  assert.deepEqual(h.sent, [
    { path: '/records/item/task-0000aa/file-links/remove', body: { target: { kind: 'local', path: '営業/メモ.md' }, expectedVersion: 3 } },
    { path: '/records/item/task-0000aa/file-links/remove', body: { target: { kind: 'drive', fileId: '1AbCdEfGhIjKl' }, expectedVersion: 4 } },
  ])
})

test('「Google Drive のファイルをつなぐ」 links each pick at the version the previous link moved to; nothing picked, nothing sent', async () => {
  const picked = harness({ pickDriveFiles: async () => ({ ok: true, files: [{ id: '1AbCdEfGhIjKl', name: 'A社 提案書' }, { id: 'bad/id', name: 'x' }, { id: '1ZyXwVuTsRqPo', name: 'B社 見積' }] }) })
  const r = await picked.api.linkDriveFiles('co1', 'task-0000aa', 7)
  assert.deepEqual(r, { success: true, recordId: 'task-0000aa', linked: ['A社 提案書', 'B社 見積'] })
  assert.deepEqual(picked.sent.map(s => s.body), [
    { target: { kind: 'drive', fileId: '1AbCdEfGhIjKl' }, expectedVersion: 7 },
    { target: { kind: 'drive', fileId: '1ZyXwVuTsRqPo' }, expectedVersion: 4 },
  ])
  const cancelled = harness({ pickDriveFiles: async () => ({ ok: false, ended: 'cancelled', message: '' }) })
  assert.deepEqual(await cancelled.api.linkDriveFiles('co1', 'task-0000aa', 7), { success: true, recordId: 'task-0000aa', linked: [], ended: 'cancelled' })
  assert.deepEqual(cancelled.sent, [])
  const none = harness()
  assert.equal((await none.api.linkDriveFiles('co1', 'task-0000aa', 7)).success, false)
})

test('a pasted Drive link: only Drive ids reach the Picker, and nothing is linked but what the member picked there', async () => {
  const asked: string[][] = []
  const h = harness({ pickDriveFiles: async (_c, fileIds) => { asked.push(fileIds); return { ok: true, files: [{ id: '1ZyXwVuTsRqPo', name: 'B社 見積' }] } } })
  await h.api.linkDriveFiles('co1', 'task-0000aa', 7, { fileIds: ['1AbCdEfGhIjKl', 'bad/id', "x');alert(1)//", 7, '1AbCdEfGhIjKl'] })
  // The bare array an unreleased build sent is read the same way.
  await h.api.linkDriveFiles('co1', 'task-0000aa', 7, ['1ZyXwVuTsRqPo'])
  await h.api.linkDriveFiles('co1', 'task-0000aa', 7, 'not-a-list-1AbCdEfGhIjKl')
  await h.api.linkDriveFiles('co1', 'task-0000aa', 7)
  assert.deepEqual(asked, [['1AbCdEfGhIjKl'], ['1ZyXwVuTsRqPo'], [], []])
  // The link is of the file picked in the Picker, not the one pasted.
  assert.deepEqual(h.sent.map(s => (s.body as { target: unknown }).target), Array(4).fill({ kind: 'drive', fileId: '1ZyXwVuTsRqPo' }))
})

test('files chosen from the member\'s own list are linked without Google\'s window; a malformed list sends nothing', async () => {
  let pickerOpened = 0
  const h = harness({ pickDriveFiles: async () => { pickerOpened++; return { ok: true, files: [] } } })
  const r = await h.api.linkDriveFiles('co1', 'task-0000aa', 7, { chosen: [{ id: '1AbCdEfGhIjKl', name: 'A社 ご提案.pdf', source: 'put' }] })
  assert.deepEqual(r, { success: true, recordId: 'task-0000aa', linked: ['A社 ご提案.pdf'] })
  assert.equal(pickerOpened, 0)
  assert.deepEqual(h.sent.map(s => s.body), [{ target: { kind: 'drive', fileId: '1AbCdEfGhIjKl' }, expectedVersion: 7 }])
  for (const bad of [[{ id: '../x', name: 'a' }], [{ id: '1AbCdEfGhIjKl' }], 'x', Array.from({ length: 31 }, () => ({ id: '1AbCdEfGhIjKl', name: 'a' }))]) {
    assert.equal((await h.api.linkDriveFiles('co1', 'task-0000aa', 7, { chosen: bad })).success, false, JSON.stringify(bad).slice(0, 60))
  }
  assert.equal(h.sent.length, 1)
  assert.equal(pickerOpened, 0)
  // The list itself: what the Google connection answered, well formed; none without it.
  const listed = harness({ driveChoices: async () => [{ id: '1AbCdEfGhIjKl', name: 'A社 ご提案.pdf', source: 'put' }] })
  assert.deepEqual(await listed.api.driveChoices('co1'), [{ id: '1AbCdEfGhIjKl', name: 'A社 ご提案.pdf', source: 'put' }])
  assert.deepEqual(await harness().api.driveChoices('co1'), [])
})

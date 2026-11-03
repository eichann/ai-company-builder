/**
 * Consultations centre on the task (owner decision 2026-11-03, tasks-ui.md "Consultations centre on
 * the task"). Guards:
 * - a task the AI makes becomes the topic only of a consultation without one, and never again after
 *   the member took a topic off (the history keeps that across the renderer's saves);
 * - only files a call newly creates count: a Write where nothing was, Codex's `add`; never an edit,
 *   a file outside the company folder, the app's scratch; and only once the call finished ok;
 * - the link is made with the turn's act token at the version read, once more on a conflict, and a
 *   refusal never throws (the chat goes on); a read token links nothing;
 * - a task only the member sees sends new files to today's folder in the AI's instructions.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newFilesOfCall, taskTopicInstructions, taskTopicOf, topicAfterTaskMade } from '../shared/consultation-task'
import type { ToolEventTracker } from '../shared/agent-events'
import { watchNewFiles } from '../electron/agents/tool-events'
import { bashWriteTargets } from '../electron/write-guard'
import { ChatHistoryStore } from '../electron/chat-history-store'
import type { ChatSession } from '../shared/chat-history'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { coreTypeDefinitions } from '../../shared/core/core-types'

const ROOT = '/Users/me/会社'

test('a task the AI makes becomes the topic only when there is none and the member never took one off', () => {
  const task = { id: 'task-0001ab', type: 'task' }
  assert.equal(topicAfterTaskMade({}, task), 'task-0001ab')
  assert.equal(topicAfterTaskMade({ topicRecordId: 'deal-0001ab' }, task), null)
  assert.equal(topicAfterTaskMade({ topicDetached: true }, task), null)
  assert.equal(topicAfterTaskMade({}, { id: 'decision-0001ab', type: 'decision' }), null)
  assert.equal(topicAfterTaskMade({}, { id: '../x', type: 'task' }), null)
  assert.equal(topicAfterTaskMade(null, task), null)
  assert.equal(taskTopicOf({ topicRecordId: 'task-0001ab' }), 'task-0001ab')
  assert.equal(taskTopicOf({ topicRecordId: 'deal-0001ab' }), null)
})

test('only what a call newly creates in the company folder counts', () => {
  const ctx = { companyRoot: ROOT, cwd: ROOT }
  const exists = (p: string) => p === `${ROOT}/営業/見積.md`
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { file_path: `${ROOT}/営業/メモ.md` } }, ctx, exists), ['営業/メモ.md'])
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { file_path: '営業/メモ.md' } }, ctx, exists), ['営業/メモ.md'], 'relative to the cwd')
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { file_path: `${ROOT}/営業/見積.md` } }, ctx, exists), [], 'overwriting a file is not new')
  assert.deepEqual(newFilesOfCall({ tool: 'Edit', input: { file_path: `${ROOT}/営業/メモ.md` } }, ctx, exists), [])
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { file_path: '/tmp/x.md' } }, ctx, exists), [], 'outside the company folder')
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { file_path: `${ROOT}/.workspace/shot.png` } }, ctx, exists), [])
  // A shell redirect, as the write guard reads it: a new target counts, an append to a file that exists does not.
  const shell = (command: string) => newFilesOfCall({ tool: 'Bash', input: { command } }, ctx, exists, bashWriteTargets)
  assert.deepEqual(shell(`mkdir -p 営業 && cat > "営業/新メモ.md" << 'EOF'\n# メモ\nEOF`), ['営業/新メモ.md'])
  assert.deepEqual(shell(`echo "- 追記" >> ${ROOT}/営業/見積.md`), [])
  assert.deepEqual(shell('cp a.md 営業/コピー.md'), [], 'what cp writes is not read')
  // A leading `cd <folder> &&` (the AI's habit): targets resolve from that folder.
  assert.deepEqual(shell(`cd "${ROOT}" && mkdir -p 営業 && cat > 営業/cdメモ.md << 'EOF'\nx\nEOF`), ['営業/cdメモ.md'])
  assert.deepEqual(shell(`cd ${ROOT}/営業 && echo x > 二つ目.md`), ['営業/二つ目.md'])
  assert.deepEqual(shell(`d="営業" && cat > "$d/変数.md" << 'EOF'\nx\nEOF`), [], 'a path through a variable is not read')
  assert.deepEqual(newFilesOfCall({ tool: 'Bash', input: { command: 'echo > a.md' } }, ctx, exists), [], 'no shell reading given')
  // Codex: the change's kind says it.
  assert.deepEqual(newFilesOfCall({ tool: 'Write', input: { changes: [
    { path: `${ROOT}/営業/新規.md`, kind: { type: 'add' } }, { path: `${ROOT}/営業/見積.md`, kind: { type: 'update' } }, { path: `${ROOT}/営業/b.md`, kind: 'add' },
  ] } }, ctx, exists), ['営業/新規.md', '営業/b.md'])
})

function fakeTracker(): ToolEventTracker {
  return { decide: (id: string | undefined) => id ?? 'x', start: () => {}, finish: () => {}, close: () => {} }
}

test('a created file is told once the call finished ok — not for a refused or failed call, nor for an edit', () => {
  const disk = new Set<string>([`${ROOT}/営業/見積.md`])
  const told: string[] = []
  const t = watchNewFiles(fakeTracker(), { companyRoot: ROOT, cwd: ROOT }, p => told.push(p), p => disk.has(p))
  const write = (file: string) => ({ tool: 'Write', input: { file_path: `${ROOT}/${file}` } })

  t.decide('a', write('営業/メモ.md'), 'policy-default')
  disk.add(`${ROOT}/営業/メモ.md`)
  t.finish('a', 'ok')
  t.decide('b', write('営業/見積.md'), 'policy-default')
  t.finish('b', 'ok')
  t.decide('c', write('営業/断られた.md'), 'guard-denied')
  t.finish('c', 'ok')
  t.decide('d', write('営業/失敗.md'), 'policy-default')
  t.finish('d', 'error')
  // Codex reports the call when it starts.
  t.start('e', { tool: 'Write', input: { changes: [{ path: `${ROOT}/営業/codex.md`, kind: { type: 'add' } }] } })
  disk.add(`${ROOT}/営業/codex.md`)
  t.finish('e', 'ok')
  assert.deepEqual(told, ['営業/メモ.md', '営業/codex.md'])
})

function history(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-topic-test-'))
  const store = new ChatHistoryStore(dir)
  t.after(async () => { await store.flush().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }) })
  return store
}
const session = (extra: Partial<ChatSession> = {}): ChatSession => ({
  id: 'chat-1', companyId: 'co', title: '相談', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z',
  messages: [{ id: 'm1', role: 'user', content: '見積を作りたい', timestamp: '2026-11-03T00:00:00Z' }], writerId: 'w', writeSequence: 1, ...extra,
})

test('taken off, the topic stays off through the renderer\'s saves and no task becomes it again; one set by main survives a save without it', t => {
  const store = history(t)
  store.save('co', session())
  // Main: the AI made a task.
  const topic = topicAfterTaskMade(store.get('co', 'chat-1'), { id: 'task-0001ab', type: 'task' })
  assert.equal(topic, 'task-0001ab')
  store.patch('co', 'chat-1', { topicRecordId: topic! })
  // The renderer's next save does not know it yet: kept.
  store.save('co', session({ writeSequence: 2 }))
  assert.equal(taskTopicOf(store.get('co', 'chat-1')), 'task-0001ab')

  // The member's ×: off, and a save that still carries it does not bring it back.
  store.patch('co', 'chat-1', { topicRecordId: null })
  store.save('co', session({ writeSequence: 3, topicRecordId: 'task-0001ab' }))
  const after = store.get('co', 'chat-1')
  assert.equal(after?.topicRecordId, undefined)
  assert.equal(taskTopicOf(after), null, 'no more automatic links')
  assert.equal(topicAfterTaskMade(after, { id: 'task-0002cd', type: 'task' }), null, 'no more automatic topics')
  assert.throws(() => store.patch('co', 'chat-1', { topicRecordId: '../../x' }))
})

const TYPES = coreTypeDefinitions()
function server(scope: 'read' | 'act', answers: { item?: Array<{ status: number; body: unknown }>; link?: Array<{ status: number; body: unknown }> } = {}) {
  const seen: Array<{ method: string; url: string; body?: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    seen.push({ method, url, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const ok = (data: unknown) => json(200, { success: true, data })
    if (url.endsWith('/me/record-tokens')) return json(201, { success: true, data: { token: 'acb_rec_co.' + 'a'.repeat(64), tokenId: 't', scope, expiresAt: 'x' } })
    if (url.includes('/me/record-tokens/')) return ok({ revoked: true })
    if (url.endsWith('/api/records-ai/types')) return ok({ types: TYPES.map(definition => ({ definition, source: 'core', versions: [1] })) })
    if (url.endsWith('/api/records-ai/plugins')) return ok({ plugins: [] })
    if (url.endsWith('/api/records-ai/item') && method === 'POST') return ok({ record: { id: 'task-0009zz', type: 'task', version: 1, fields: {} }, placed: { personal: true, folder: null } })
    if (url.endsWith('/file-links')) { const a = answers.link?.shift(); return a ? json(a.status, a.body) : ok({ changed: true, version: 4 }) }
    if (/\/api\/records-ai\/item\/task-[a-z0-9]+$/.test(url)) { const a = answers.item?.shift(); return a ? json(a.status, a.body) : ok({ record: { id: 'task-0001ab', type: 'task', title: '見積を直す', version: 3, personal: true }, links: [] }) }
    return ok({})
  }) as unknown as typeof globalThis.fetch
  return { api: createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch }), seen }
}

test('records_create tells which record it made; a new file is linked as the AI at the version read, once more on a conflict', async () => {
  const { api, seen } = server('act', { link: [{ status: 409, body: { success: false, code: 'VERSION_CONFLICT', error: '先に変わりました', version: 4 } }] })
  const made: unknown[] = []
  const tools = (await createRecordTools((await api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!, undefined, { onRecordCreated: r => made.push(r) }))!
  await tools.execute('records_create', { type: 'task', title: '見積を直す' })
  assert.deepEqual(made, [{ id: 'task-0009zz', type: 'task' }])

  assert.equal(await tools.linkNewFile('task-0001ab', '営業/.personal/inbox/日付別/2026/20261103/見積メモ.md'), true)
  const links = seen.filter(s => s.url.endsWith('/file-links'))
  assert.equal(links.length, 2, 'once more after the conflict')
  assert.deepEqual(links[1].body, { path: '営業/.personal/inbox/日付別/2026/20261103/見積メモ.md', expectedVersion: 3, note: 'AI が相談の中で作ったファイル' })
  assert.ok(links.every(l => l.url.includes('/api/records-ai/item/task-0001ab/')), 'with the turn\'s token, as the AI')
  assert.deepEqual(await tools.readTask('task-0001ab'), { id: 'task-0001ab', title: '見積を直す', personal: true })
})

test('a refused link answers false and never throws; a read token links nothing; a bad id never reaches the server', async () => {
  const refused = server('act', { link: [{ status: 400, body: { success: false, code: 'FILE_NOT_LINKABLE', error: 'つなげません' } }] })
  const act = (await createRecordTools((await refused.api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!))!
  assert.equal(await act.linkNewFile('task-0001ab', '非公開/x.md'), false)
  const before = refused.seen.length
  assert.equal(await act.linkNewFile('task-../x', 'a.md'), false)
  assert.equal(refused.seen.length, before)

  const read = server('read')
  const codex = (await createRecordTools((await read.api.openTurn('co', { conversationId: 'c', agent: 'codex', scope: 'read' }))!))!
  assert.equal(await codex.linkNewFile('task-0001ab', 'a.md'), false)
  assert.equal(read.seen.filter(s => s.url.endsWith('/file-links')).length, 0)
})

test('a task only the member sees keeps new files in today\'s folder; a shared one is only told about the links', () => {
  const own = taskTopicInstructions({ id: 'task-0001ab', title: '見積を直す', personal: true }, '営業/.personal/inbox/日付別/2026/20261103')
  assert.match(own, /自動でこのやることにつなぎます/)
  assert.match(own, /今日のフォルダ「営業\/\.personal\/inbox\/日付別\/2026\/20261103\/」/)
  const shared = taskTopicInstructions({ id: 'task-0001ab', title: '見積を直す', personal: false }, '営業/.personal/inbox/日付別/2026/20261103')
  assert.match(shared, /自動でこのやることにつなぎます/)
  assert.doesNotMatch(shared, /今日のフォルダ/)
  assert.doesNotMatch(taskTopicInstructions({ id: 'task-0001ab', title: 'x', personal: true }, null), /今日のフォルダ/)
})

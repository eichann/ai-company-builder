/**
 * The company map in the app (`.claude/rules/records.md`, stage 4-6).
 *
 * Guards:
 * - the AI's record calls carry only the turn's record token, never the
 *   member's session; the session is used only by main to get and revoke the
 *   token; a turn's token is revoked when it ends;
 * - tools are generated from the type definitions; a `read` token (Codex,
 *   0.3-3) gets no state-changing tool; Codex's registry entry never gets
 *   record actions;
 * - a tool refuses input its schema refuses (a required note) before calling;
 * - the chat write guard: `.acb/types/` only for owners/admins; a record
 *   file's frontmatter cannot get state & co., and an existing record's id /
 *   type cannot change; editing its text is fine;
 * - screens are offered only the actions that can start from the state.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { decideRecordEdit } from '../electron/write-guard'
import { AGENTS } from '../shared/agents/registry'
import { recordActionChoices } from '../shared/record-actions'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { RECORD_ACTION_AGENTS } from '../../shared/types/records'
import { AGENT_IDS } from '../shared/agents/registry'

const TYPES = coreTypeDefinitions()
const TASK = TYPES.find(t => t.name === 'task')!

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeServer(scope: 'read' | 'act') {
  const seen: Seen[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined })
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: 'acb_rec_co.' + 'a'.repeat(64), tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.includes('/me/record-tokens/')) return json(200, { revoked: true })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: TYPES.map(definition => ({ definition, source: 'core', versions: [1] })) })
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['better-auth.session_token=SECRET.sig'], fetch })
  return { api, seen }
}

test('the AI\'s record calls carry the record token, never the session; the turn\'s token is revoked at its end', async () => {
  const { api, seen } = fakeServer('act')
  const access = await api.openTurn('co', { conversationId: 'c1', agent: 'claude-code', scope: 'act' })
  assert.ok(access)
  const tools = await createRecordTools(access)
  assert.ok(tools)
  await tools.execute('records_my_turn', {})
  await tools.execute('task__start', { id: 'task-abcdef12', expectedVersion: 1 })
  await tools.close()

  const issue = seen.find(s => s.url.endsWith('/me/record-tokens'))!
  assert.equal(issue.headers.Cookie, 'better-auth.session_token=SECRET.sig')
  const aiCalls = seen.filter(s => s.url.includes('/api/records-ai/'))
  assert.ok(aiCalls.length >= 3)
  for (const call of aiCalls) {
    assert.equal(call.headers.Authorization, `Bearer acb_rec_co.${'a'.repeat(64)}`)
    assert.ok(!('Cookie' in call.headers), 'the session never goes with an AI call')
    assert.ok(!JSON.stringify(call).includes('SECRET'))
  }
  const start = aiCalls.find(s => s.url.endsWith('/actions/start'))!
  assert.equal(start.method, 'POST')
  assert.deepEqual(JSON.parse(start.body!), { expectedVersion: 1, args: {} })
  assert.ok(seen.some(s => s.method === 'DELETE' && s.url.endsWith('/me/record-tokens/tok-1')))
})

test('tools come from the type definitions; a read token gets no state-changing tool; Codex never gets record actions', async () => {
  const act = await createRecordTools((await fakeServer('act').api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!)
  const names = act!.specs.map(s => s.name)
  for (const a of Object.keys(TASK.actions)) assert.ok(names.includes(`task__${a}`), a)
  assert.ok(names.includes('records_create'))

  const read = await createRecordTools((await fakeServer('read').api.openTurn('co', { conversationId: 'c', agent: 'codex', scope: 'read' }))!)
  assert.ok(read!.specs.every(s => s.readOnly), read!.specs.filter(s => !s.readOnly).map(s => s.name).join())
  assert.equal(AGENTS.codex.capabilities.recordActions, false)
  assert.equal(AGENTS['claude-code'].capabilities.recordActions, true)
  // The server's own list (it downgrades any other agent to a read token) agrees with the registry.
  assert.deepEqual(AGENT_IDS.filter(id => AGENTS[id].capabilities.recordActions).sort(), [...RECORD_ACTION_AGENTS].sort())
})

test('a tool refuses what its schema refuses before calling the server (a required note)', async () => {
  const { api, seen } = fakeServer('act')
  const tools = await createRecordTools((await api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!)
  const before = seen.length
  const out = JSON.parse(await tools!.execute('task__send_back', { id: 'task-abcdef12', expectedVersion: 3 }))
  assert.ok(out.error)
  assert.equal(seen.length, before)
})

const ROOT = '/Users/me/会社'
const withRole = (role: string | undefined): WriteGuard => ({
  root: ROOT, getAccess: () => undefined,
  getInstructionAuthority: () => (role ? { role, managedFolders: [] } : undefined),
})

test('.acb/types/ is for owners and admins only; unknown authority never blocks', () => {
  const input = { file_path: `${ROOT}/.acb/types/deal.md`, content: '---\nlabel: x\n---\n' }
  const denied = decideToolWrite(withRole('member'), 'Write', input)
  assert.equal(denied.deny, true)
  assert.equal(denied.deny && denied.code, 'type-definition')
  assert.equal(decideToolWrite(withRole('member'), 'Edit', { file_path: `${ROOT}/.ACB/Types/deal.md`, old_string: 'a', new_string: 'b' }).deny, true)
  assert.equal(decideToolWrite(withRole('admin'), 'Write', input).deny, false)
  assert.equal(decideToolWrite(withRole(undefined), 'Write', input).deny, false)
})

test('a record file\'s frontmatter cannot get state & co., nor an existing record a new id or type; its text can change', () => {
  const file = `${ROOT}/営業部/タスク/見積.md`
  const current = '---\nid: task-abcdef12\ntype: task\n---\n# 見積\n\n本文\n'
  const read = () => current
  const guard = withRole('member')
  const decide = (tool: string, input: Record<string, unknown>) => decideRecordEdit(guard, tool, { file_path: file, ...input }, undefined, read)

  const state = decide('Edit', { old_string: 'type: task\n', new_string: 'type: task\nstate: done\n' })
  assert.equal(state.deny, true)
  assert.match(state.deny ? state.message : '', /記録の道具/)
  assert.equal(decide('Write', { content: '---\nid: task-abcdef12\ntype: task\nassignee: u-1\n---\n# 見積\n' }).deny, true)
  assert.equal(decide('Edit', { old_string: 'id: task-abcdef12', new_string: 'id: task-zzzzzz99' }).deny, true)
  assert.equal(decide('MultiEdit', { edits: [{ old_string: '---\nid', new_string: 'id' }] }).deny, true)
  assert.equal(decide('Edit', { old_string: '本文', new_string: '本文を直した' }).deny, false)
  assert.equal(decide('Edit', { old_string: '---\n#', new_string: '---\nlinks:\n  files: [営業部/見積.xlsx]\n---\n#' }).deny, false)
  // An ordinary Markdown file with frontmatter is not a record.
  assert.equal(decideRecordEdit(guard, 'Write', { file_path: `${ROOT}/メモ.md`, content: '---\ntitle: x\nstatus: draft\n---\n' }, undefined, () => null).deny, false)
  // The hook decides it too.
  assert.equal(decideToolWrite({ ...guard }, 'Write', { file_path: `${ROOT}/新規.md`, content: '---\nid: task-newnew01\ntype: task\nstate: todo\n---\n' }).deny, true)
})

test('screens are offered only the actions that can start from the record\'s state', () => {
  const titles = (state: string) => recordActionChoices(TASK, state).map(c => c.action).sort()
  assert.deepEqual(titles('done'), ['reopen', 'set_due'])
  assert.ok(titles('review').includes('complete'))
  assert.ok(!titles('todo').includes('complete'))
  assert.equal(recordActionChoices(TASK, 'review').find(c => c.action === 'send_back')!.noteRequired, true)
})

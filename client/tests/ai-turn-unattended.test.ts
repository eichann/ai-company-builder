// An unattended 「AI の番」 run gets ONLY its step's tools (owner decision 2026-11-01, ai-turns.md):
// none of the member's own settings, MCP servers, hooks or plugins; Claude Code's built-in shell,
// web and file-write tools denied; only the record tools the step declares. Normal turns unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { claudeCode } from 'ai-sdk-provider-claude-code'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection } from '../electron/agents/codex'
import { aiTurnStepAllowsRecordTool, aiTurnStepDefinition } from '../shared/ai-turn-steps/registry'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { buildChatRequestBody, type ChatRequestSources } from '../src/features/chat/chatRequestBody'

const claudeConfig: ClaudeConnectionConfig = {
  getPermissionMode: () => 'bypassPermissions',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: '/test' }),
}
const text = async () => '{}'
const spec = (name: string) => ({ name, description: name, schema: z.object({}), readOnly: true })

function optionsOf(unattended: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  createClaudeConnection(claudeConfig, factory).createChatModel({
    workingDirectory: '/Users/m/会社',
    // Everything a normal consultation gets: the unattended run must drop all but the records.
    references: { execute: text },
    companyFiles: { execute: text },
    review: { execute: text },
    webResearch: { execute: text },
    records: { specs: [spec('minutes_read'), spec('records_create')], execute: text, close: async () => {}, instructions: '' },
    askUser: async () => ({ answers: {} }) as never,
    ...(unattended ? { unattended: { builtinTools: aiTurnStepDefinition('minutes-reading').tools.builtinTools } } : {}),
  })
  return options
}

test('an unattended run loads none of the member\'s settings, MCP servers, hooks or plugins, and has no built-in shell / web / write tools', async () => {
  const o = optionsOf(true)
  assert.deepEqual(o.settingSources, [])
  assert.equal(o.strictMcpConfig, true)
  // No built-in tool at all (minutes reading declares none), and a deny for shell, web and writes besides.
  assert.deepEqual(o.tools, [])
  for (const name of ['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent']) {
    assert.ok(o.settings.permissions.deny.includes(name), name)
  }
  // Only the app's record server, only its tools.
  assert.deepEqual(Object.keys(o.mcpServers), ['acb_records'])
  assert.deepEqual(o.allowedTools, ['mcp__acb_records__minutes_read', 'mcp__acb_records__records_create'])
  // Anything else is refused, never asked (nobody is watching), even in bypass mode.
  const answer = await o.canUseTool('Bash', { command: 'curl https://example.com' }, { toolUseID: 't1' })
  assert.equal(answer.behavior, 'deny')
})

test('a member\'s own consultation keeps its settings, MCP servers and tools', () => {
  const o = optionsOf(false)
  assert.deepEqual(o.settingSources, ['user', 'project'])
  assert.equal(o.strictMcpConfig, undefined)
  assert.equal(o.tools, undefined)
  assert.ok(Object.keys(o.mcpServers).length > 1)
})

test('an agent that cannot honour an unattended step refuses it instead of running unrestricted', () => {
  const codex = createCodexConnection({ getShellEnv: () => ({}) } as never)
  assert.throws(() => codex.createChatModel({ unattended: { builtinTools: [] } }), /unattended/)
})

test('minutes reading declares only its record tools', () => {
  for (const name of ['minutes_read', 'minutes_link_bundle', 'meeting__start_reading', 'meeting__finish_reading', 'meeting__fail_reading', 'records_create',
    'decisions_record', 'mail_draft_create', 'mail_draft_update', 'mail_draft_show', 'mail_recipients']) {
    assert.ok(aiTurnStepAllowsRecordTool('minutes-reading', name), name)
  }
  // No business plugin's operation (the まとまり's part is the plugin's own step, plugin-steps.md).
  for (const name of ['records_query', 'records_link_file', 'records_my_turn', 'approvals_list', 'task__complete', '__update_deal', 'corporate-sales__update_deal', 'corporate-sales__log_meeting', 'corporate-sales__create_deal', 'minutes__start_reading', 'meeting__skip']) {
    assert.ok(!aiTurnStepAllowsRecordTool('minutes-reading', name), name)
  }
})

test('the step rides on the one automatic request only; the member\'s next message is a normal turn', () => {
  const ref = <T>(current: T) => ({ current })
  const sources: ChatRequestSources = {
    authMode: ref('claude-code'), agentSession: ref(null), workingDirectory: ref('/w'), companyId: ref('c'), companyRootPath: ref('/w'),
    activeDepartment: ref(undefined), modelId: ref(undefined), effort: ref('medium'), promptSuggestions: () => true,
    appSessionId: ref('s1'), claudeSessionId: ref(null), pendingImages: ref([]), pendingFilePaths: ref([]), handoffRequest: ref(null),
    aiTurnStep: ref('minutes-reading'),
  }
  assert.equal(buildChatRequestBody(sources).aiTurnStep, 'minutes-reading')
  assert.equal(buildChatRequestBody(sources).aiTurnStep, undefined)
})

test('after earlier runs were put back (version > 2), an unattended run can still finish reading: it never has to guess the version', async () => {
  const MEETING = 'meeting-0a1b2c3d4e5f6071'
  // Started by the app's claim after two put-backs: reading at version 7 (a first run would be at 2).
  const record = { state: 'reading', version: 7 }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (path.endsWith('/me/record-tokens')) return json(201, { data: { token: 'acb_rec_x', tokenId: 't1', scope: 'act' } })
    if (path === '/api/records-ai/types') return json(200, { data: { types: coreTypeDefinitions().filter(t => t.name === 'meeting').map(definition => ({ definition })) } })
    if (path === '/api/records-ai/plugins') return json(200, { data: { plugins: [] } })
    if (path === `/api/records-ai/minutes/${MEETING}/text`) {
      return json(200, { data: {
        recordId: MEETING, version: record.version, header: '【ここから】', text: '本文', footer: '【ここまで】', truncated: false, docVersion: 'notes:1',
        meeting: { title: 'A社 商談', at: null }, folder: '営業部', attendees: [], externalAttendees: 1,
        bundle: { id: 'deal-aaaaaa01', type: 'deal', typeLabel: '案件', title: '研修導入', state: null, fields: {}, version: 3 }, candidates: [], instructionLike: [],
      } })
    }
    if (path === `/api/records-ai/item/${MEETING}/actions/finish_reading`) {
      if (body.expectedVersion !== record.version) return json(409, { error: 'ほかの人が先に変えました', code: 'VERSION_CONFLICT', version: record.version })
      Object.assign(record, { state: 'read', version: record.version + 1 })
      return json(200, { data: { record } })
    }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof globalThis.fetch
  const access = await createRecordsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch }).openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
  const tools = (await createRecordTools(access!))!
  // The step has no records_get: what the AI reads must carry the version.
  assert.ok(!aiTurnStepAllowsRecordTool('minutes-reading', 'records_get'))
  const read = await tools.execute('minutes_read', { id: MEETING })
  const told = JSON.parse(read.slice(read.lastIndexOf('\n{'))) as { version?: unknown }
  assert.equal(told.version, 7)
  // A guess (the first run's version) is refused with the version now, so one retry finishes.
  const refused = JSON.parse(await tools.execute('meeting__finish_reading', { id: MEETING, expectedVersion: 2, summary_text: '要約' })) as { code?: string; version?: unknown }
  assert.deepEqual([refused.code, refused.version], ['VERSION_CONFLICT', 7])
  await tools.execute('meeting__finish_reading', { id: MEETING, expectedVersion: told.version, summary_text: '要約' })
  assert.deepEqual(record, { state: 'read', version: 8 })
})

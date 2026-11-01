// An unattended 「AI の番」 run gets ONLY its step's tools (owner decision 2026-11-01, ai-turns.md):
// none of the member's own settings, MCP servers, hooks or plugins; Claude Code's built-in shell,
// web and file-write tools denied; only the record tools the step declares. Normal turns unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { claudeCode } from 'ai-sdk-provider-claude-code'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createCodexConnection } from '../electron/agents/codex'
import { AI_TURN_STEPS, aiTurnStepAllowsRecordTool } from '../shared/ai-turns'
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
    ...(unattended ? { unattended: { builtinTools: AI_TURN_STEPS['minutes-reading'].builtinTools } } : {}),
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
    'decisions_record', 'mail_draft_create', 'mail_draft_update', 'mail_draft_show', 'mail_recipients', 'corporate-sales__update_deal', 'corporate-sales__log_meeting']) {
    assert.ok(aiTurnStepAllowsRecordTool('minutes-reading', name), name)
  }
  for (const name of ['records_query', 'records_link_file', 'records_my_turn', 'approvals_list', 'task__complete', '__update_deal', 'corporate-sales__create_deal', 'minutes__start_reading', 'meeting__skip']) {
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

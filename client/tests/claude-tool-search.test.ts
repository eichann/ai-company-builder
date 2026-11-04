/**
 * Claude Code's tool search must never hide the app's own tools (records.md "Tool search").
 *
 * Incident (2026-11-03): the member asked the AI to add a やること; the record tools were
 * deferred behind ToolSearch, a keyword search returned only the first five matches (the
 * read look-ups) and the AI answered that records_create was not provided.
 *
 * Guards:
 * - every app MCP server's tools are always loaded (records_create, the look-ups, the task's
 *   actions, review, company files, web research, consultations, second opinion);
 * - only other types' state changes load on demand, and the record server's instructions name
 *   each of them exactly, for `select:`, and tell the AI to try before saying a tool is missing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { claudeCode } from 'ai-sdk-provider-claude-code'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools, recordToolId } from '../electron/records/tools'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { createAppCommandTools } from '../electron/app-commands/tools'

const TYPES = coreTypeDefinitions()
const ALWAYS_LOAD = 'anthropic/alwaysLoad'

const claudeConfig: ClaudeConnectionConfig = {
  getPermissionMode: () => 'default',
  isClaudeCodeAuthenticated: () => true,
  getClaudeCodeCliPath: () => '/test/claude',
  getShellEnv: () => ({ PATH: '/test' }),
}

async function actRecordTools() {
  const fetch = (async (url: string) => {
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: 'acb_rec_co.' + 'a'.repeat(64), tokenId: 'tok-1', scope: 'act', expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: TYPES.map(definition => ({ definition, source: 'core', versions: [1] })) })
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch })
  return (await createRecordTools((await api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!))!
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listed(server: any) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientSide)
  try {
    const { tools } = await client.listTools()
    return { instructions: client.getInstructions() ?? '', loaded: new Map(tools.map(t => [t.name, t._meta?.[ALWAYS_LOAD] === true])) }
  } finally {
    await client.close()
  }
}

test('Claude Code: the app\'s tools are never hidden behind tool search; other types\' actions load on demand by their exact names', async () => {
  const records = await actRecordTools()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const text = async () => '{}'
  createClaudeConnection(claudeConfig, factory).createChatModel({
    workingDirectory: '/Users/m/会社',
    references: { execute: text },
    companyFiles: { execute: text },
    review: { execute: text },
    appCommands: createAppCommandTools(async () => ({ ok: true, result: {} })),
    webResearch: { execute: text },
    secondOpinion: { tools: [{ name: 'ask_codex', id: 'mcp__acb_second_opinion__ask_codex', description: 'x', target: 'codex' }], execute: text } as never,
    records,
  })

  const { instructions, loaded } = await listed(options.mcpServers.acb_records)
  // What the incident hid: making a やること, the look-ups and the task's own actions.
  for (const name of ['records_create', 'records_query', 'records_get', 'records_link_file', ...Object.keys(TYPES.find(t => t.name === 'task')!.actions).map(a => `task__${a}`)]) {
    assert.equal(loaded.get(name), true, name)
  }
  const onDemand = records.specs.filter(s => s.onDemand).map(s => s.name)
  assert.ok(onDemand.length > 0 && onDemand.every(name => !name.startsWith('task__') && name.includes('__')), onDemand.join())
  for (const name of onDemand) {
    assert.equal(loaded.get(name), false, name)
    assert.ok(instructions.includes(recordToolId(name)), `instructions name ${name}`)
  }
  assert.match(instructions, /select:/)
  assert.match(instructions, /用意されていない/)

  // The app's commands handed to the AI (tabs_list / tabs_tidy / tabs_restore) too: never asked, always there.
  for (const id of ['mcp__acb_app__tabs_list', 'mcp__acb_app__tabs_tidy', 'mcp__acb_app__tabs_restore']) assert.ok(options.allowedTools.includes(id), id)
  for (const server of ['acb_consultations', 'acb_company_files', 'acb_review', 'acb_app', 'acb_web', 'acb_second_opinion']) {
    assert.ok(options.mcpServers[server], server)
    const tools = (await listed(options.mcpServers[server])).loaded
    assert.ok(tools.size > 0 && [...tools.values()].every(Boolean), server)
  }
})

test('a record tool given without on-demand marking is always loaded (connectors\' tools, plugin operations)', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  const spec = (name: string) => ({ name, description: name, schema: z.object({}), readOnly: false, display: { label: name } as never })
  createClaudeConnection(claudeConfig, factory).createChatModel({
    workingDirectory: '/Users/m/会社',
    records: { specs: [spec('drive_put'), spec('corporate-sales__update_deal')], execute: async () => '{}', close: async () => {}, instructions: '' },
  })
  const { loaded } = await listed(options.mcpServers.acb_records)
  assert.deepEqual([...loaded.entries()], [['drive_put', true], ['corporate-sales__update_deal', true]])
})

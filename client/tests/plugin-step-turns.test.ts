// A business plugin's step run as 「AI の番」 (plan C5, plugin-steps.md), the app's part: main
// claims the server's run of `<pluginId>__<step>`, reads the pinned procedure on this PC (the
// package C2 keeps, or the company Skill at the pinned tree), makes the first message from it and
// holds the step's tool ceiling for that consultation only; the record leaving the step's state is
// done. A fake company server answers the turns, the claim (with the pin), the step on the record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { createAiTurnClaims, type AiTurnClaimsDeps } from '../electron/features/ai-turns/claims'
import { createProcedureReader } from '../electron/features/ai-turns/procedures'
import { createRecordsApi } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'
import { parsePluginStepTurns, pluginStepToolAccess, type PluginProcedurePin } from '../shared/ai-turn-steps/plugin'

const COMPANY = 'acme'
const DEAL = 'deal-0a1b2c3d4e5f'
const FP = 'a'.repeat(64)
const TREE = 'b'.repeat(40)
const PLUGIN_PIN = { source: 'plugin', pluginId: 'sample-sales', version: '0.1.0', fingerprint: FP }

function fakeServer(opts: { pin?: unknown; tools?: string[] } = {}) {
  const record = { id: DEAL, type: 'deal', state: 'open', version: 4 }
  const calls: string[] = []
  const finished: unknown[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    calls.push(`${method} ${url.pathname}${method === 'POST' && body.step ? ` ${body.step}` : ''}`)
    const base = `/api/companies/${COMPANY}`
    if (url.pathname === `${base}/me/plugin-step-turns`) {
      return json(200, { data: { turns: [
        { recordId: DEAL, version: 4, pluginId: 'sample-sales', step: 'work', label: '案件を進める', start: 'ai_turn', tools: [], connectorRoles: [] },
        { recordId: 'deal-zzzzzzzz', version: 1, pluginId: 'Bad_Id', step: 'work', label: 'x', start: 'ai_turn' },
      ] } })
    }
    if (url.pathname === `${base}/ai-run-claims` && method === 'POST') {
      return json(201, { data: { run: { id: 'run-p1', generation: 1, procedure: { step: body.step, app: null, plugins: [], pin: opts.pin ?? PLUGIN_PIN } } } })
    }
    if (url.pathname === `${base}/me/plugin-steps/records/${DEAL}`) {
      return json(200, { data: { steps: [{
        pluginId: 'sample-sales', step: 'work', label: '案件を進める', start: 'ai_turn', procedure: 'steps/work.md',
        tools: opts.tools ?? ['records', 'plugin_operations'], connectorRoles: [], pin: opts.pin ?? PLUGIN_PIN,
      }] } })
    }
    if (url.pathname === `${base}/records/item/${DEAL}`) return json(200, { data: { record } })
    if (url.pathname === `${base}/ai-runs/run-p1/finish` && method === 'POST') { finished.push(body); return json(200, { data: {} }) }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { record, calls, finished, fetch }
}

function claimsFor(server: ReturnType<typeof fakeServer>, over: Partial<AiTurnClaimsDeps> = {}) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  return createAiTurnClaims({
    ...base, records: createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf }), runs, deviceId: 'device-plugin-1',
    renewEveryMs: 3_600_000, fetch: server.fetch, agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true,
    log: { warn: () => {} },
    readProcedure: async (_c, pin) => pin.source === 'plugin' ? `# 案件を進める ${pin.version}\n手順の本文` : '# 会社の手順\n',
    ...over,
  })
}

test('the turns: only well-formed plugin steps are listed; the claim runs <pluginId>__<step> with the pinned procedure', async () => {
  const server = fakeServer()
  const claims = claimsFor(server)
  const turns = await claims.pluginTurns(COMPANY)
  assert.deepEqual(turns.map(t => t.runStep), ['sample-sales__work'])
  const result = await claims.claim(COMPANY, DEAL, 4, 'conv-plugin-0001')
  assert.equal(result.claimed, true)
  assert.ok(result.claimed && result.message?.includes('手順の本文') && result.message.includes('0.1.0'), 'the first message carries the pinned version\'s procedure')
  assert.ok(server.calls.includes(`POST /api/companies/${COMPANY}/ai-run-claims sample-sales__work`))
  // No type action is run as a claim: the server's run is the claim.
  assert.equal(server.calls.filter(c => c.includes('/actions/')).length, 0)
})

test("the step's tools are the consultation's ceiling, for that consultation and step only", async () => {
  const server = fakeServer({ tools: ['records'] })
  const claims = claimsFor(server)
  await claims.pluginTurns(COMPANY)
  assert.equal((await claims.claim(COMPANY, DEAL, 4, 'conv-plugin-0002')).claimed, true)
  const ceiling = claims.pluginStepTools('conv-plugin-0002', 'sample-sales__work')
  assert.ok(ceiling)
  assert.equal(ceiling.allowsRecordTool('records_get'), true)
  assert.equal(ceiling.allowsRecordTool('deal__win'), true)
  // `records` only: no plugin operations (the server's pinned step narrowed them), no mail, no other type.
  assert.equal(ceiling.allowsRecordTool('sample-sales__update_deal'), false)
  assert.equal(ceiling.allowsRecordTool('mail_draft_create'), false)
  assert.equal(ceiling.allowsRecordTool('meeting__start_reading'), false)
  assert.deepEqual(ceiling.builtinTools, [])
  assert.equal(claims.pluginStepTools('conv-other-00001', 'sample-sales__work'), null)
  assert.equal(claims.pluginStepTools('conv-plugin-0002', 'sample-sales__other'), null)
})

test('the tool ceiling maps each declared tool and nothing else', () => {
  const all = pluginStepToolAccess({ pluginId: 'sample-sales', tools: ['plugin_operations', 'outbound_draft', 'files_read'] }, 'deal')
  assert.equal(all.allowsRecordTool('sample-sales__update_deal'), true)
  assert.equal(all.allowsRecordTool('other-plugin__update_deal'), false)
  assert.equal(all.allowsRecordTool('mail_draft_create'), true)
  assert.equal(all.allowsRecordTool('records_get'), false)
  assert.equal(all.allowsRecordTool('deal__win'), false)
  assert.deepEqual(all.builtinTools, ['Read', 'Glob', 'Grep'])
  assert.equal(parsePluginStepTurns({ turns: 'x' }), null)
})

test('a procedure not on this PC gives the run back for later; nothing is sent to the AI', async () => {
  const server = fakeServer()
  const claims = claimsFor(server, { readProcedure: async () => null })
  await claims.pluginTurns(COMPANY)
  assert.deepEqual(await claims.claim(COMPANY, DEAL, 4, 'conv-plugin-0003'), { claimed: false, reason: 'unavailable' })
  assert.deepEqual(server.finished, [{ generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'PROCEDURE_NOT_HERE' } }])
  assert.equal(claims.pluginStepTools('conv-plugin-0003', 'sample-sales__work'), null)
})

test('the emergency stop: no server call at all', async () => {
  const server = fakeServer()
  const claims = claimsFor(server, { aiAllowed: () => false })
  await claims.pluginTurns(COMPANY)
  const before = server.calls.length
  assert.deepEqual(await claims.claim(COMPANY, DEAL, 4, 'conv-plugin-0004'), { claimed: false, reason: 'not-allowed' })
  assert.equal(server.calls.length, before)
})

test('settle: the record left the step\'s state → done; still there → tried again later', async () => {
  for (const moved of [true, false]) {
    const server = fakeServer()
    const claims = claimsFor(server)
    await claims.pluginTurns(COMPANY)
    await claims.claim(COMPANY, DEAL, 4, `conv-plugin-000${moved ? 5 : 6}`)
    if (moved) server.record.state = 'won'
    const settled = await claims.settle(COMPANY, DEAL)
    assert.equal(settled.outcome, moved ? 'done' : 'put-back')
    assert.deepEqual(server.finished, [moved ? { generation: 1, outcome: 'done' } : { generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } }])
  }
})

test('the procedure on this PC: the pinned package file only inside its folder; a company Skill from the pinned tree', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acb-procedures-'))
  try {
    const folder = path.join(dir, 'sample-sales@0.1.0')
    mkdirSync(path.join(folder, 'steps'), { recursive: true })
    writeFileSync(path.join(folder, 'steps', 'work.md'), '# 0.1.0 の手順\n')
    writeFileSync(path.join(dir, 'secret.md'), 'outside')
    const gitCalls: string[][] = []
    const read = createProcedureReader({
      folderOf: (c, id, v) => (c === COMPANY && id === 'sample-sales' && v === '0.1.0' ? folder : null),
      git: async (_root, args) => { gitCalls.push(args); return '# 会社の手順（固定した版）\n' },
    })
    const pin = PLUGIN_PIN as PluginProcedurePin
    assert.equal(await read(COMPANY, pin, 'steps/work.md', null), '# 0.1.0 の手順\n')
    assert.equal(await read(COMPANY, pin, 'steps/../../secret.md', null), null)
    assert.equal(await read(COMPANY, pin, '../secret.md', null), null)
    // Another version (not the pinned one listed for this company) is not here.
    assert.equal(await read(COMPANY, { ...pin, version: '0.2.0' } as PluginProcedurePin, 'steps/work.md', null), null)
    const skill: PluginProcedurePin = { source: 'company_skill', skill: 'deal-proposal', fingerprint: TREE }
    assert.equal(await read(COMPANY, skill, 'steps/work.md', '/company'), '# 会社の手順（固定した版）\n')
    assert.deepEqual(gitCalls, [['cat-file', 'blob', `${TREE}:SKILL.md`]])
    assert.equal(await read(COMPANY, skill, 'steps/work.md', null), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the chat server refuses a plugin step whose ceiling main does not hold (never runs it unrestricted)', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  const asked: string[] = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    pluginStepTools: (conversationId, step) => { asked.push(`${conversationId} ${step}`); return null },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', appSessionId: 'conv-plugin-0009', aiTurnStep: 'sample-sales__work' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json() as { code: string }).code, 'AI_TURN_NOT_SUPPORTED')
    assert.deepEqual(asked, ['conv-plugin-0009 sample-sales__work'])
  } finally {
    server.server.close()
  }
})

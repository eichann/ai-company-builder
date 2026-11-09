// A business plugin's `start: person` step the company starts by itself (「自動で始める」,
// plugin-steps.md "Starting by itself"), the app's part: only a turn the server marks `auto` is
// queued (an older app leaves it alone), the run gets no tool that reaches outside, holds its
// deliverable folder for the write guard, and is done only when it handed over what it made (a
// やること linked to the record) — the record itself stays at the step's state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiTurnClaims } from '../electron/features/ai-turns/claims'
import { createRecordsApi } from '../electron/records/api'
import { createRunRegistry } from '../electron/records/runs'
import { createStepWriteAreas } from '../electron/features/plugin-steps/write-areas'
import { parsePluginStepTurns } from '../shared/ai-turn-steps/plugin'

const COMPANY = 'acme'
const DEAL = 'deal-0a1b2c3d4e5f'
const PIN = { source: 'company_skill', skill: 'sales-proposal-v1', fingerprint: 'b'.repeat(40) }
const CLAIMED_AT = '2026-11-06T10:00:00.000Z'
const turn = (over: Record<string, unknown> = {}) => ({
  recordId: DEAL, version: 4, pluginId: 'corporate-sales', step: 'prepare_proposal', label: '提案書を用意する', start: 'person', auto: true,
  procedure: 'steps/proposal.md', tools: ['records', 'files_write'], connectorRoles: [], deliverableFolder: '提案書', ...over,
})

function fakeServer(opts: { tasks?: Array<{ id: string; updatedAt: string; fields: Record<string, string> }> } = {}) {
  const finished: unknown[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const base = `/api/companies/${COMPANY}`
    if (url.pathname === `${base}/me/plugin-step-turns`) return json(200, { data: { turns: [turn()] } })
    if (url.pathname === `${base}/ai-run-claims` && method === 'POST') {
      return json(201, { data: { run: { id: 'run-a1', generation: 1, updatedAt: CLAIMED_AT, procedure: { step: body.step, app: null, plugins: [], pin: PIN } } } })
    }
    if (url.pathname === `${base}/me/plugin-steps/records/${DEAL}`) {
      // The step as declared: a person's, with a tool that reaches outside.
      return json(200, { data: { steps: [{ ...turn(), tools: ['records', 'files_write', 'web_research', 'outbound_draft'], pin: PIN }] } })
    }
    if (url.pathname === `${base}/records/item/${DEAL}`) return json(200, { data: { record: { id: DEAL, type: 'deal', state: 'open', version: 4, title: 'A社 案件' } } })
    if (url.pathname === `${base}/records/query` && method === 'POST') {
      const linked = body.type === 'task' && body.link?.name === 'bundle' && body.link?.id === DEAL
      return json(200, { data: { total: 0, records: linked ? opts.tasks ?? [] : [] } })
    }
    if (url.pathname === `${base}/ai-runs/run-a1/finish` && method === 'POST') { finished.push(body); return json(200, { data: {} }) }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  return { finished, fetch }
}

function claimsFor(server: ReturnType<typeof fakeServer>) {
  const base = { baseUrl: () => 'https://acb.example', cookies: () => ['s=1'] }
  const runs = createRunRegistry()
  return createAiTurnClaims({
    ...base, records: createRecordsApi({ ...base, fetch: server.fetch, runOf: runs.runOf }), runs, deviceId: 'device-auto-1',
    renewEveryMs: 3_600_000, fetch: server.fetch, agent: () => 'claude-code', windowOpen: () => true, aiAllowed: () => true, stopPolicyConfirmed: async () => true,
    log: { warn: () => {} }, readProcedure: async () => '# 提案書（会社の手順）\n',
  })
}

test('only a person\'s step the server marks as started by itself is queued (the button stays a button)', () => {
  const parsed = parsePluginStepTurns({ turns: [turn(), turn({ recordId: 'deal-111111', auto: undefined }), turn({ recordId: 'deal-222222', auto: 'yes' })] })
  assert.deepEqual(parsed?.map(t => [t.recordId, t.auto, t.deliverableFolder]), [[DEAL, true, '提案書']])
  // An older server sends no folder: the core's default from the step's label.
  assert.equal(parsePluginStepTurns({ turns: [turn({ deliverableFolder: undefined })] })?.[0].deliverableFolder, '提案書を用意する')
  assert.equal(parsePluginStepTurns({ turns: [turn({ deliverableFolder: '../x' })] })?.[0].deliverableFolder, '提案書を用意する')
})

test('run by itself: no tool that reaches outside, its writes held to the deliverable folder, told how to hand over', async () => {
  const server = fakeServer()
  const claims = claimsFor(server)
  await claims.pluginTurns(COMPANY)
  const result = await claims.claim(COMPANY, DEAL, 4, 'conv-auto-00001')
  assert.equal(result.claimed, true)
  const ceiling = claims.pluginStepTools('conv-auto-00001', 'corporate-sales__prepare_proposal')
  assert.ok(ceiling)
  assert.equal(ceiling.builtinTools.includes('WebSearch') || ceiling.builtinTools.includes('WebFetch'), false)
  assert.ok(ceiling.builtinTools.includes('Write'))
  assert.equal(ceiling.allowsRecordTool('mail_draft_create'), true)
  assert.equal(claims.pluginStepWriteArea('conv-auto-00001'), '提案書')
  assert.equal(claims.pluginStepWriteArea('conv-other-0001'), null)
  assert.ok(result.claimed && result.message?.includes('.personal/提案書/') && result.message.includes('links.prepared') && result.message.includes('prep_summary'))
})

test('settle: done only when a やること for the record came after the claim; otherwise tried again later', async () => {
  for (const [tasks, outcome] of [
    [[{ id: 'task-new', updatedAt: '2026-11-06T10:05:00.000Z', fields: { prep_summary: '・確かめる点' } }], 'done'],
    [[{ id: 'task-bare', updatedAt: '2026-11-06T10:05:00.000Z', fields: {} }], 'put-back'],
    [[{ id: 'task-old', updatedAt: '2026-11-01T09:00:00.000Z', fields: { prep_summary: '・前の' } }], 'put-back'],
    [[], 'put-back'],
  ] as const) {
    const server = fakeServer({ tasks: [...tasks] })
    const claims = claimsFor(server)
    await claims.pluginTurns(COMPANY)
    await claims.claim(COMPANY, DEAL, 4, 'conv-auto-00002')
    const settled = await claims.settle(COMPANY, DEAL)
    assert.equal(settled.outcome, outcome)
    assert.deepEqual(server.finished, [outcome === 'done' ? { generation: 1, outcome: 'done' } : { generation: 1, outcome: 'failed', failure: { class: 'temporary', code: 'UNFINISHED' } }])
  }
})

test('a person\'s consultation of a step: its folder is asked of the server once and kept; unknown is not kept', async () => {
  let asked = 0
  let online = true
  const fetch = (async (input: RequestInfo | URL) => {
    asked += 1
    if (!online) throw new Error('offline')
    const id = String(input).split('/').pop()
    const step = id === 'conv-person-0001' ? { recordId: DEAL, pluginId: 'corporate-sales', step: 'prepare_proposal', deliverableFolder: '提案書' } : null
    return new Response(JSON.stringify({ data: { step } }), { status: 200 })
  }) as typeof globalThis.fetch
  const areas = createStepWriteAreas({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], automatic: c => c === 'conv-auto-00009' ? '見積' : null, fetch })
  assert.equal(await areas.areaOf(COMPANY, 'conv-auto-00009'), '見積')
  assert.equal(asked, 0)
  assert.equal(await areas.areaOf(COMPANY, 'conv-person-0001'), '提案書')
  assert.equal(await areas.areaOf(COMPANY, 'conv-person-0001'), '提案書')
  assert.equal(await areas.areaOf(COMPANY, 'conv-plain-00001'), null)
  assert.equal(asked, 2)
  online = false
  assert.equal(await areas.areaOf(COMPANY, 'conv-person-0002'), null)
  online = true
  assert.equal(await areas.areaOf(COMPANY, 'conv-person-0001'), '提案書')
  assert.equal(asked, 3)
})

test('the chat server never runs a business plugin step\'s turn without its deliverable folder held', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    pluginStepTools: () => ({ allowsRecordTool: () => true, builtinTools: ['Write'] }),
    stepWriteArea: async () => null,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', appSessionId: 'conv-auto-00010', aiTurnStep: 'corporate-sales__prepare_proposal' }),
    })
    assert.equal(res.status, 400)
    assert.equal((await res.json() as { code: string }).code, 'AI_TURN_NOT_SUPPORTED')
  } finally {
    server.server.close()
  }
})

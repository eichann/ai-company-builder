// Option B (owner decision 2026-11-06, plugin-steps.md "続きをする"): an automatic run of a person's
// step only prepares — the core's first message says it has no shell and must leave scripts / the
// PDF to the person — and 「続きをする」 finishes it as the person's own consultation of the same step
// on the same record: started through the person's start (pinned, bound on its first turn, the
// step's deliverable folder held), told what the automatic run left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerPluginStepsIpc } from '../electron/features/plugin-steps/ipc'
import type { IpcRegistrar } from '../electron/ipc/registrar'
import { AUTOMATIC_NO_SHELL_RULE, CONTINUE_LABEL, PREPARE_ONLY_RULE, parsePluginStepContinuation, pluginStepFirstMessage, type PluginStepContinueResult } from '../shared/ai-turn-steps/plugin'

const COMPANY = 'acme'
const DEAL = 'deal-0a1b2c3d4e5f'
const TASK = 'task-0f1e2d3c4b5a'
const PIN = { source: 'company_skill', skill: 'sales-proposal-v1', fingerprint: 'b'.repeat(40) }

test('an automatic run is told by the core: no shell, prepare only, and a 確かめる点 that the rest is 「続きをする」', () => {
  const base = { label: '提案書を用意する', recordId: DEAL, version: 4, procedure: '# 提案書\nscripts/build_pdf.sh を実行する', source: 'company_skill' as const, deliverableFolder: '提案書' }
  const auto = pluginStepFirstMessage({ ...base, auto: true })
  assert.ok(auto.includes(AUTOMATIC_NO_SHELL_RULE), 'no shell')
  assert.ok(auto.includes(PREPARE_ONLY_RULE), 'prepare only')
  assert.match(PREPARE_ONLY_RULE, /確かめる点/)
  assert.ok(PREPARE_ONLY_RULE.includes(`「${CONTINUE_LABEL}」`))
  assert.match(PREPARE_ONLY_RULE, /HTML/)
  // The procedure (the company's Skill) is passed on as it is: the core adds, it does not rewrite.
  assert.ok(auto.includes('scripts/build_pdf.sh を実行する'))
  // A step that starts as an AI turn: no shell either, but nothing for a person to continue.
  const aiTurn = pluginStepFirstMessage(base)
  assert.ok(aiTurn.includes(AUTOMATIC_NO_SHELL_RULE))
  assert.ok(!aiTurn.includes(PREPARE_ONLY_RULE))
})

test('the continuation is read strictly', () => {
  const good = { continuation: { recordId: DEAL, pluginId: 'corporate-sales', step: 'prepare_proposal', label: '提案書を用意する', taskId: TASK } }
  assert.deepEqual(parsePluginStepContinuation(good), good.continuation)
  assert.equal(parsePluginStepContinuation({ steps: [] }), null)
  assert.equal(parsePluginStepContinuation({ continuation: null }), null)
  assert.equal(parsePluginStepContinuation({ continuation: { ...good.continuation, pluginId: 'Bad_Id' } }), null)
  assert.equal(parsePluginStepContinuation({ continuation: { ...good.continuation, taskId: '../x' } }), null)
})

function continueIpc(opts: { continuation: unknown }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } } as unknown as IpcRegistrar
  const calls: string[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const base = `/api/companies/${COMPANY}`
    if (url.pathname === `${base}/me/plugin-steps/records/${TASK}` || url.pathname === `${base}/me/plugin-steps/records/${DEAL}`) {
      return json(200, { data: { steps: [], continuation: opts.continuation } })
    }
    if (url.pathname === `${base}/me/plugin-steps/records/${DEAL}/corporate-sales/prepare_proposal/start`) {
      return json(200, { data: { recordId: DEAL, version: 5, pluginId: 'corporate-sales', step: 'prepare_proposal', label: '提案書を用意する', start: 'person', procedure: 'steps/proposal.md', tools: [], connectorRoles: [], pin: PIN, deliverableFolder: '提案書' } })
    }
    if (url.pathname === `${base}/records/item/${TASK}`) {
      return json(200, { data: { record: { id: TASK, type: 'task', state: 'todo', title: '提案書を用意する：A社', summary: '', fields: { prep_summary: '・予算の上限\n・残り（PDF にすること）は「続きをする」で一緒に仕上げます' }, version: 2, updatedAt: '2026-11-06T10:00:00Z' }, links: [
        { direction: 'out', name: 'prepared', record: { id: 'outbound_message-1a2b', type: 'outbound_message', state: 'draft', title: '提案書をお送りします', summary: '', fields: {}, version: 1, updatedAt: '2026-11-06T10:00:00Z' } },
        { direction: 'out', name: 'files', path: '営業部/.personal/提案書/2026-11-06_A社/proposal.html' },
      ] } })
    }
    return json(404, { code: 'NOT_FOUND' })
  }) as typeof fetch
  registerPluginStepsIpc(ipc, {
    baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch, readProcedure: async () => '# 会社の提案書の手順\nscripts/build_pdf.sh',
    paths: { validate: (p: string) => { if (!p.startsWith('/company')) throw new Error('outside'); return p }, add: () => {}, rootOf: () => null },
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { id: 1 } }, ...args)
  return { calls, invoke }
}

test('「続きをする」 from the やること: the person\'s start of the same step on the deal, bound to it, with what the run left', async () => {
  const c = { recordId: DEAL, pluginId: 'corporate-sales', step: 'prepare_proposal', label: '提案書を用意する', taskId: TASK }
  const ipc = continueIpc({ continuation: c })
  assert.deepEqual(await ipc.invoke('pluginSteps:continuation', COMPANY, TASK), c)
  const r = await ipc.invoke('pluginSteps:continue', COMPANY, TASK, '/company') as PluginStepContinueResult
  assert.ok(r.ok, JSON.stringify(r))
  // The chat binds the consultation to this step on its first turn (and so holds its deliverable folder).
  assert.deepEqual(r.pluginStep, { recordId: DEAL, pluginId: 'corporate-sales', step: 'prepare_proposal' })
  assert.ok(ipc.calls.includes(`POST /api/companies/${COMPANY}/me/plugin-steps/records/${DEAL}/corporate-sales/prepare_proposal/start`))
  assert.ok(r.message.includes('.personal/提案書/'), 'the folder')
  assert.ok(r.message.includes('proposal.html') && r.message.includes('予算の上限') && r.message.includes('outbound_message-1a2b'), 'what the run left')
  assert.ok(r.message.includes('scripts/build_pdf.sh'), 'the pinned procedure, scripts and all')
})

test('no 「続きをする」 where no automatic run prepared anything: nothing offered, nothing started', async () => {
  const ipc = continueIpc({ continuation: null })
  assert.equal(await ipc.invoke('pluginSteps:continuation', COMPANY, DEAL), null)
  const r = await ipc.invoke('pluginSteps:continue', COMPANY, DEAL, '/company') as PluginStepContinueResult
  assert.equal(r.ok, false)
  assert.equal(ipc.calls.filter(x => x.startsWith('POST')).length, 0)
  // A company folder outside the allowed roots: refused before anything is pinned.
  const other = continueIpc({ continuation: { recordId: DEAL, pluginId: 'corporate-sales', step: 'prepare_proposal', label: 'x', taskId: TASK } })
  assert.equal((await other.invoke('pluginSteps:continue', COMPANY, DEAL, '/elsewhere') as PluginStepContinueResult).ok, false)
  assert.equal(other.calls.filter(x => x.startsWith('POST')).length, 0)
})

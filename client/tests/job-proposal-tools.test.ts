/**
 * The AI's side of a member's proposal of a time job (jobs.md "Member proposals" "The app (PR C)"):
 * - the two tools are offered only in a consultation the member is in (the chat server's flag), with an act token not bound
 *   to an execution run — never to a job's run, 「AI の番」 or a plugin step;
 * - `job_proposal_create` makes a candidate on the server; the reply gets the app's card holding the id the **server**
 *   answered, and the AI is told nothing was sent;
 * - nothing the AI can reach submits: no tool, no chat-server path, no record token ever names the submit route.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { JOB_PROPOSAL_CREATE_TOOL, JOB_PROPOSAL_PLACES_TOOL } from '../electron/records/job-proposal-tools'
import { readJobProposalCardRef, type JobProposalCardRef } from '../shared/job-proposals'

const TOKEN = 'acb_rec_co.' + 'b'.repeat(64)
const CANDIDATE = 'jc.' + 'a'.repeat(32)
const INPUT = {
  skill: 'minutes-summary', trigger: { every: 'week', weekday: 'mon', at: '09:00', businessDaysBefore: 0 }, check: { kind: 'new_meetings' },
  reads: [], deliverable: '営業/週報', readRecords: false, mailDrafts: false, minutes: 15, missed: { policy: 'skip', expiresAfterMinutes: 60 },
}

async function turn(opts: { scope?: 'read' | 'act'; jobProposals?: boolean; bound?: boolean; candidates?: (body: unknown) => Response } = {}) {
  const seen: Array<{ method: string; url: string; body: unknown }> = []
  const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
  const fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ method: init.method ?? 'GET', url, body })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope: opts.scope ?? 'act', expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, { plugins: [] })
    if (url.includes('/job-proposals-ai/places')) return json(200, { under: '', folders: [{ path: '営業', write: true }] })
    if (url.endsWith('/job-proposals-ai/candidates')) return opts.candidates ? opts.candidates(body) : json(201, { id: CANDIDATE, definition: { name: 'minutes-summary（毎週月曜 09:00）' }, fingerprint: 'sha256:' + 'f'.repeat(64) })
    return json(200, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({
    baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=SECRET'], fetch,
    runOf: () => (opts.bound ? { id: 'run-1', generation: 1 } : null),
  })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: opts.scope ?? 'act' })
  const cards: JobProposalCardRef[] = []
  const tools = (await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1', newId: () => 'card-1', jobProposals: opts.jobProposals ?? true, onJobProposalCard: c => cards.push(c),
  }))!
  return { tools, cards, seen }
}

const names = (t: { specs: Array<{ name: string }> }) => t.specs.map(s => s.name)

test('offered only to a consultation the member is in, with an act token not bound to a run', async () => {
  const offered = await turn()
  assert.ok(names(offered.tools).includes(JOB_PROPOSAL_PLACES_TOOL) && names(offered.tools).includes(JOB_PROPOSAL_CREATE_TOOL))
  assert.match(offered.tools.instructions, /定期の仕事の案/)
  for (const [why, opts] of [['the chat server leaves it off', { jobProposals: false }], ['a read token (Codex)', { scope: 'read' as const }], ['a run-bound token', { bound: true }]] as const) {
    const t = await turn(opts)
    assert.ok(!names(t.tools).some(n => n.startsWith('job_proposal')), why)
    assert.doesNotMatch(t.tools.instructions, /定期の仕事の案/, why)
    assert.match(JSON.parse(await t.tools.execute(JOB_PROPOSAL_CREATE_TOOL, INPUT)).error, /道具はありません/, why)
  }
})

test('a candidate: the server builds it, the card holds the id the server answered, the AI is told nothing was sent', async () => {
  const { tools, cards, seen } = await turn()
  const out = JSON.parse(await tools.execute(JOB_PROPOSAL_CREATE_TOOL, INPUT))
  const post = seen.find(s => s.url.endsWith('/api/records-ai/job-proposals-ai/candidates'))
  assert.equal(post?.method, 'POST')
  assert.deepEqual(post?.body, INPUT)
  assert.equal(cards.length, 1)
  assert.deepEqual(readJobProposalCardRef(JSON.parse(JSON.stringify(cards[0]))), cards[0])
  assert.equal(cards[0].candidateId, CANDIDATE)
  assert.equal(out.shown, true)
  assert.match(out.instruction, /Nothing was sent/)
  // A malformed answer (no candidate id) makes no card.
  const odd = await turn({ candidates: () => new Response(JSON.stringify({ success: true, data: { id: 'not-a-candidate' } }), { status: 201 }) })
  assert.ok(JSON.parse(await odd.tools.execute(JOB_PROPOSAL_CREATE_TOOL, INPUT)).error)
  assert.equal(odd.cards.length, 0)
})

test('a server without member proposals: the AI is told so, and no card is made', async () => {
  const notFound = () => new Response(JSON.stringify({ success: false, error: 'Not Found' }), { status: 404 })
  const { tools, cards } = await turn({ candidates: notFound })
  assert.equal(JSON.parse(await tools.execute(JOB_PROPOSAL_CREATE_TOOL, INPUT)).code, 'JOB_PROPOSALS_NOT_SUPPORTED')
  assert.equal(cards.length, 0)
  // A refusal with its own code is passed on as the server said it (the server's sentences are plain Japanese and name nothing).
  const refused = await turn({ candidates: () => new Response(JSON.stringify({ success: false, code: 'JOB_SKILL_MISSING', error: '先に Skill を作ってから' }), { status: 409 }) })
  assert.equal(JSON.parse(await refused.tools.execute(JOB_PROPOSAL_CREATE_TOOL, INPUT)).code, 'JOB_SKILL_MISSING')
})

test('the places: the record-token route only, with `under` encoded', async () => {
  const { tools, seen } = await turn()
  await tools.execute(JOB_PROPOSAL_PLACES_TOOL, { under: '営業/議事録' })
  assert.ok(seen.some(s => s.method === 'GET' && s.url === `https://acb.example.jp/api/records-ai/job-proposals-ai/places?under=${encodeURIComponent('営業/議事録')}`))
})

const here = path.dirname(fileURLToPath(import.meta.url))
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : []
  })
}

test('nothing the AI reaches submits: only the session IPC names the submit route, only the card calls it', () => {
  const electron = filesUnder(path.join(here, '../electron'))
  const naming = electron.filter(f => /job-candidates\/[^'"`]*\/submit|\/submit['"`]/.test(readFileSync(f, 'utf8')) && readFileSync(f, 'utf8').includes('job-candidates'))
  assert.deepEqual(naming.map(f => path.relative(path.join(here, '..'), f)), ['electron/features/jobs/proposals.ts'])
  // The submit IPC is registered by that module alone, never by the chat server or the record tools.
  const registering = electron.filter(f => readFileSync(f, 'utf8').includes("'jobProposals:submit'"))
  assert.deepEqual(registering.map(f => path.relative(path.join(here, '..'), f)), ['electron/features/jobs/proposals.ts', 'electron/preload.ts'])
  // In the renderer only the chat card's data layer and the card call it.
  const renderer = filesUnder(path.join(here, '../src')).filter(f => /submitJobProposal\(/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(renderer.map(f => path.relative(path.join(here, '..'), f)).sort(), ['src/features/chat/api.ts', 'src/features/chat/components/JobProposalCard.tsx'])
  // 「やめる」 likewise: the session module alone names its route, only the card calls it.
  assert.deepEqual(electron.filter(f => /\/discard[`'"]/.test(readFileSync(f, 'utf8')) && readFileSync(f, 'utf8').includes('job-candidates')).map(f => path.relative(path.join(here, '..'), f)), ['electron/features/jobs/proposals.ts'])
  assert.deepEqual(filesUnder(path.join(here, '../src')).filter(f => /discardJobCandidate\(/.test(readFileSync(f, 'utf8'))).map(f => path.relative(path.join(here, '..'), f)).sort(), ['src/features/chat/api.ts', 'src/features/chat/components/JobProposalCard.tsx'])
})

async function chatTurn(body: Record<string, unknown>, extra: Record<string, unknown> = {}, guard = true) {
  const { startChatServer } = await import('../electron/chat-server')
  const asked: Array<boolean | undefined> = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    ...(guard ? { getWriteGuard: () => ({ root: os.tmpdir(), getAccess: () => undefined }) } : {}),
    createRecordTools: async request => { asked.push(request.jobProposals); return null },
    ...extra,
  })
  const abort = new AbortController()
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', companyRootPath: os.tmpdir(), ...body }),
    })
    await res.text().catch(() => '')
  } catch { /* the turn itself is not what is tested */ } finally {
    abort.abort()
    server.server.close()
  }
  return asked
}

test('the chat server offers them to an ordinary consultation only — never a job run or a step', async () => {
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-plain-0001' }), [true])
  const ceiling = { pluginStepTools: () => ({ allowsRecordTool: () => true, builtinTools: [] }), stepWriteArea: async () => ({ nowhere: true, reads: [] }) }
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-job-00001', aiTurnStep: 'job-procedure' }, ceiling), [false])
  // A person step's consultation (bound to the step, its write area set) is never offered them either.
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-step-0001' }, { stepWriteArea: async () => 'sales/.personal/deal-1' }), [false])
  // A built-in 「AI の番」 step (no write area of its own).
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-turn-0001', aiTurnStep: 'minutes-reading' }), [false])
})

test('fails closed: a step lookup that did not answer, or a step consultation without a write guard, gets no tools', async () => {
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-step-0002' }, { stepWriteArea: async () => { throw new Error('timeout') } }), [false])
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-step-0003' }, { stepWriteArea: () => { throw new Error('sync') } }), [false])
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-step-0004' }, { stepWriteArea: async () => 'sales/.personal/deal-1' }, false), [false])
  // An ordinary consultation the lookup answers "none" for still gets them.
  assert.deepEqual(await chatTurn({ appSessionId: 'conv-plain-0002' }, { stepWriteArea: async () => null }), [true])
})

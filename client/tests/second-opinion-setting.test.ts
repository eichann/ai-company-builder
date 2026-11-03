/**
 * 「もう一方の AI に聞く」 as a company setting (owner decision 2026-11-02; chat-and-agents.md
 * "Asking the other AI"). The app enforces it (the other AI runs on this computer). Guards:
 * - a turn gets the tool only when the company allows it; forbidden, unknown or a failing check
 *   = no tool at all (the member named the other AI, so the AI is told it cannot ask);
 * - the company is not asked unless the member named the other AI;
 * - the policy counts as "allowed" only with an explicit `secondOpinion: { allowed: true }`: no
 *   answer (offline), an older server without the field, or a malformed one = not allowed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { secondOpinionTurn } from '../electron/agents/second-opinion'
import { createAgentPolicyStore, parseAgentPolicy, secondOpinionAllowed } from '../electron/services/agent-policy-store'
import { secondOpinionForbiddenInstructions } from '../shared/agents/second-opinion'

const quiet = { warn: () => {} }
const sandbox = { mode: 'off', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' }

test('the tool exists only when the company allows it; forbidden, unknown or a failing check = none', async () => {
  assert.deepEqual(await secondOpinionTurn(['codex'], async () => true), { targets: ['codex'], forbidden: false })
  assert.deepEqual(await secondOpinionTurn(['codex'], async () => false), { targets: [], forbidden: true })
  assert.deepEqual(await secondOpinionTurn(['codex'], async () => { throw new Error('offline') }), { targets: [], forbidden: true })
  assert.deepEqual(await secondOpinionTurn(['codex'], undefined), { targets: [], forbidden: true })
  // A truthy non-boolean is not a yes.
  assert.deepEqual(await secondOpinionTurn(['codex'], async () => 'yes' as unknown as boolean), { targets: [], forbidden: true })
  // Nobody named the other AI: the company is not asked, nothing is said.
  let asked = 0
  assert.deepEqual(await secondOpinionTurn([], async () => { asked++; return true }), { targets: [], forbidden: false })
  assert.equal(asked, 0)
  assert.match(secondOpinionForbiddenInstructions(['codex']), /Codex.*許されていません/)
})

test('the policy says allowed only with an explicit allowed: true', () => {
  const policy = (secondOpinion?: unknown) => parseAgentPolicy({ version: 'v1', sandbox, ...(secondOpinion === undefined ? {} : { secondOpinion }) })
  assert.equal(secondOpinionAllowed(policy({ allowed: true })), true)
  assert.equal(secondOpinionAllowed(policy({ allowed: false })), false)
  // An older server (no field) or something unreadable.
  assert.equal(secondOpinionAllowed(policy()), false)
  assert.equal(secondOpinionAllowed(policy({ allowed: 'true' })), false)
  assert.equal(secondOpinionAllowed(policy(true)), false)
  assert.equal(secondOpinionAllowed(undefined), false)
})

test('no answer from the server (offline, an older server\'s 404) = not allowed', async () => {
  const store = (answer: () => Promise<Response>) => createAgentPolicyStore({ baseUrl: () => 'https://acb.example.jp', cookies: () => [], fetch: answer as typeof fetch, log: quiet })
  const offline = store(async () => { throw new Error('offline') })
  assert.equal(secondOpinionAllowed(await offline.refresh('co')), false)
  const older = store(async () => new Response('{}', { status: 404 }))
  assert.equal(secondOpinionAllowed(await older.refresh('co')), false)
  const allowed = store(async () => new Response(JSON.stringify({ data: { version: 'v1', sandbox, secondOpinion: { allowed: true } } }), { status: 200 }))
  assert.equal(secondOpinionAllowed(await allowed.refresh('co')), true)
})

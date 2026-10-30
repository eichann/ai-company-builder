// The key broker in the app (K6, key-broker.md): which variables the chat's AI
// process and the tools get, and what the AI-process filter lets through.
//
// - The agent's own CLI never gets the standard variables of its vendor
//   (Claude Code: ANTHROPIC_*, Codex: OPENAI_*): it would leave the member's
//   login for the company's key. Scripts get the ACB_* names for those.
// - A real key or another base URL from the member's shell never reaches an AI
//   process under a broker name; only the app's token, placeholder and relay URLs do.
// - Services the company has keys for but this member may not use get the
//   placeholder (the relay then answers in plain Japanese); services nobody
//   configured get nothing (scripts behave as before the broker).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BROKER_NO_KEY_PLACEHOLDER } from '../../shared/core/key-broker'
import type { BrokerTokenIssued } from '../../shared/types/key-broker'
import { brokerEnv } from '../shared/broker-env'
import { agentBrokerReservedServices } from '../shared/agents/registry'
import { buildAgentEnv } from '../electron/agents/agent-env'

const TOKEN = `acb_tok_${'ab'.repeat(32)}`
const SERVER = 'https://acb.example.co.jp/'
const issued: BrokerTokenIssued = {
  enabled: true, token: TOKEN, tokenId: 't1', expiresAt: '2026-10-30T10:00:00.000Z',
  services: [{ service: 'gemini', source: 'company' }, { service: 'anthropic', source: 'user' }],
  unavailable: [{ service: 'openai', reason: 'no-key' }, { service: 'nothing', reason: 'unknown-service' }],
}

test('scripts get the token where SDKs look for a key and the relay where they look for a base URL', () => {
  const env = brokerEnv(SERVER, issued)
  assert.equal(env.GEMINI_API_KEY, TOKEN)
  assert.equal(env.GOOGLE_API_KEY, TOKEN) // read before GEMINI_API_KEY by google-genai
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://acb.example.co.jp/api/broker/gemini')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://acb.example.co.jp/api/broker/anthropic')
  assert.equal(env.ACB_GEMINI_API_KEY, TOKEN)
  assert.equal(env.ACB_BROKER_URL, 'https://acb.example.co.jp/api/broker')
  // Keys exist for OpenAI but not for this member: the placeholder, so the relay explains.
  assert.equal(env.OPENAI_API_KEY, BROKER_NO_KEY_PLACEHOLDER)
  assert.equal(env.OPENAI_BASE_URL, 'https://acb.example.co.jp/api/broker/openai/v1')
  assert.ok(!Object.values(env).some(v => v.includes('nothing')))
  // Broker off, or no answer: nothing at all.
  assert.deepEqual(brokerEnv(SERVER, { ...issued, enabled: false }), {})
  assert.deepEqual(brokerEnv(SERVER, null), {})
})

test('the agent\'s own CLI never gets its vendor\'s standard variables (the member\'s login stays in use)', () => {
  const claude = brokerEnv(SERVER, issued, agentBrokerReservedServices('claude-code'))
  assert.equal(claude.ANTHROPIC_API_KEY, undefined)
  assert.equal(claude.ANTHROPIC_BASE_URL, undefined)
  assert.equal(claude.ACB_ANTHROPIC_API_KEY, TOKEN)
  const codex = brokerEnv(SERVER, issued, agentBrokerReservedServices('codex'))
  assert.equal(codex.OPENAI_API_KEY, undefined)
  assert.equal(codex.OPENAI_BASE_URL, undefined)
  assert.equal(codex.ACB_OPENAI_API_KEY, BROKER_NO_KEY_PLACEHOLDER)
  assert.equal(codex.ANTHROPIC_API_KEY, TOKEN)
})

test('an AI process gets broker variables only with the app\'s values, never a real key or another URL', () => {
  const shell = {
    PATH: '/usr/bin',
    GEMINI_API_KEY: 'AIzaNOTREALbutLooksReal0000',
    GOOGLE_API_KEY: 'AIzaNOTREALother',
    OPENAI_BASE_URL: 'https://evil.example.com/v1',
    ACB_GEMINI_BASE_URL: 'https://evil.example.com/api/broker/gemini-x',
    ACB_GEMINI_API_KEY: 'sk-NOT-REAL',
  }
  // Even listed in the member's pass-through setting.
  const ORIGIN = 'https://acb.example.co.jp'
  const { env } = buildAgentEnv(shell, ['GEMINI_API_KEY', 'OPENAI_BASE_URL', 'ACB_GEMINI_BASE_URL'], ORIGIN)
  assert.deepEqual(env, { PATH: '/usr/bin' })
  // A relay-looking URL on another host would send the token there: dropped too.
  assert.deepEqual(buildAgentEnv({ GOOGLE_GEMINI_BASE_URL: 'https://evil.example.com/api/broker/gemini' }, [], ORIGIN).env, {})
  const withBroker = buildAgentEnv({ ...shell, ...brokerEnv(SERVER, issued) }, [], ORIGIN).env
  assert.equal(withBroker.GEMINI_API_KEY, TOKEN)
  assert.equal(withBroker.GOOGLE_GEMINI_BASE_URL, 'https://acb.example.co.jp/api/broker/gemini')
  assert.equal(withBroker.OPENAI_API_KEY, BROKER_NO_KEY_PLACEHOLDER)
  assert.ok(!JSON.stringify(withBroker).includes('NOT-REAL'))
  assert.ok(!JSON.stringify(withBroker).includes('evil'))
})

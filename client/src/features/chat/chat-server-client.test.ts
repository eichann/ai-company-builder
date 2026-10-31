// The renderer's chat-server client (src/features/chat/chatServerClient.ts):
// every URL, method, header and body the chat panel sends, and how each call
// behaves when the server fails — pinned to what ChatPanel's hand-built
// fetches did before R6.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatServerClient } from './chatServerClient'

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fakeServer(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    }
    calls.push(call)
    return answer(call)
  }) as typeof fetch
  return { calls, client: createChatServerClient({ port: 3301, authToken: 'tok' }, () => fetchImpl) }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const AUTH = { Authorization: 'Bearer tok' }
const JSON_AUTH = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }

test('steer: POST /api/steer with the session and text; delivered / not-delivered pass through, anything else is unavailable', async () => {
  const answers: Array<() => Response | Promise<Response>> = [
    () => json({ status: 'delivered', id: 's1' }),
    () => json({ status: 'not-delivered', id: 's2' }),
    () => json({ status: 'unavailable' }),
    () => json({ status: 'delivered' }, 500),
    () => json({ status: 'bogus' }),
    () => { throw new TypeError('Failed to fetch') },
    () => new Response('not json'),
  ]
  const { calls, client } = fakeServer(() => answers.shift()!())
  assert.deepEqual(await client.steer('app-1', '価格表は10月版で'), { status: 'delivered', id: 's1' })
  assert.deepEqual(await client.steer('app-1', 'x'), { status: 'not-delivered', id: 's2' })
  for (let i = 0; i < 5; i++) assert.deepEqual(await client.steer('app-1', 'x'), { status: 'unavailable' })
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:3301/api/steer', method: 'POST', headers: JSON_AUTH, body: { appSessionId: 'app-1', text: '価格表は10月版で' } })
})

test('prompt suggestion: GET with the session id encoded; an error status is null, a network error rejects', async () => {
  const answers: Array<() => Response> = [
    () => json({ suggestion: 'はい' }),
    () => json({ error: 'x' }, 500),
    () => { throw new TypeError('Failed to fetch') },
  ]
  const { calls, client } = fakeServer(() => answers.shift()!())
  assert.deepEqual(await client.promptSuggestion('a/b c'), { suggestion: 'はい' })
  assert.equal(await client.promptSuggestion('app-1'), null)
  await assert.rejects(client.promptSuggestion('app-1'))
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:3301/api/prompt-suggestion/a%2Fb%20c', method: 'GET', headers: AUTH })
})

test('session info: GET /api/session/:id (a UUID is sent as is); forgetSession: DELETE, never throws', async () => {
  const id = '5f0c3b8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
  let fail = false
  const { calls, client } = fakeServer(() => { if (fail) throw new TypeError('Failed to fetch'); return json({ claudeSessionId: 'cli-1', agentSession: { providerId: 'claude-code', id: 'cli-1' } }) })
  assert.deepEqual(await client.sessionInfo(id), { claudeSessionId: 'cli-1', agentSession: { providerId: 'claude-code', id: 'cli-1' } })
  client.forgetSession(id)
  fail = true
  client.forgetSession(id)
  await assert.rejects(client.sessionInfo(id))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ['GET', `http://127.0.0.1:3301/api/session/${id}`],
    ['DELETE', `http://127.0.0.1:3301/api/session/${id}`],
    ['DELETE', `http://127.0.0.1:3301/api/session/${id}`],
    ['GET', `http://127.0.0.1:3301/api/session/${id}`],
  ])
  assert.deepEqual(calls[1].headers, AUTH)
})

test('rate limits: GET ?provider=<agent>; the body is returned as parsed (no status check), errors reject', async () => {
  const snapshot = { provider: 'codex', status: 'allowed', updatedAt: 1, windows: [] }
  const answers: Array<() => Response> = [() => json({ rateLimits: snapshot }), () => json({ rateLimits: null }, 500), () => new Response('<html>')]
  const { calls, client } = fakeServer(() => answers.shift()!())
  assert.deepEqual(await client.rateLimits('codex'), { rateLimits: snapshot })
  assert.deepEqual(await client.rateLimits('claude-code'), { rateLimits: null })
  await assert.rejects(client.rateLimits('codex'))
  assert.deepEqual(calls.slice(0, 2).map(c => c.url), ['http://127.0.0.1:3301/api/rate-limits?provider=codex', 'http://127.0.0.1:3301/api/rate-limits?provider=claude-code'])
})

test('generate title: POST the transcript, agent and model; an error status is null', async () => {
  const answers: Array<() => Response> = [() => json({ title: ' 見積書 ' }), () => json({ error: 'Generation failed' }, 500)]
  const { calls, client } = fakeServer(() => answers.shift()!())
  const request = { messages: [{ role: 'user' as const, content: '見積書' }, { role: 'assistant' as const, content: 'はい' }], authMode: 'claude-code' as const, modelId: 'opus-5-5' }
  assert.deepEqual(await client.generateTitle(request), { title: ' 見積書 ' })
  assert.equal(await client.generateTitle(request), null)
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:3301/api/generate-title', method: 'POST', headers: JSON_AUTH, body: request })
})

test('fetch is looked up per call (the preview pages swap window.fetch after loading)', async () => {
  let current: typeof fetch = (async () => json({ suggestion: 'first' })) as typeof fetch
  const client = createChatServerClient({ port: 1, authToken: 't' }, () => current)
  assert.deepEqual(await client.promptSuggestion('a'), { suggestion: 'first' })
  current = (async () => json({ suggestion: 'second' })) as typeof fetch
  assert.deepEqual(await client.promptSuggestion('a'), { suggestion: 'second' })
})

/**
 * The app's steps against the server's route scope (`shared/core/ai-turn-routes.ts`, ai-turns.md).
 * Guards: every tool a built-in 「AI の番」 step declares, run for real against a fake server, calls
 * only routes the step is granted (and the turn start only the base routes), so a build the server
 * scopes never has a step refused by its own table; and every action tool of a step is granted by
 * its record-actions condition. Adding a tool to a step without its route fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ZodTypeAny } from 'zod'
import { AI_TURN_STEPS } from '../shared/ai-turn-steps/registry'
import { aiTurnRouteAllowed, matchAiRoute } from '../../shared/core/ai-turn-routes'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { recordToolProviders } from '../electron/records/tool-providers'

const ID = (type: string) => `${type}-abcdef12`
/** Values tried for a required field, in order; the first its schema takes is used. */
const CANDIDATES: unknown[] = [
  ID('interaction'), ID('reply_request'), ID('task'), ID('meeting'), ID('outbound_message'), ID('deal'), `r${'0'.repeat(24)}`,
  1, 'x', '2026-11-10', '2026-11-10T10:00', true, [], {},
]

/** A minimal valid input for a tool, from its schema (an action's `id` is a record of its own type). */
function sampleInput(name: string, schema: { shape: Record<string, ZodTypeAny> }): Record<string, unknown> {
  const own = name.includes('__') ? ID(name.split('__')[0]) : null
  const input: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field.isOptional()) continue
    const options = (field as { options?: unknown }).options
    const tries = [...(own && key === 'id' ? [own] : []), ...(Array.isArray(options) ? [options[0]] : []), ...CANDIDATES]
    const value = tries.find(v => field.safeParse(v).success)
    assert.notEqual(value, undefined, `${name}.${key}: no sample value`)
    input[key] = value
  }
  // A mail draft names what it answers (the schema's refine wants one of them).
  if (name === 'mail_draft_create' || name === 'mail_recipients') input.interactionId = ID('interaction')
  return input
}

const json = (status: number, data: unknown) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })

for (const step of AI_TURN_STEPS.values()) {
  test(`${step.step}: every tool calls only the routes the server grants the step`, async () => {
    const calls: Array<{ method: string; path: string }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      if (url.pathname.endsWith('/me/record-tokens')) return json(201, { token: 'acb_rec_x', tokenId: 't1', scope: 'act' })
      if (!url.pathname.startsWith('/api/records-ai/')) return json(404, { code: 'NOT_FOUND' })
      const path = url.pathname.slice('/api/records-ai'.length)
      calls.push({ method, path })
      if (path === '/types') return json(200, { types: coreTypeDefinitions().map(definition => ({ definition })) })
      if (path === '/plugins') return json(200, { plugins: [] })
      if (/^\/minutes\/[^/]+\/text$/.test(path)) {
        return json(200, { recordId: ID('meeting'), version: 1, header: '【h】', text: 't', footer: '【f】', truncated: false, docVersion: 'v', meeting: { title: 'm', at: null }, folder: null, attendees: [], externalAttendees: 0, bundle: null, candidates: [], noBundle: false, instructionLike: [] })
      }
      if (path.startsWith('/threads/')) return json(200, { thread: { unavailable: null, messages: [], replies: [], more: false } })
      if (/^\/item\/[^/]+\/history$/.test(path)) return json(200, { entries: [] })
      if (/^\/item\/[^/]+$/.test(path) && method === 'GET') return json(200, { record: { id: ID('task'), type: 'task', title: 't', summary: '', state: 'preparing', version: 1, fields: {} }, links: [] })
      return json(200, { recordId: ID('interaction'), version: 1 })
    }) as typeof globalThis.fetch
    const access = await createRecordsApi({ baseUrl: () => 'https://acb.example', cookies: () => ['s=1'], fetch })
      .openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope: 'act' })
    const tools = (await createRecordTools(access!, undefined, { toolProviders: recordToolProviders({ privateFolders: { readable: () => [] } } as never, { companyId: 'co', companyRoot: null }) }))!
    const allowed = (c: { method: string; path: string }) => {
      const m = matchAiRoute(c.method, c.path)
      return m !== null && aiTurnRouteAllowed(step.step, m.route, m.params)
    }
    for (const c of calls) assert.ok(allowed(c), `turn start: ${c.method} ${c.path}`)
    for (const name of step.tools.recordTools) {
      const spec = tools.specs.find(s => s.name === name)
      assert.ok(spec, `${step.step}: ${name} is not a tool`)
      calls.length = 0
      await tools.execute(name, sampleInput(name, spec.schema))
      assert.ok(calls.length > 0, `${step.step}: ${name} made no call`)
      for (const c of calls) assert.ok(allowed(c), `${step.step}: ${name} calls ${c.method} ${c.path}, not granted`)
    }
  })
}

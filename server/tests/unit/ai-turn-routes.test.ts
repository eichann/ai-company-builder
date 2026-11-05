/**
 * The server's scope of a built-in 「AI の番」 step's record token (shared/core/ai-turn-routes.ts,
 * ai-turns.md). Guards:
 * - every route a record token reaches is in `AI_ROUTES`, and every listed route exists: a new AI
 *   route fails here until it is listed (and so decided for each step);
 * - a step's grants: its routes and the turn start's, a condition on an action's record type and
 *   name, nothing else; a step not in the table (a business plugin's) is not scoped;
 * - the gate: a build at or after `AI_TURN_ROUTE_SCOPE_COMMIT_DATE` is scoped, an older one or none is not.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: { handler: vi.fn(), api: { getSession: vi.fn().mockResolvedValue(null) } },
}))

import { AI_ROUTES, AI_TURN_STEP_ROUTES, aiTurnRouteAllowed, matchAiRoute } from '../../../shared/core/ai-turn-routes'
import { CORE_STEP_CREATE_TYPES } from '../../../shared/core/ai-runs'
import { AI_TURN_ROUTE_SCOPE_COMMIT_DATE, aiTurnRouteScopeApplies } from '../../src/lib/client-version'

describe('the AI routes', () => {
  it('every route a record token reaches is listed, and every listed route exists', async () => {
    (await import('../../src/db')).initDatabase()
    const { app } = await import('../../src/app')
    const { guardKind } = await import('../../src/routes/guards')
    const served = new Set<string>()
    for (const r of app.routes) {
      if (guardKind(r.handler) !== 'record-token') continue
      expect(r.path.startsWith('/api/records-ai/'), r.path).toBe(true)
      served.add(`${r.method} ${r.path.replace(/^\/api\/records-ai/, '')}`)
    }
    expect(served.size).toBeGreaterThan(30)
    expect([...served].filter(r => !(AI_ROUTES as readonly string[]).includes(r))).toEqual([])
    expect(AI_ROUTES.filter(r => !served.has(r))).toEqual([])
  })

  it('every built-in step is scoped, and each grant names a listed route', () => {
    expect(Object.keys(AI_TURN_STEP_ROUTES).sort()).toEqual(Object.keys(CORE_STEP_CREATE_TYPES).sort())
    for (const grants of Object.values(AI_TURN_STEP_ROUTES)) {
      for (const g of grants) expect(AI_ROUTES).toContain(typeof g === 'string' ? g : g.route)
    }
  })
})

describe('a step\'s routes', () => {
  it('its own and the turn start\'s; nothing else', () => {
    expect(aiTurnRouteAllowed('inbox-triage', 'GET /threads/:recordId')).toBe(true)
    expect(aiTurnRouteAllowed('inbox-triage', 'GET /types')).toBe(true)
    expect(aiTurnRouteAllowed('inbox-triage', 'POST /query')).toBe(false)
    expect(aiTurnRouteAllowed('inbox-triage', 'POST /plugins/:pluginId/calls/:call')).toBe(false)
    expect(aiTurnRouteAllowed('reply-check', 'POST /outbound')).toBe(false)
    expect(aiTurnRouteAllowed('minutes-reading', 'GET /item/:recordId/history')).toBe(false)
    // Not a built-in step (a business plugin's has its C4 gate): not scoped here.
    expect(aiTurnRouteAllowed('sample-sales__work', 'POST /query')).toBe(true)
  })

  it('an action only of the step\'s own record type and name (a legacy minutes- id is a meeting)', () => {
    const action = (step: string, path: string) => {
      const m = matchAiRoute('POST', path)!
      return aiTurnRouteAllowed(step, m.route, m.params)
    }
    expect(action('inbox-triage', '/item/reply_request-abcdef12/actions/finish_prep')).toBe(true)
    expect(action('inbox-triage', '/item/task-abcdef12/actions/finish_prep')).toBe(false)
    expect(action('inbox-triage', '/item/reply_request-abcdef12/actions/ai_close')).toBe(false)
    expect(action('minutes-reading', '/item/minutes-abcdef12/actions/finish_reading')).toBe(true)
    expect(action('minutes-reading', '/item/meeting-abcdef12/actions/skip')).toBe(false)
  })
})

describe('the gate for released apps', () => {
  it('scopes a build at or after the change; an older build or none is not scoped', () => {
    expect(AI_TURN_ROUTE_SCOPE_COMMIT_DATE).toMatch(/^\d{14}$/)
    expect(aiTurnRouteScopeApplies(`0.0.1+abc1234.${AI_TURN_ROUTE_SCOPE_COMMIT_DATE}`)).toBe(true)
    expect(aiTurnRouteScopeApplies('0.0.1+abc1234.20991231000000')).toBe(true)
    expect(aiTurnRouteScopeApplies('0.0.1+abc1234.20261101000000')).toBe(false)
    expect(aiTurnRouteScopeApplies(null)).toBe(false)
    expect(aiTurnRouteScopeApplies('garbage')).toBe(false)
  })
})

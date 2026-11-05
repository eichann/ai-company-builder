/**
 * Which AI routes a built-in 「AI の番」 step's token may use (ai-turns.md "The server scopes a
 * built-in step's token"). Text from outside starts these runs, so the server, not only the app's
 * tool filter, keeps a run to its job: a record token bound to a run of a step listed here gets
 * 403 `NOT_IN_STEP` on any other route. One copy: the server's token guard applies it
 * (`routes/guards.ts`), the app's tests check its steps' tools against it.
 *
 * - `AI_ROUTES` is every route a record token reaches, as `<METHOD> <path under /api/records-ai>`
 *   (`server/tests/unit/ai-turn-routes.test.ts` fails when the server has one not listed, or the
 *   list names one the server does not have).
 * - A step grants routes; a grant may carry a condition on the route's parameters
 *   (`RouteCondition`). A condition kind the server does not know refuses (fails closed).
 * - A step not listed here (a business plugin's `<plugin>__<step>`: the C4 gate, plugins.md) is
 *   not scoped by this table, and a consultation's token (no run) never is.
 *
 * Pure: imports nothing.
 */

/** Every route a record token reaches (the path under /api/records-ai). */
export const AI_ROUTES = [
  'GET /types', 'GET /my-turn', 'GET /ai-turn', 'POST /query',
  'GET /item/:recordId', 'GET /item/:recordId/history', 'POST /item', 'POST /item/:recordId/actions/:action',
  'POST /item/:recordId/file-links', 'POST /item/:recordId/file-links/remove',
  'POST /decisions',
  'GET /minutes/:recordId/text', 'POST /minutes/:recordId/bundle',
  'GET /plugins', 'POST /plugins/:pluginId/records/:recordId/operations/:operation', 'POST /plugins/:pluginId/calls/:call',
  'POST /plugins/:pluginId/create/:operation', 'GET /plugins/:pluginId/operations/:operationId',
  'GET /approvals', 'GET /approvals/:approvalId',
  'POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId', 'PUT /outbound/:messageId',
  'GET /threads/:recordId',
  'GET /identities/records/:recordId', 'POST /identities/proposals',
  'GET /inbox/items/:recordId', 'POST /inbox/items/:recordId/judgement', 'POST /inbox/items/:recordId/reply-check',
  'GET /google/drive/status', 'POST /google/drive/read', 'POST /google/drive/put', 'GET /google/drive/puts/:putId',
] as const
export type AiRouteId = typeof AI_ROUTES[number]

/**
 * A condition on a granted route's parameters. Today one kind; a later step adds its own kind
 * here and in `routeConditionHolds` (e.g. a skill run whose token writes only under its
 * deliverable folder: `{ kind: 'path-under', param, root: 'deliverable' }` checked against the
 * run's own folder). Unknown kinds refuse.
 */
export type RouteCondition =
  /** `POST /item/:recordId/actions/:action`: only these `<type>__<action>` (the record's type from its id). */
  | { kind: 'record-actions'; actions: readonly string[] }

export type RouteGrant = AiRouteId | { route: AiRouteId; only: RouteCondition }

/**
 * What every built-in step's run reads when its turn starts (`createRecordTools`: the types and
 * the plugins' tool list). Anything else a turn start asks (Drive's status) is refused and the app
 * goes on without those tools.
 */
export const AI_TURN_BASE_ROUTES: readonly AiRouteId[] = ['GET /types', 'GET /plugins']

const actions = (...names: string[]): RouteGrant => ({ route: 'POST /item/:recordId/actions/:action', only: { kind: 'record-actions', actions: names } })

/**
 * Each built-in step's routes: its tools' calls (`client/shared/ai-turn-steps/<step>.ts`), plus
 * the read the app makes after a replayed write (`records/api.ts` `replayReadPath`: the record or
 * the draft it made). `client/tests/ai-turn-routes.test.ts` runs every step's tools and checks each
 * call against this table.
 */
export const AI_TURN_STEP_ROUTES: Readonly<Record<string, readonly RouteGrant[]>> = {
  'minutes-reading': [
    'GET /minutes/:recordId/text', 'POST /minutes/:recordId/bundle',
    actions('meeting__start_reading', 'meeting__finish_reading', 'meeting__fail_reading'),
    'POST /item', 'POST /decisions', 'GET /item/:recordId',
    'POST /outbound-recipients', 'POST /outbound', 'PUT /outbound/:messageId', 'GET /outbound/:messageId',
  ],
  'inbox-triage': [
    'GET /inbox/items/:recordId', 'GET /threads/:recordId', 'POST /inbox/items/:recordId/judgement',
    'POST /item', 'GET /item/:recordId',
    'POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId',
    actions('reply_request__finish_prep', 'reply_request__hand_over'),
  ],
  'follow-up': [
    'GET /inbox/items/:recordId', 'GET /threads/:recordId',
    'POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId',
    actions('reply_request__finish_prep', 'reply_request__hand_over', 'reply_request__ai_close', 'reply_request__await_reply', 'reply_request__set_wait_until'),
  ],
  'reply-check': [
    'GET /inbox/items/:recordId', 'GET /threads/:recordId', 'POST /inbox/items/:recordId/reply-check',
  ],
  'task-wait-over': [
    'GET /item/:recordId', 'GET /item/:recordId/history',
    'GET /inbox/items/:recordId', 'GET /threads/:recordId',
    'POST /outbound-recipients', 'POST /outbound', 'GET /outbound/:messageId',
    actions('task__finish_prep', 'task__hand_over'),
  ],
}

/** A record id's type as its actions name it (`minutes-…`: a meeting made before the type was renamed). */
function actionTypeOf(recordId: string | undefined): string | null {
  const m = /^([a-z][a-z0-9_]{0,39})-[0-9a-z]{6,32}$/.exec(recordId ?? '')
  if (!m) return null
  return m[1] === 'minutes' ? 'meeting' : m[1]
}

function routeConditionHolds(condition: RouteCondition, params: Readonly<Record<string, string | undefined>>): boolean {
  switch (condition.kind) {
    case 'record-actions': {
      const type = actionTypeOf(params.recordId)
      return type !== null && typeof params.action === 'string' && condition.actions.includes(`${type}__${params.action}`)
    }
    default:
      return false
  }
}

/** Whether `step` is a built-in step this table scopes (else: not scoped here). */
export function isScopedAiTurnStep(step: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_TURN_STEP_ROUTES, step)
}

/** May a run of the built-in `step` use this route with these parameters? (A step not scoped here: true.) */
export function aiTurnRouteAllowed(step: string, route: string, params: Readonly<Record<string, string | undefined>> = {}): boolean {
  if (!isScopedAiTurnStep(step)) return true
  if ((AI_TURN_BASE_ROUTES as readonly string[]).includes(route)) return true
  return AI_TURN_STEP_ROUTES[step].some(g => typeof g === 'string' ? g === route : g.route === route && routeConditionHolds(g.only, params))
}

/**
 * The route id of a concrete request (`GET`, `/item/task-0001ab`) and its parameters, or null when
 * no AI route matches. For the app's tests; the server takes the matched pattern from Hono.
 */
export function matchAiRoute(method: string, path: string): { route: AiRouteId; params: Record<string, string> } | null {
  const parts = path.split('?')[0].split('/').filter(Boolean)
  for (const route of AI_ROUTES) {
    const [m, pattern] = route.split(' ')
    if (m !== method.toUpperCase()) continue
    const want = pattern.split('/').filter(Boolean)
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    if (want.every((w, i) => w.startsWith(':') ? (params[w.slice(1)] = decodeURIComponent(parts[i])) !== '' : w === parts[i])) return { route, params }
  }
  return null
}

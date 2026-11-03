/**
 * The core roles (役目, stage 3, `.claude/rules/connector-roles.md`): the jobs
 * the core app asks of a core connector (Google Workspace, Microsoft 365,
 * Slack) without knowing the service's name. One place for the role names,
 * their operations and their optional capabilities; a core connector declares
 * which of them it serves, and the server resolves which connector serves a
 * role in a company (`server/src/services/connector-roles.ts`).
 *
 * Four roles (owner decision 2026-11-01, plan §5-4):
 *   calendar  予定を読む                       read
 *   mail      メールを読む／送る                 read, send
 *   meetings  会議の記録を読む                   read; optional: transcript, attendees
 *   chat      チャットの連絡を受け取る／返す     receive, reply
 *
 * Drive is not a role: it is a Google-specific capability a business plugin
 * uses by name. An optional capability is asked for (`hasRoleCapability`),
 * never assumed: the core app works without it.
 */

export const CONNECTOR_ROLES = {
  calendar: { label: '予定を読む', operations: ['read'], capabilities: [] },
  mail: { label: 'メールを読む・送る', operations: ['read', 'send'], capabilities: [] },
  meetings: { label: '会議の記録を読む', operations: ['read'], capabilities: ['transcript', 'attendees'] },
  chat: { label: 'チャットの連絡を受け取る・返す', operations: ['receive', 'reply'], capabilities: [] },
} as const satisfies Record<string, { label: string; operations: readonly string[]; capabilities: readonly string[] }>

export type ConnectorRole = keyof typeof CONNECTOR_ROLES
export type RoleOperation<R extends ConnectorRole = ConnectorRole> = typeof CONNECTOR_ROLES[R]['operations'][number]
export type RoleCapability<R extends ConnectorRole = ConnectorRole> = typeof CONNECTOR_ROLES[R]['capabilities'][number]

export const CONNECTOR_ROLE_NAMES = Object.keys(CONNECTOR_ROLES) as ConnectorRole[]

export const isConnectorRole = (value: unknown): value is ConnectorRole =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONNECTOR_ROLES, value)

export function isRoleOperation<R extends ConnectorRole>(role: R, value: unknown): value is RoleOperation<R> {
  return (CONNECTOR_ROLES[role].operations as readonly unknown[]).includes(value)
}

export function isRoleCapability<R extends ConnectorRole>(role: R, value: unknown): value is RoleCapability<R> {
  return (CONNECTOR_ROLES[role].capabilities as readonly unknown[]).includes(value)
}

/** What a core connector declares it serves for one role. */
export interface RoleServing {
  role: ConnectorRole
  /** The role's operations it can do (at least one). */
  operations: readonly string[]
  /** The role's optional capabilities it has (may be empty). */
  capabilities: readonly string[]
}

/**
 * Problems of a connector's role declaration (empty: fine): an unknown role,
 * operation or capability, a role declared twice, a role with no operation.
 * Japanese sentences, for the developer who writes the declaration.
 */
export function roleServingProblems(servings: readonly RoleServing[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const s of servings) {
    if (!isConnectorRole(s.role)) { problems.push(`知らない役目です: ${String(s.role)}`); continue }
    if (seen.has(s.role)) problems.push(`役目が二度書かれています: ${s.role}`)
    seen.add(s.role)
    if (s.operations.length === 0) problems.push(`役目 ${s.role} にできることがありません`)
    for (const op of s.operations) if (!isRoleOperation(s.role, op)) problems.push(`役目 ${s.role} に知らない操作があります: ${op}`)
    for (const cap of s.capabilities) if (!isRoleCapability(s.role, cap)) problems.push(`役目 ${s.role} に知らない能力があります: ${cap}`)
  }
  return problems
}

/** One core connector as role resolution sees it in a company now. */
export interface RoleCandidate {
  /** The core connector's id (`google`, `slack`, …). */
  connectorId: string
  servings: readonly RoleServing[]
  /** Set up and on in the company, not stopped by the operator. */
  usable: boolean
}

export type RoleResolution =
  | { ok: true; connectorId: string; capabilities: readonly string[] }
  /** No usable connector serves the role (and operation). */
  | { ok: false; reason: 'none' }
  /** Two or more usable connectors serve it and the admin has not chosen one of them. */
  | { ok: false; reason: 'choice-needed'; candidates: string[] }

/**
 * Which connector serves `role` (for `operation`, when given) in a company:
 * among the usable connectors that serve it, the only one; with two or more,
 * the admin's choice for the role when it is one of them (the choice is asked
 * once, only when both exist — spec §10-1). A choice that names a connector
 * not usable now does not count, and is never replaced by a guess between
 * two: the answer is `choice-needed` until the admin chooses again.
 */
export function resolveRole(role: ConnectorRole, operation: string | null, candidates: readonly RoleCandidate[], choice: string | null): RoleResolution {
  const serving = candidates
    .filter(c => c.usable)
    .map(c => ({ id: c.connectorId, s: c.servings.find(s => s.role === role) }))
    .filter((c): c is { id: string; s: RoleServing } => !!c.s && (operation === null || c.s.operations.includes(operation)))
  if (serving.length === 0) return { ok: false, reason: 'none' }
  const pick = serving.length === 1 ? serving[0] : serving.find(c => c.id === choice)
  if (!pick) return { ok: false, reason: 'choice-needed', candidates: serving.map(c => c.id).sort() }
  return { ok: true, connectorId: pick.id, capabilities: pick.s.capabilities }
}

/** Whether a resolved role has an optional capability (the core app asks before using it). */
export function hasRoleCapability<R extends ConnectorRole>(resolved: RoleResolution, capability: RoleCapability<R>): boolean {
  return resolved.ok && resolved.capabilities.includes(capability)
}

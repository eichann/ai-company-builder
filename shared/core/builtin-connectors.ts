/**
 * The core connectors built into ACB (基幹のつなぎ先, stage 3 A1,
 * `.claude/rules/connector-roles.md` "Built-in connectors"): connectors whose
 * code ships with the app (they need code, not only a declaration), yet are
 * put in and taken out like a plugin — shown in the admin console's
 * 「つないでいるサービス」, switched on and off by the company's admin, stopped
 * for every company by the operator's stop file (`<PLUGINS_DIR>/stopped`
 * naming the id). They are not packages in `PLUGINS_DIR`.
 *
 * Each declares the core roles it serves (`shared/core/connector-roles.ts`)
 * and its own optional capabilities: things only this service has (Google
 * Drive), which a business plugin may use by name but the core app never asks
 * for. Google stays where its code is (plan §5-2); this is its declaration.
 *
 * Pure: imports only shared/core.
 */
import type { RoleServing } from './connector-roles'

export interface BuiltinConnector {
  /** The connector's id: the role resolver's connector id and the operator stop file's name. */
  id: string
  /** The service's name as people know it (shown as is). */
  label: string
  /** One sentence for the admin's list: what it lets ACB do. */
  summary: string
  /** The core roles it serves, with their operations and optional role capabilities. */
  servings: readonly RoleServing[]
  /** Its own capabilities beyond the roles (not roles: the core app never asks for them). */
  capabilities: readonly { id: string; label: string }[]
}

export const BUILTIN_CONNECTORS = {
  google: {
    id: 'google',
    label: 'Google Workspace',
    summary: 'メンバーが自分で許可すると、予定・メール・Meet の議事録を ACB が読み、本人が確かめたメールを送れます。',
    servings: [
      { role: 'calendar', operations: ['read'], capabilities: [] },
      { role: 'mail', operations: ['read', 'send'], capabilities: [] },
      { role: 'meetings', operations: ['read'], capabilities: ['transcript', 'attendees'] },
    ],
    capabilities: [{ id: 'drive', label: 'Drive で選んだものを読む・置く' }],
  },
} as const satisfies Record<string, BuiltinConnector>

export type BuiltinConnectorId = keyof typeof BUILTIN_CONNECTORS

export const BUILTIN_CONNECTOR_IDS = Object.keys(BUILTIN_CONNECTORS) as BuiltinConnectorId[]

export const isBuiltinConnectorId = (v: unknown): v is BuiltinConnectorId =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_CONNECTORS, v)

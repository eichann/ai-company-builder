/**
 * Claude Code permission modes the chat exposes.
 * - `auto`: Claude Code's classifier approves safe actions and blocks risky ones.
 * - `default`: every write / command asks the user through the approval UI.
 * - `bypassPermissions`: everything runs without asking (dangerous commands still ask).
 */
export const PERMISSION_MODES = ['auto', 'default', 'bypassPermissions'] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

/** Used when the user has never chosen a mode. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'

export function normalizePermissionMode(value: unknown): PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value) ? value as PermissionMode : DEFAULT_PERMISSION_MODE
}

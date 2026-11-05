/**
 * Business roles (役割, plan C3, `.claude/rules/plugin-roles.md`) behind the
 * company handle: every method is limited to the handle's company. Member ids
 * only.
 */

export interface PluginRoleHistoryRow {
  pluginId: string
  role: string
  /** Null: the company's assignment; else the まとまり whose override changed. */
  bundleId: string | null
  action: 'assign' | 'override' | 'clear-override'
  userIds: string[]
  at: string
  by: string
}

export interface PluginRoleRepository {
  /** The company's assignment of one role, or null (never assigned). */
  assignment(pluginId: string, role: string): string[] | null
  /** Every role of a plugin the company assigned: role → member ids. */
  assignments(pluginId: string): Record<string, string[]>
  /** A まとまり's override of one role, or null. */
  override(pluginId: string, role: string, bundleId: string): string[] | null
  /** Every override of a plugin: role, まとまり, member ids. */
  overrides(pluginId: string): Array<{ role: string; bundleId: string; userIds: string[] }>
  /** Set the company's assignment (and write its history line). */
  assign(pluginId: string, role: string, userIds: string[], at: string, by: string): void
  /** Set (userIds) or remove (null) a まとまり's override (and write its history line). */
  setOverride(pluginId: string, role: string, bundleId: string, userIds: string[] | null, at: string, by: string): void
  /** A member left: out of every assignment and override of the company (a history line each), so coming back gives nothing back. An override left empty stays: nobody, not the company's. */
  forgetMember(userId: string, at: string, by: string): void
  /** History, newest first. */
  history(pluginId: string, limit: number): PluginRoleHistoryRow[]
}

/**
 * A business plugin's steps (plan C5, `.claude/rules/plugin-steps.md`) behind
 * the company handle: every method is limited to the handle's company.
 */
import type { PluginStepProcedurePin } from '../../shared/core/plugins'

export interface PluginStepPinRow {
  recordId: string
  pluginId: string
  step: string
  pin: PluginStepProcedurePin
  pinnedAt: string
  updatedAt: string
}

export interface PluginStepRepository {
  /** The work's pin for a step, or null (never run). */
  pin(recordId: string, pluginId: string, step: string): PluginStepPinRow | null
  /**
   * Pin a work's step at its first run: false when a pin is already there
   * (another PC's first run won; read it back), nothing changed.
   */
  insertPin(row: PluginStepPinRow): boolean
  /** Move a pinned work to another pin (an `upgrade.at` point), only from `from` (compare-and-set). */
  movePin(recordId: string, pluginId: string, step: string, from: PluginStepProcedurePin, to: PluginStepProcedurePin, at: string): boolean
  /** Every plugin-version pin of a plugin (the shelf keeps those versions while their work is open). */
  pluginPins(pluginId: string): Array<{ recordId: string; version: string; fingerprint: string }>
  /** The company's Skill for each overridable step of a plugin: step → Skill name. */
  stepSkills(pluginId: string): Record<string, string>
  /** Set (a Skill name) or remove (null) the company's Skill for a step. */
  setStepSkill(pluginId: string, step: string, skill: string | null, at: string, by: string): void
}

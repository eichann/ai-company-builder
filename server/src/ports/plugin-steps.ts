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

/** How the company runs a step (plugin-steps.md "Starting by itself"); absent = the button, the folder from the step's label. */
export interface PluginStepSettingRow {
  autoStart: boolean
  deliverableFolder: string | null
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
  /** The step a member's consultation was started from (a `start: person` step), or null. */
  consultationStep(userId: string, conversationId: string): { recordId: string; pluginId: string; step: string } | null
  /** Bind a member's consultation to a step for good: false when it is bound already (nothing changed). */
  bindConsultation(row: { userId: string; conversationId: string; recordId: string; pluginId: string; step: string; at: string }): boolean
  /** The company's settings of a plugin's steps: step → setting (steps never set are absent). */
  stepSettings(pluginId: string): Record<string, PluginStepSettingRow>
  /** Store a step's setting (both values). */
  setStepSetting(pluginId: string, step: string, setting: PluginStepSettingRow, at: string, by: string): void
  /** Ask for a step's automatic run on a record (again: a done request is opened anew). */
  request(row: { recordId: string; pluginId: string; step: string; at: string; meetingId: string | null }): void
  /** The record's open request for a step (not answered by a finished run), or null. */
  openRequest(recordId: string, pluginId: string, step: string): { requestedAt: string; meetingId: string | null } | null
  /** Records with an open request for a step. */
  openRequests(pluginId: string, step: string): string[]
  /** A finished run answers the request made at or before `startedAt` (a later request stays open). */
  answerRequest(recordId: string, pluginId: string, step: string, startedAt: string, at: string): void
}

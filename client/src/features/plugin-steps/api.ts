// A business plugin's steps (plan C5, .claude/rules/plugin-steps.md): the data layer.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The member's records at a plugin's ai_turn step, and the person steps at a record (read with the session in main). */
export type PluginStepReads = ElectronPort<'listPluginStepTurns' | 'listPersonSteps'>
/** A person starts a step: the server pins the work's procedure (its first run) — a change to the shared record's work. */
export type PluginStepWrites = ElectronPort<'startPersonStep'>

export function listPluginStepTurns(companyId: string, reads: PluginStepReads = window.electronAPI) {
  return reads.listPluginStepTurns(companyId)
}

export function listPersonSteps(companyId: string, recordId: string, reads: PluginStepReads = window.electronAPI) {
  return reads.listPersonSteps(companyId, recordId)
}

export function startPersonStep(companyId: string, recordId: string, pluginId: string, step: string, companyRoot: string, writes: PluginStepWrites = window.electronAPI) {
  return writes.startPersonStep(companyId, recordId, pluginId, step, companyRoot)
}

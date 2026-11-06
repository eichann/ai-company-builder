// A business plugin's steps (plan C5, .claude/rules/plugin-steps.md): the data layer.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The member's records at a plugin's ai_turn step, and the person steps at a record (read with the session in main). */
export type PluginStepReads = ElectronPort<'listPluginStepTurns' | 'listPersonSteps'>
/** What a step made for a record (its やること's 確かめる点, files, mail draft), and the signal that records changed. */
export type StepDeliverableReads = ElectronPort<'readStepDeliverables' | 'onRecordsChanged'>

export function readStepDeliverables(companyId: string, recordId: string, reads: StepDeliverableReads = window.electronAPI) {
  // A window without it (a preview page, an older preload) shows nothing.
  return reads.readStepDeliverables?.(companyId, recordId) ?? Promise.resolve(null)
}

/** `listener` hears that this company's records may have changed (the member's AI wrote one, or the push channel said so). */
export function onRecordsMayHaveChanged(companyId: string, listener: () => void, reads: StepDeliverableReads = window.electronAPI): () => void {
  return reads.onRecordsChanged?.((change: { companyId: string }) => { if (change.companyId === companyId) listener() }) ?? (() => {})
}

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

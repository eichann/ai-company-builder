// A business plugin's steps (plan C5, .claude/rules/plugin-steps.md): the data layer.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The member's records at a plugin's ai_turn step (main reads them with the session and remembers them for the claim). */
export type PluginStepTurnReads = ElectronPort<'listPluginStepTurns'>

export function listPluginStepTurns(companyId: string, reads: PluginStepTurnReads = window.electronAPI) {
  return reads.listPluginStepTurns(companyId)
}

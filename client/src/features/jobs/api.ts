// Settings → 「定期の仕事」's access to the main process (src/shared/ipc/electron-api.ts): small ports,
// each function taking its port last (default window.electronAPI). Main asks the company server with
// the member's session.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The jobs the member is responsible for. */
export type JobsReads = ElectronPort<'getMyJobs'>
/** Their occurrences this PC may run now (the AI turn runner's queue; main remembers them for the claim). */
export type JobTurnReads = ElectronPort<'listJobTurns'>
/** The member's own acts on them: accepting, pausing, resuming (kept on the server). */
export type JobsWrites = ElectronPort<'acceptJob' | 'pauseJob' | 'resumeJob'>

export function getMyJobs(companyId: string, reads: JobsReads = window.electronAPI) {
  return reads.getMyJobs(companyId)
}

export function listJobTurns(companyId: string, reads: JobTurnReads = window.electronAPI) {
  // A window without it (a preview page, an older preload) runs no jobs.
  return reads.listJobTurns?.(companyId) ?? Promise.resolve([])
}

export function acceptJob(companyId: string, jobId: string, version: number, fingerprint: string, writes: JobsWrites = window.electronAPI) {
  return writes.acceptJob(companyId, jobId, version, fingerprint)
}

export function pauseJob(companyId: string, jobId: string, writes: JobsWrites = window.electronAPI) {
  return writes.pauseJob(companyId, jobId)
}

export function resumeJob(companyId: string, jobId: string, writes: JobsWrites = window.electronAPI) {
  return writes.resumeJob(companyId, jobId)
}

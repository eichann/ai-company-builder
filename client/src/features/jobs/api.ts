// Settings → 「定期の仕事」's access to the main process (src/shared/ipc/electron-api.ts): small ports,
// each function taking its port last (default window.electronAPI). Main asks the company server with
// the member's session.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The jobs the member is responsible for. */
export type JobsReads = ElectronPort<'getMyJobs'>
/** Their occurrences this PC may run now (the AI turn runner's queue; main remembers them for the claim). */
export type JobTurnReads = ElectronPort<'listJobTurns'>
/** The member's own acts on them: accepting, pausing, resuming (kept on the server). */
export type JobsWrites = ElectronPort<'acceptJob' | 'pauseJob' | 'resumeJob' | 'rewatchJob'>
/** The event occurrences this PC's AI ran for the member (stage 4b-2, D11). */
export type JobOccurrenceReads = ElectronPort<'getMyJobOccurrences'>
/** 「もう一度」 and 「後始末」 on them (the server decides who may and when). */
export type JobOccurrenceWrites = ElectronPort<'retryJobOccurrence' | 'reconcileJobOccurrence'>
/** A correction of a set watch's judgement (［まだ早かった］ / ［作ってもらう］; kept on the server with the occurrence). */
export type JobFeedbackWrites = ElectronPort<'sendJobFeedback'>
/** An event job's next watched やること: the member's own open ones (stage 4a ①). */
export type WatchReads = ElectronPort<'getWatchChoices'>

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

export function getWatchChoices(companyId: string, text: string, reads: WatchReads = window.electronAPI) {
  return reads.getWatchChoices(companyId, text)
}

export function rewatchJob(companyId: string, jobId: string, version: number, recordId: string, writes: JobsWrites = window.electronAPI) {
  return writes.rewatchJob(companyId, jobId, version, recordId)
}

export function getMyJobOccurrences(companyId: string, reads: JobOccurrenceReads = window.electronAPI) {
  return reads.getMyJobOccurrences(companyId)
}

export function retryJobOccurrence(companyId: string, jobId: string, occurrenceId: string, writes: JobOccurrenceWrites = window.electronAPI) {
  return writes.retryJobOccurrence(companyId, jobId, occurrenceId)
}

export function reconcileJobOccurrence(companyId: string, jobId: string, occurrenceId: string, key: string, done: boolean, writes: JobOccurrenceWrites = window.electronAPI) {
  return writes.reconcileJobOccurrence(companyId, jobId, occurrenceId, key, done)
}

export function sendJobFeedback(companyId: string, occurrenceId: string, kind: 'too_early' | 'made_anyway', writes: JobFeedbackWrites = window.electronAPI) {
  return writes.sendJobFeedback(companyId, occurrenceId, kind)
}

/** The member's own proposals (「AIへの相談」から定期の仕事, jobs.md "Member proposals") and their 「取り下げる」. */
export type JobProposalReads = ElectronPort<'getMyJobProposals'>
export type JobProposalWrites = ElectronPort<'withdrawJobProposal'>

export function getMyJobProposals(companyId: string, reads: JobProposalReads = window.electronAPI) {
  return reads.getMyJobProposals(companyId)
}

export function withdrawMyJobProposal(companyId: string, proposalId: string, writes: JobProposalWrites = window.electronAPI) {
  return writes.withdrawJobProposal(companyId, proposalId)
}

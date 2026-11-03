// Received minutes' access to the main process (src/shared/ipc/electron-api.ts):
// small ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; nothing here holds minutes text.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { MeetingBundleQuestionResult, MinutesNoticesResult } from '../../../shared/minutes-app'

/** Watching a company's received minutes: main checks with the server (start, every 10 minutes) while subscribed. */
export type MinutesReads = ElectronPort<'watchMinutes' | 'getMinutesNotices' | 'onMinutesChanged'>
/** Asking the server to look at the member's calendar now (「議事録を確かめる」). */
export type MinutesCheckOutbound = ElectronPort<'checkMinutes'>
/** 「今は読まない」: changes the shared record's state (the server tells the people it names). */
export type MinutesWrites = ElectronPort<'skipMinutes'>
/** A meeting card's 「どのまとまりの会議ですか？」: whether a まとまり may be chosen (the server decides). */
export type MeetingBundleQuestionReads = ElectronPort<'getMeetingBundleQuestion'>
/** 「まとまりはない（社内の会議など）」: the server records the person's choice on the shared meeting. */
export type MeetingNoBundleWrites = ElectronPort<'declineMinutesBundle'>
/** はい to 「『…』の会議ですか？」: the same link as choosing by hand (nothing goes outside). */
export type MeetingBundleLinkWrites = ElectronPort<'linkMinutesBundle'>

const NONE: MinutesNoticesResult = { available: false, notices: [] }

/**
 * Follow one company's received minutes: main starts checking for it, and
 * `listener` hears that the notices may have changed (also once at the start).
 * Unsubscribing stops the checking.
 */
export function subscribeMinutes(companyId: string, listener: () => void, reads: MinutesReads = window.electronAPI): () => void {
  let active = true
  const stop = reads.onMinutesChanged(change => { if (active && change.companyId === companyId) listener() })
  void Promise.resolve(reads.watchMinutes(companyId)).catch(() => {}).then(() => { if (active) listener() })
  return () => {
    active = false
    stop?.()
    void Promise.resolve(reads.watchMinutes(null)).catch(() => {})
  }
}

export async function getMinutesNotices(companyId: string, reads: MinutesReads = window.electronAPI): Promise<MinutesNoticesResult> {
  return (await reads.getMinutesNotices(companyId)) ?? NONE
}

export function checkMinutes(companyId: string, outbound: MinutesCheckOutbound = window.electronAPI) {
  return outbound.checkMinutes(companyId)
}

export function skipMinutes(companyId: string, minutesId: string, writes: MinutesWrites = window.electronAPI) {
  return writes.skipMinutes(companyId, minutesId)
}

export async function getMeetingBundleQuestion(companyId: string, meetingId: string, reads: MeetingBundleQuestionReads = window.electronAPI): Promise<MeetingBundleQuestionResult> {
  return (await reads.getMeetingBundleQuestion(companyId, meetingId)) ?? { success: false, error: '表示できませんでした。' }
}

export function declineMeetingBundle(companyId: string, meetingId: string, writes: MeetingNoBundleWrites = window.electronAPI) {
  return writes.declineMinutesBundle(companyId, meetingId)
}

export function linkSuggestedBundle(companyId: string, meetingId: string, bundleId: string, writes: MeetingBundleLinkWrites = window.electronAPI) {
  return writes.linkMinutesBundle(companyId, meetingId, bundleId)
}

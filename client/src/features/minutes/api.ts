// Received minutes' access to the main process (src/shared/ipc/electron-api.ts):
// small ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session; nothing here holds minutes text.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { MeetingArrivalsResult, MeetingBundleQuestionResult, MeetingCardStateResult, MeetingInviteResult, MeetingPressResult, MinutesNoticesResult } from '../../../shared/minutes-app'

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

// Meetings for their attendees (minutes.md "Meetings for their attendees"): the banner and the card.
/** The member's meetings of the last days, one meeting for its card, and when they may have changed. */
export type MeetingReads = ElectronPort<'getMeetingArrivals' | 'getMeetingCardState' | 'onMinutesChanged' | 'onRecordsChanged' | 'onNotificationsChanged'>
/** ［AI に読ませる］［読まない］ and its 取り消す, 「次から自動で読む」: change the shared meeting (the server tells its people). */
export type MeetingWrites = ElectronPort<'requestMeetingReading' | 'skipMeetingReading' | 'undoTaskAction' | 'setMeetingAutoSeries'>
/** 「許可をし直す」: Google's page opens in the browser, as the settings' button does. */
export type MeetingGoogleWrites = ElectronPort<'connectGoogle'>
/** ［招待する］: shows the meeting to more members (never undone). */
export type MeetingInviteWrites = ElectronPort<'inviteToRecord'>

const NO_ARRIVALS: MeetingArrivalsResult = { available: false, items: [] }

export async function getMeetingArrivals(companyId: string, reads: MeetingReads = window.electronAPI): Promise<MeetingArrivalsResult> {
  return (await reads.getMeetingArrivals(companyId)) ?? NO_ARRIVALS
}

export async function getMeetingCardState(companyId: string, meetingId: string, reads: MeetingReads = window.electronAPI): Promise<MeetingCardStateResult> {
  return (await reads.getMeetingCardState(companyId, meetingId)) ?? { success: false, error: '' }
}

/** The meetings may have changed: the received minutes, the push channel's records signal, or a notice. */
export function onMeetingsMayHaveChanged(companyId: string, listener: () => void, reads: MeetingReads = window.electronAPI): () => void {
  const mine = (change: { companyId: string }) => { if (change.companyId === companyId) listener() }
  const stops = [reads.onMinutesChanged(mine), reads.onRecordsChanged?.(mine), reads.onNotificationsChanged(mine)]
  return () => { for (const stop of stops) stop?.() }
}

export async function requestMeetingReading(companyId: string, meetingId: string, expectedVersion: number, writes: MeetingWrites = window.electronAPI): Promise<MeetingPressResult> {
  return (await writes.requestMeetingReading(companyId, meetingId, expectedVersion)) ?? { success: false, error: 'できませんでした。' }
}

/** Asks the 議事録 feature again (Google merges what was allowed): null, or why not. */
export async function renewMinutesPermission(companyId: string, writes: MeetingGoogleWrites = window.electronAPI): Promise<string | null> {
  const r = await writes.connectGoogle(companyId, ['minutes'])
  return r?.success ? null : (r?.error ?? 'できませんでした。')
}

export async function skipMeetingReading(companyId: string, meetingId: string, expectedVersion: number, writes: MeetingWrites = window.electronAPI): Promise<MeetingPressResult> {
  return (await writes.skipMeetingReading(companyId, meetingId, expectedVersion)) ?? { success: false, error: 'できませんでした。' }
}

/** 取り消す right after ［読まない］: the generic undo of that one entry (the server refuses when something changed since). */
export async function undoMeetingSkip(companyId: string, meetingId: string, version: number, writes: MeetingWrites = window.electronAPI): Promise<string | null> {
  const r = await writes.undoTaskAction(companyId, meetingId, version, version)
  return r?.success ? null : (r?.error ?? 'できませんでした。')
}

export async function setMeetingAutoSeries(companyId: string, meetingId: string, auto: boolean, writes: MeetingWrites = window.electronAPI): Promise<string | null> {
  const r = await writes.setMeetingAutoSeries(companyId, meetingId, auto)
  return r?.success ? null : (r?.error ?? 'できませんでした。')
}

export async function inviteToMeeting(companyId: string, meetingId: string, memberIds: string[], expectedVersion: number, writes: MeetingInviteWrites = window.electronAPI): Promise<MeetingInviteResult> {
  return (await writes.inviteToRecord(companyId, meetingId, memberIds, expectedVersion)) ?? { success: false, error: 'できませんでした。' }
}

/** 見られる人 of the 案件 a meeting is about to be linked to (said before the link). */
export type MeetingLinkReads = ElectronPort<'getViewers'>

export async function bundleViewers(companyId: string, bundleId: string, reads: MeetingLinkReads = window.electronAPI) {
  const r = await reads.getViewers(companyId, { records: [bundleId] }).catch(() => undefined)
  return r?.success ? r.answer.records[bundleId] ?? null : null
}

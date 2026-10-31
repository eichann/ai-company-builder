// 「別ウィンドウで開く」 in the main window's list: a consultation another
// window shows is listed as open (with that window's status, so あなたの番 /
// AIが作業中 / 新着 still count it), never as 終わったもの, and never mounted here.
import { closeStopsTheAI, type ChatWindowStatus } from '../../../shared/chat-windows'
import type { ConsultationStatus } from './consultationStatus'
import type { ConversationTab } from './conversationRows'

const WINDOW_TAB = 'window:'

/** The list's stand-in tabs for consultations shown in other windows (never mounted). */
export function windowTabs(windows: ReadonlyMap<string, ChatWindowStatus>, mountedTabs: readonly ConversationTab[]): ConversationTab[] {
  const mounted = new Set(mountedTabs.map(tab => tab.sessionId))
  return [...windows.keys()].filter(sessionId => !mounted.has(sessionId))
    .map(sessionId => ({ id: `${WINDOW_TAB}${sessionId}`, title: 'AIへの相談', sessionId }))
}

/** The consultation a stand-in tab names; undefined for a tab of this window. */
export function windowSessionOf(tabId: string): string | undefined {
  return tabId.startsWith(WINDOW_TAB) ? tabId.slice(WINDOW_TAB.length) : undefined
}

/** A row's status: its tab's here, the other window's for a stand-in. */
export function statusOfTab(tabId: string, local: ReadonlyMap<string, ConsultationStatus>, windows: ReadonlyMap<string, ChatWindowStatus>): ConsultationStatus | undefined {
  const sessionId = windowSessionOf(tabId)
  return sessionId !== undefined ? windows.get(sessionId) : local.get(tabId)
}

/**
 * A consultation moves to its own window only while its AI is not working
 * nor waiting for an answer: its turn runs in this window's page and would
 * stop when the tab goes.
 */
export function canMoveToWindow(status: ConsultationStatus | undefined): boolean {
  return !closeStopsTheAI(status)
}

export const MOVE_WHILE_WORKING = 'AIが作業中か、返事を待っています。終わってから別ウィンドウで開いてください。'

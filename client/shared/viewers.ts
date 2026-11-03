import type { ViewersAnswer, ViewersKind, ViewersLabel } from '../../shared/types/viewers'

/**
 * 見られる人 (who can see a record or a file) for the lists, read with the
 * member's session in main (IPC `viewers:get`; server `POST …/viewers`, the
 * phrase in shared/core/viewers.ts). Show the eye mark and `text`; 「あなただけ」
 * (`kind: 'only-you'`) with the lock. A record missing from the answer is one
 * the member cannot read: show nothing for it.
 */

export type { ViewersAnswer, ViewersKind, ViewersLabel }

/** What to ask about: record ids and company paths, at most 200 of each. */
export interface ViewersQuery {
  records?: string[]
  files?: string[]
}

export const VIEWERS_OFFLINE_TEXT = 'サーバーにつながらないため、見られる人を表示できません。つながると自動で読み直します。'

export type ViewersResult =
  | { success: true; answer: ViewersAnswer }
  | { success: false; offline: boolean; code: string | null; error: string }

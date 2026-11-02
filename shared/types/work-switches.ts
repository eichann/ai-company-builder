/**
 * Wire shapes of each member's own switches (自分の設定: 受信を読む, AI が自動で進める).
 * The rule is shared/core/work-switches.ts; the company's side (使ってよいか, 各自の
 * 初めの値) is in the task settings (`readIncoming`, `autoRun.enabled` / `memberDefault`).
 *
 *   GET /api/companies/:id/me/work-switches               → MyWorkSwitches
 *   PUT /api/companies/:id/me/work-switches { switch, on } → MyWorkSwitches
 *       400 bad body; 409 `WORK_SWITCH_COMPANY_OFF` turning on what the company does not allow
 */
import type { WorkSwitch, WorkSwitchState } from '../core/work-switches'

export type { WorkSwitch, WorkSwitchState }

export interface MyWorkSwitches {
  readIncoming: WorkSwitchState & {
    /**
     * What the member has let ACB read (shown only): `mail` = Google's 受信を読む granted,
     * `chat` = Slack's reading granted. On but neither → offer 「Google で許可」.
     */
    connected: { mail: boolean; chat: boolean }
  }
  autoRun: WorkSwitchState
  /**
   * The company's チームの進め方 (task settings `teamMode`, default off): the team's steps on a task
   * (引き受け待ち, 確かめる人・レビューと差し戻し, 受けられない, 返事待ち, 代わりの人) are offered.
   * The company's alone: no member choice, not changed through this route.
   */
  teamMode: { on: boolean }
  /**
   * Whether the company has mail / chat connected now: a usable connector serves the `mail` /
   * `chat` role (connector-roles.md). Neither → the app hides its 受信を読む switch and offers one
   * line on what connecting does (owner decision 2026-11-03). Absent (an older server, or the
   * roles could not be asked) → shown as before.
   */
  channels?: { mail: boolean; chat: boolean }
}

/** PUT body. */
export interface WorkSwitchChange {
  switch: WorkSwitch
  on: boolean
}

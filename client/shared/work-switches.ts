import type { MyWorkSwitches, WorkSwitch } from '../../shared/types/work-switches'

/**
 * 自分の設定 → 「受信を読む」「AI が自動で進める」 (owner decision 2026-11-02;
 * shared/core/work-switches.ts): the member's own two switches, read and changed
 * with the member's session in main (IPC `workSwitches:*`).
 *
 * A switch the company does not allow comes with `allowed: false`: shown greyed
 * out with 「会社の設定で止まっています」 (`WORK_SWITCH_COMPANY_OFF_TEXT`).
 */

export type { MyWorkSwitches, WorkSwitch }

export const WORK_SWITCHES_OFFLINE_TEXT = 'サーバーにつながらないため、いまは自分の設定を読み込めません。つながると自動で読み直します。'
export const WORK_SWITCH_COMPANY_OFF_TEXT = '会社の設定で止まっています'

export type WorkSwitchesFailure = { success: false; offline: boolean; code: string | null; error: string }

/** `workSwitches:get` / `workSwitches:set`: the member's switches as the server holds them now. */
export type WorkSwitchesResult = { success: true; switches: MyWorkSwitches } | WorkSwitchesFailure

/**
 * Whether the company has mail or chat connected (owner decision 2026-11-03: the task feature is
 * complete without Gmail / Slack; their parts show only when one is connected). The server's
 * `channels` (a usable connector for the `mail` or `chat` role); absent — an older server, or the
 * roles could not be asked — counts as connected, so nothing disappears on a failure.
 */
export function companyHasMailOrChat(switches: Pick<MyWorkSwitches, 'channels'>): boolean {
  return !switches.channels || switches.channels.mail || switches.channels.chat
}

/** 自分の設定's one line in place of 受信を読む while the company has neither (where connecting starts). */
export const CONNECT_MAIL_CHAT_TEXT = {
  title: 'Gmail・Slack をつなぐと、返事の追いかけを AI がします',
  body: '来た連絡から「返事のお願い」を作り、返事が来ないときは催促の下書きを用意します。管理者が会社の Google か Slack をつなぐと、ここでオンにできます。',
} as const

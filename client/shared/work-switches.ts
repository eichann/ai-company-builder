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

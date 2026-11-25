/**
 * Words and helpers for 「ブラウザ操作に使う PC」 and 「使える人」 (owner/admin; .claude/rules/agent-browser.md
 * "This PC's registration" and "Who may use a site"; PC-registration design memo v2 §7-2). The server decides everything
 * (the gate, who may change what); these only say it in plain Japanese. 「使える人」 speaks of registered sites and
 * 使わない / 見るだけ / 変えてよい only — never a site's job. Words: 「PC」 (never 「デバイス」), 「使えるようにする」 —
 * never 「開ける」, no hash or version shown.
 */
import { BROWSER_DEVICE_WORDS, type BrowserDeviceRevokeReason, type BrowserDeviceState } from '../../../shared/core/browser-device'
import {
  BROWSER_PERSON_LEVELS, effectiveBrowserPersonLevel, levelAllows, type BrowserOperationLevel, type BrowserPersonLevel,
} from '../../../shared/core/browser-operation'
import type { BrowserDevicesList, BrowserSiteGrantsView } from './api'

// ---------------------------------------------------------------------------
// 「ブラウザ操作に使う PC」
// ---------------------------------------------------------------------------

export const PCS_TITLE = 'ブラウザ操作に使う PC'

export const PCS_INTRO =
  'メンバーがアプリで「この PC を登録する」を押すと、ここに「確認待ち」で出ます。本人の PC だと確かめてから［使えるようにする］を押してください。AI のブラウザ操作は、使えるようにした PC からしか動きません。'

export const PC_STATE_LABELS: Record<BrowserDeviceState, string> = BROWSER_DEVICE_WORDS.states

/** The badge of each state: waiting for the admin = awaiting; usable = success; stopped on purpose = paused (design-system.md). */
export const PC_STATE_BADGE = { pending: 'awaiting', enabled: 'success', revoked: 'paused' } as const satisfies Record<BrowserDeviceState, string>

export const PC_REVOKE_REASONS: Record<BrowserDeviceRevokeReason, string> = {
  admin: '管理者が止めました',
  self: '本人が利用をやめました',
  left: '会社を抜けたので止まりました',
}

export const PC_ENABLE_HELP = '使えるようにした PC でも、AI に任せられるのは「使える人」で選んだサイトと使い方だけです。'

export function pcEnableSentence(person: string, label: string): string {
  return `${person}さんの「${label}」を使えるようにします。`
}

/** What 止める does, said plainly before it is pressed (design memo §7-2). */
export const PC_STOP_EFFECTS = [
  'この PC からの新しい頼みは、すぐに断られます。',
  'ちょうど送ろうとしていた1回は送られることがあります。',
  '途中の作業は、次の書き込みの前で止まります。',
  'もう一度使うには、本人がアプリで登録し直し、管理者がもう一度使えるようにします。',
] as const

export function pcStopTitle(person: string, label: string): string {
  return `${person}さんの「${label}」を止めますか？`
}

export const PC_HISTORY_ACTIONS: Record<BrowserDevicesList['history'][number]['action'], string> = {
  request: '登録を申し込みました',
  enable: '使えるようにしました',
  revoke: '止めました',
}

/** One history line: 「〇〇さんが △△さんの『PC』を使えるようにしました」 (who, which PC, what). */
export function pcHistoryLine(
  entry: BrowserDevicesList['history'][number],
  nameOf: (userId: string) => string,
  labelOf: (deviceId: string) => string | null,
): string {
  const pc = labelOf(entry.deviceId)
  const what = pc ? `「${pc}」` : 'PC'
  if (entry.action === 'revoke' && entry.reason === 'left') return `${nameOf(entry.userId)}さんの${what}は、会社を抜けたので止まりました`
  if (entry.action === 'revoke' && entry.reason === 'self') return `${nameOf(entry.userId)}さんが${what}での利用をやめました`
  if (entry.action === 'request') return `${nameOf(entry.userId)}さんが${what}の${PC_HISTORY_ACTIONS.request}`
  return `${nameOf(entry.actorId)}さんが ${nameOf(entry.userId)}さんの${what}を${PC_HISTORY_ACTIONS[entry.action]}`
}

// ---------------------------------------------------------------------------
// 「使える人」 (per registered site: agent-browser.md "Who may use a site")
// ---------------------------------------------------------------------------

export const PEOPLE_TITLE = 'ブラウザ操作を使える人'

export const PEOPLE_INTRO =
  '登録したサイトごとに、AI にどこまで任せてよいかを人ごとに選びます。サイトを登録すると、全員「見るだけ」から始まります。「変えてよい」は1人ずつ選んでください。選んだ人も、使えるようにした PC からしか使えません。'

export const PEOPLE_COMPANY_OFF =
  '会社全体のブラウザ操作が「使わない」なので、「メンバーごとの動作」で「使う」にした人のほかは、選んでも今は使えません。'

export const PEOPLE_NO_PC = '使えるようにした PC はまだありません'

export const PEOPLE_NO_SITES = 'ブラウザ操作で使うサイトが、まだ登録されていません。「ブラウザ操作」でサイトを登録してください。'

/** Each person level in plain words (使わない / 見るだけ / 変えてよい). */
export const PERSON_LEVEL_LABELS: Record<BrowserPersonLevel, string> = {
  none: '使わない',
  read: '見るだけ',
  write: '変えてよい',
}

export const PERSON_LEVELS: readonly BrowserPersonLevel[] = BROWSER_PERSON_LEVELS

/** Under a column whose site the company set to 見るだけ: nobody can be 変えてよい there. */
export const PEOPLE_SITE_READ_ONLY = '会社の設定が「見るだけ」のサイトです'

/** In a cell whose person was set to 変えてよい before the company lowered the site to 見るだけ. */
export const PEOPLE_CAPPED = 'いまは会社の設定で「見るだけ」です'

export const PEOPLE_CHANGE_NOTE = '選ぶとすぐに変わります。「使わない」にすると、その人はそのサイトを AI に任せられなくなります。'

/** The person's chosen level on a site (no choice = the default, 見るだけ). */
export function personLevelOf(view: BrowserSiteGrantsView, userId: string, host: string): BrowserPersonLevel {
  return view.grants.find((g) => g.userId === userId && g.host === host)?.level ?? view.defaultLevel
}

/** What applies: the chosen level capped by the site's level (the server's rule, shared/core). */
export function effectiveLevelOf(view: BrowserSiteGrantsView, userId: string, site: { host: string; level: BrowserOperationLevel }): BrowserPersonLevel {
  return effectiveBrowserPersonLevel(personLevelOf(view, userId, site.host), site.level)
}

/** Whether 変えてよい can be chosen on this site (the company's level allows writing). */
export function writeChoosable(site: { level: BrowserOperationLevel }): boolean {
  return levelAllows(site.level, 'write')
}

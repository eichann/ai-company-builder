/**
 * Words and helpers for 「ブラウザ操作に使う PC」 and 「使える人」 (owner/admin; .claude/rules/agent-browser.md
 * "This PC's registration" and "Per-line grants"; PC-registration design memo v2 §7-2). The server decides everything
 * (the gate, who may change what); these only say it in plain Japanese and work out which grant call a tick means.
 * Words: 「PC」 (never 「デバイス」), 「使えるようにする」, 「作業」 — never 「開ける」, no hash or version shown.
 */
import { BROWSER_DEVICE_WORDS, type BrowserDeviceRevokeReason, type BrowserDeviceState } from '../../../shared/core/browser-device'
import type { BrowserDevicesList, BrowserLineGrantsView, BrowserLineRef } from './api'

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

export const PC_ENABLE_HELP = '使えるようにした PC でも、AI に任せられるのは「使える人」で選んだ作業だけです。'

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
// 「使える人」
// ---------------------------------------------------------------------------

export const PEOPLE_TITLE = 'ブラウザ操作を使える人'

export const PEOPLE_INTRO = 'AI に任せてよい作業を、人ごとに選びます。選んだ人も、使えるようにした PC からしか使えません。'

export const PEOPLE_COMPANY_OFF =
  '会社全体のブラウザ操作が「使わない」なので、「メンバーごとの動作」で「使う」にした人のほかは、選んでも今は使えません。'

export const PEOPLE_NO_PC = '使えるようにした PC はまだありません'

export const PEOPLE_WAITING = 'まだ使えません（確かめ待ち）'

export const PEOPLE_CHANGED = 'この作業は内容が変わりました。使える人を選び直してください。'

export const PEOPLE_UNTICK_NOTE = 'チェックを外すと、その人はこの作業をすぐに使えなくなります（前の版で使えるようにしていた分も含めて）。'

export function lineKindLabel(writes: boolean): string {
  return writes ? '書き込む' : '見るだけ'
}

/**
 * One column of the table: a 作業 (a site's line). `rows` are its approved rows that share the newest approved row's
 * meaning, oldest first; `target` is the newest. A line with no approved row yet is `waiting` (shown greyed, no box).
 */
export type PeopleColumn =
  | { kind: 'usable'; key: string; site: string; line: string; label: string; writes: boolean; target: BrowserLineRef; rows: BrowserLineRef[] }
  | { kind: 'waiting'; key: string; site: string; line: string; label: string; writes: boolean }

const versionParts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
function compareVersions(a: string, b: string): number {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
/** Oldest first: the line's own version, then its map's. */
function compareRows(a: BrowserLineRef, b: BrowserLineRef): number {
  return compareVersions(a.version, b.version) || compareVersions(a.mapVersion, b.mapVersion)
}

const refOf = (r: BrowserLineRef): BrowserLineRef => ({
  site: r.site, line: r.line, version: r.version, mapVersion: r.mapVersion, meaningHash: r.meaningHash, mechanicsHash: r.mechanicsHash,
})
const sameRow = (a: BrowserLineRef, b: BrowserLineRef) =>
  a.site === b.site && a.line === b.line && a.version === b.version && a.mapVersion === b.mapVersion
  && a.meaningHash === b.meaningHash && a.mechanicsHash === b.mechanicsHash

/** The table's columns: usable 作業 first (in the server's order), then those still waiting for their review. */
export function peopleColumns(view: BrowserLineGrantsView): PeopleColumn[] {
  const columns: PeopleColumn[] = []
  const seen = new Set<string>()
  for (const l of view.lines) {
    const key = `${l.site}/${l.line}`
    if (seen.has(key)) continue
    seen.add(key)
    const all = view.lines.filter((x) => x.site === l.site && x.line === l.line).sort(compareRows)
    const newest = all[all.length - 1]
    const rows = all.filter((x) => x.meaningHash === newest.meaningHash).map(refOf)
    columns.push({ kind: 'usable', key, site: l.site, line: l.line, label: newest.label, writes: newest.writes, target: refOf(newest), rows })
  }
  for (const w of view.waiting) {
    const key = `${w.site}/${w.line}`
    if (seen.has(key)) continue
    seen.add(key)
    columns.push({ kind: 'waiting', key, site: w.site, line: w.line, label: w.label, writes: w.writes })
  }
  return columns
}

const inForce = (view: BrowserLineGrantsView, userId: string, row: BrowserLineRef) =>
  view.grants.some((g) => g.userId === userId && sameRow(g, row))

/**
 * Ticked: the person holds a grant in force on **any** approved row of the 作業 (any meaning) — so whatever the server
 * still lets them use is never shown unticked, and the untick (which takes every grant on the line away) is always one
 * press away (Codex review). `partial` when that does not include the newest row: the box is ticked, the cell says so,
 * and choosing again is untick + tick.
 */
export function isTicked(view: BrowserLineGrantsView, column: PeopleColumn, userId: string): boolean {
  return column.kind === 'usable' && view.grants.some((g) => g.userId === userId && g.site === column.site && g.line === column.line)
}

/** Ticked, but not on the newest approved row (an earlier content, or a fill that stopped halfway). */
export function isPartial(view: BrowserLineGrantsView, column: PeopleColumn, userId: string): boolean {
  return column.kind === 'usable' && isTicked(view, column, userId) && !column.rows.every((r) => inForce(view, userId, r))
}

export const PEOPLE_PARTIAL = '前の内容でだけ使えます'

/**
 * The next row to grant when the box is ticked: the oldest of the 作業's rows (same meaning) on which the person holds
 * no grant in force, or null when every one is covered. Granting the oldest first lets a row's reviewed carry-over
 * (grantsFrom) cover the newer ones, so usually one call does it; an app still on an older map's version can then use
 * the 作業 too. Only approved rows of this very 作業 and meaning are ever sent.
 */
export function nextGrantRow(view: BrowserLineGrantsView, column: PeopleColumn, userId: string): BrowserLineRef | null {
  if (column.kind !== 'usable') return null
  return column.rows.find((r) => !inForce(view, userId, r)) ?? null
}

/**
 * People who could use an earlier meaning of the 作業 but not this one (its content changed and no review called it
 * compatible): the column says to choose again.
 */
export function changedFor(view: BrowserLineGrantsView, column: PeopleColumn): boolean {
  if (column.kind !== 'usable') return false
  return view.grants.some((g) => g.site === column.site && g.line === column.line && g.meaningHash !== column.target.meaningHash
    && !inForce(view, g.userId, column.target))
}

/**
 * Words and draft helpers for the 「ブラウザ操作」 page (the company's browser-operation
 * setting, .claude/rules/agent-browser.md). Validation is shared/core/browser-operation.ts,
 * the server's own copy.
 */
import {
  BROWSER_OPERATION_LEVELS,
  BROWSER_OPERATION_LIMITS,
  normalizeBrowserHost,
  type BrowserOperationLevel,
  type BrowserOperationMode,
  type BrowserOperationSettings,
} from '../../../shared/core/browser-operation'
import { linesOf } from './agent-sandbox'

export const BROWSER_TITLE = 'ブラウザ操作'

export const BROWSER_INTRO =
  'AI への相談の中で、AI が会社の決めたサイトを操作できるようにします。AI が触れるのは下の一覧のサイトだけで、サイトごとに用意された決まった操作の手順だけを使います（自由にクリックして回ることはしません）。'

export const BROWSER_MODES: BrowserOperationMode[] = ['off', 'on']

export const BROWSER_MODE_LABELS: Record<BrowserOperationMode, string> = {
  off: '使わない',
  on: '使う',
}

export const BROWSER_MODE_HELP: Record<BrowserOperationMode, string> = {
  off: 'AI はサイトを操作しません。これまでどおりです。',
  on: '下の一覧のサイトだけ、AI が決まった手順で操作できます。',
}

export const BROWSER_LEVELS: readonly BrowserOperationLevel[] = BROWSER_OPERATION_LEVELS

export const BROWSER_LEVEL_LABELS: Record<BrowserOperationLevel, string> = {
  read: '見るだけ',
  write: '入力・保存まで',
  delete: '削除も',
}

export const BROWSER_LEVEL_HELP: Record<BrowserOperationLevel, string> = {
  read: '画面を開いて読むだけです。何も変えません。',
  write: '入力して保存するところまでできます。削除はしません。',
  delete: '削除を含む操作もできます。',
}

export const BROWSER_SITES_HELP =
  '「操作するサイト」は AI が操作するサイトのアドレス（例: crm.example.com）です。「画面の部品を取る先」は、そのサイトの画面を表示するのに必要な部品（画像・文字の形・見た目の設定など）を読み込む先で、1行に1つ書きます。部品を取る先からは読み込むだけで、そこで何かを操作することはありません。'

export const BROWSER_LOGIN_NOTE =
  'サイトへのログインは、「AI の囲い」が「囲う」になっているメンバーの PC にだけ保存されます。それ以外のメンバーは、アプリを起動し直すたびにログインし直します（AI が実行するコマンドからログイン情報を読まれないようにするためです）。'

export const BROWSER_HOST_RULE = '「*」・IP アドレス・localhost・https:// やパスは書けません'

export const BROWSER_SITE_LIMIT = BROWSER_OPERATION_LIMITS.sites

/** One site as the page edits it: the parts hosts as one-per-line text. */
export interface SiteDraft {
  host: string
  level: BrowserOperationLevel
  assetHosts: string
}

export function siteDrafts(settings: BrowserOperationSettings): SiteDraft[] {
  return settings.sites.map((s) => ({ host: s.host, level: s.level, assetHosts: s.assetHosts.join('\n') }))
}

/** What is wrong with one site (empty = fine), in words for the page. */
export function siteProblems(site: SiteDraft, others: SiteDraft[]): string[] {
  const problems: string[] = []
  const host = normalizeBrowserHost(site.host.trim())
  if (!site.host.trim()) problems.push('操作するサイトを書いてください')
  else if (!host) problems.push(`操作するサイトに使えない書き方があります: ${site.host.trim()}（${BROWSER_HOST_RULE}）`)
  else if (others.some((o) => normalizeBrowserHost(o.host.trim()) === host)) problems.push(`同じサイトが2回あります: ${host}`)
  const assets = linesOf(site.assetHosts)
  const bad = assets.filter((l) => !normalizeBrowserHost(l))
  if (bad.length) problems.push(`画面の部品を取る先に使えない書き方があります: ${bad.join('、')}（${BROWSER_HOST_RULE}）`)
  if (host && assets.some((l) => normalizeBrowserHost(l) === host)) problems.push('操作するサイトは、画面の部品を取る先に書けません')
  if (assets.length > BROWSER_OPERATION_LIMITS.assetHosts) problems.push(`画面の部品を取る先は ${BROWSER_OPERATION_LIMITS.assetHosts} 個までです`)
  return problems
}

/** What the draft would save (normalized, parts hosts de-duplicated). */
export function draftBrowserSettings(mode: BrowserOperationMode, sites: SiteDraft[]): BrowserOperationSettings {
  return {
    mode,
    sites: sites.map((s) => ({
      host: normalizeBrowserHost(s.host.trim()) ?? s.host.trim(),
      level: s.level,
      assetHosts: [...new Set(linesOf(s.assetHosts).map((l) => normalizeBrowserHost(l) ?? l))],
    })),
  }
}

/** 「動作: 使わない → 使う」 lines for what changes. */
export function browserChangeLines(before: BrowserOperationSettings, after: BrowserOperationSettings): string[] {
  const lines: string[] = []
  if (before.mode !== after.mode) lines.push(`動作: ${BROWSER_MODE_LABELS[before.mode]} → ${BROWSER_MODE_LABELS[after.mode]}`)
  const byHost = (s: BrowserOperationSettings) => new Map(s.sites.map((x) => [x.host, x]))
  const a = byHost(before)
  const b = byHost(after)
  for (const [host, site] of b) {
    const old = a.get(host)
    if (!old) {
      lines.push(`サイトを追加: ${host}（${BROWSER_LEVEL_LABELS[site.level]}）`)
      continue
    }
    if (old.level !== site.level) lines.push(`${host} の段階: ${BROWSER_LEVEL_LABELS[old.level]} → ${BROWSER_LEVEL_LABELS[site.level]}`)
    const added = site.assetHosts.filter((x) => !old.assetHosts.includes(x))
    const removed = old.assetHosts.filter((x) => !site.assetHosts.includes(x))
    if (added.length) lines.push(`${host} の部品を取る先に追加: ${added.join('、')}`)
    if (removed.length) lines.push(`${host} の部品を取る先から削除: ${removed.join('、')}`)
  }
  for (const host of a.keys()) if (!b.has(host)) lines.push(`サイトを削除: ${host}`)
  return lines
}

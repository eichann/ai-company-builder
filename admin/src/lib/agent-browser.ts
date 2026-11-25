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
import { BROWSER_SITE_PARTS_LIMITS, parseBrowserSiteParts, type BrowserSiteParts } from '../../../shared/core/browser-site-parts'
import { linesOf } from './agent-sandbox'

export const BROWSER_TITLE = 'ブラウザ操作'

export const BROWSER_INTRO =
  'AI への相談の中で、AI が会社の決めたサイトを操作できるようにします。AI が触れるのは下の一覧のサイトだけで、サイトごとに用意された決まった操作の手順だけを使います（自由にクリックして回ることはしません）。'

/** Shown by the mode choice until the AI operates sites (then removed: agent-browser.md). */
export const BROWSER_NOT_YET_NOTE = '今「使う」にすると、メンバーはアプリの設定から一覧のサイトを開いてログインできます。AI がサイトを操作する機能は準備中です。'

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
  read: '閲覧のみです。画面を開いて読み、何も変えません。',
  write: '入力して保存するところまでできます。削除はしません。',
  delete: '削除を含む操作もできます。',
}

export const BROWSER_SITES_HELP =
  '「操作するサイト」は AI が操作するサイトのアドレス（例: crm.example.com）です。'

/**
 * Since redesign step ② where a domain's pages load their parts from — and what its login needs — is the
 * company's setting of that domain (each site's 「詳しい設定」, agent-browser.md "A domain's parts and login
 * helpers"); a domain without one uses what the app carries, if anything.
 */
export const BROWSER_PARTS_NOTE =
  '画面の表示に使う部品（画像・文字の形など）を読み込む先と、ログインの確かめに使う先は、保存したサイトごとの「詳しい設定」で決めます。書いていないサイトは、アプリに入っている決まりがあればそれを使います。部品の読み込み先からは読み込むだけで、それ以外の通信は止めます。'

/** A domain's 「詳しい設定」 (the parts hosts and login helpers; agent-browser.md "A domain's parts and login helpers"). */
export const SITE_PARTS_TITLE = '詳しい設定'

export const SITE_PARTS_INTRO =
  'サイトを見ながら作業を記録したものを読んで、必要な先だけを書きます。何も書かずに保存すると、このサイトでは部品もログインの補助も使いません（アプリに入っている決まりも使いません）。'

/** Shown while the domain has no setting of its own: what the app carries applies. */
export const SITE_PARTS_APP_DEFAULT_NOTE = 'まだ書いていません。今は、アプリに入っている決まりがあればそれを使います。'

export const SITE_PARTS_APP_DEFAULT_BUTTON = 'アプリに入っている決まりに戻す'

export const SITE_PARTS_ASSETS_HELP =
  'このサイトの画面が、画像・文字の形・見た目の部品を読み込む先です。1行に1つ書きます。読み込むだけで、AI がその先を開いたり、何かを送ったりすることはありません。'

export const SITE_PARTS_HELPERS_HELP =
  '人がログインするときだけ使う先です（ログインの確かめの画面など）。書いた道の中だけを使い、AI が操作している間は使いません。'

export const SITE_PARTS_FRAME_LABEL = '画面の中に表示してよい'
export const SITE_PARTS_POST_LABEL = '確かめの答えを送ってよい'

/** Per parts host: its programs (scripts) load too — only for hosts the company trusts. */
export const SITE_PARTS_SCRIPT_LABEL = 'プログラムも読み込む'
export const SITE_PARTS_SCRIPT_WARNING =
  'この先のプログラムは、メンバーのログインのまま、サイトの画面の中で動きます。会社が信頼している先だけにしてください。'

/** Next to 「確かめの答えを送ってよい」: the login page may send there what is typed on it. */
export const SITE_PARTS_POST_WARNING = `ログインの画面に入力したものを、この先へ送れるようになります。ログインの確かめに必要な先だけにしてください（「画面の中に表示してよい」も必要で、道は /check/api/ のように ${BROWSER_SITE_PARTS_LIMITS.postHelperSegments} 段以上にします）。`
export const SITE_PARTS_HELPER_LIMIT = BROWSER_SITE_PARTS_LIMITS.loginHelpers

/** One login helper as the form edits it. */
export interface HelperDraft {
  host: string
  pathPrefix: string
  frame: boolean
  post: boolean
}

/** A domain's 「詳しい設定」 as the form edits it: the parts hosts as one-per-line text, the ticked script hosts. */
export interface SitePartsDraft {
  assetHosts: string
  scriptHosts: string[]
  loginHelpers: HelperDraft[]
}

export function sitePartsDraft(saved: BrowserSiteParts | undefined): SitePartsDraft {
  return {
    assetHosts: (saved?.assetHosts ?? []).join('\n'),
    scriptHosts: [...(saved?.scriptHosts ?? [])],
    loginHelpers: (saved?.loginHelpers ?? []).map((h) => ({ ...h })),
  }
}

/** The parts hosts the draft lists now (normalized, once each): the rows a 「プログラムも読み込む」 tick belongs to. */
export function draftPartsHosts(draft: SitePartsDraft): string[] {
  return [...new Set(linesOf(draft.assetHosts).map(hostOf))]
}

function hostOf(line: string) {
  return normalizeBrowserHost(line.trim()) ?? line.trim()
}

/** What the draft would save for `host` (hosts normalized, parts hosts de-duplicated; a tick only for a listed host). */
export function sitePartsBody(host: string, draft: SitePartsDraft): BrowserSiteParts {
  const assetHosts = draftPartsHosts(draft)
  return {
    host,
    assetHosts,
    scriptHosts: assetHosts.filter((h) => draft.scriptHosts.includes(h)),
    loginHelpers: draft.loginHelpers.map((h) => ({ host: hostOf(h.host), pathPrefix: h.pathPrefix.trim(), frame: h.frame, post: h.post })),
  }
}

/**
 * What is wrong with the draft (empty = fine), in words for the page: the server's own rule
 * (`parseBrowserSiteParts`) against the saved sites' hosts.
 */
export function sitePartsProblems(body: BrowserSiteParts, savedHosts: readonly string[]): string[] {
  if (body.loginHelpers.some((h) => !h.host)) return ['ログインの補助のアドレスを書いてください']
  const parsed = parseBrowserSiteParts(body, savedHosts)
  if (!('error' in parsed)) return []
  const at = parsed.at ?? ''
  switch (parsed.problem) {
    case 'not-registered': return ['このサイトはまだ保存されていません。先に下の「保存」をしてください']
    case 'bad-host': return [`使えない書き方があります: ${at}（${BROWSER_HOST_RULE}）`]
    case 'operated': return [`操作するサイトとして登録したアドレスは、ここには書けません: ${at}`]
    case 'twice': return [`同じアドレスが2回あります: ${at}（部品の読み込み先とログインの補助の両方にも書けません）`]
    case 'too-many': return [`部品の読み込み先は ${BROWSER_SITE_PARTS_LIMITS.assetHosts} 個まで、ログインの補助は ${BROWSER_SITE_PARTS_LIMITS.loginHelpers} 個までです`]
    case 'bad-path': return [`ログインの補助の道は / で始まり / で終わる形で書いてください（例: /check/）: ${at}`]
    case 'post-needs-frame': return [`確かめの答えを送る先は、「${SITE_PARTS_FRAME_LABEL}」も選んでください: ${at}`]
    case 'post-path-short': return [`確かめの答えを送る先の道は、/check/api/ のように ${BROWSER_SITE_PARTS_LIMITS.postHelperSegments} 段以上にしてください: ${at}`]
    case 'script-not-part': return [`プログラムを読み込む先は、部品の読み込み先の中から選んでください: ${at}`]
    default: return ['書き方が正しくありません']
  }
}

/** Lines for a domain's 「詳しい設定」 in the history. */
export function sitePartsChangeLines(host: string, before: BrowserSiteParts | null, after: BrowserSiteParts | null): string[] {
  const list = (p: BrowserSiteParts | null) =>
    (p && p.assetHosts.length ? p.assetHosts.map((h) => (p.scriptHosts.includes(h) ? `${h}（プログラムも）` : h)).join('、') : 'なし')
  const helper = (h: BrowserSiteParts['loginHelpers'][number]) =>
    `${h.host}${h.pathPrefix}${h.frame ? '（表示）' : ''}${h.post ? '（送信）' : ''}`
  const helpers = (p: BrowserSiteParts | null) => (p && p.loginHelpers.length ? p.loginHelpers.map(helper).join('、') : 'なし')
  if (!after) return [`${host} の詳しい設定を、アプリに入っている決まりに戻しました`]
  const lines: string[] = []
  if (list(before) !== list(after)) lines.push(`${host} の部品の読み込み先: ${list(before)} → ${list(after)}`)
  if (helpers(before) !== helpers(after)) lines.push(`${host} のログインの補助: ${helpers(before)} → ${helpers(after)}`)
  return lines
}

/**
 * The company's free-text parts hosts are a developer setting (owner decision 2026-11-23: kept, not
 * shown in the normal console). Shown only in a console built with NEXT_PUBLIC_ACB_BROWSER_DEVELOPER=1
 * (Next inlines it at build time; the production image does not set it), and honoured only by a
 * development build of the app started with ACB_BROWSER_DEVELOPER_ASSET_HOSTS=1.
 */
export function developerAssetHostsShown(): boolean {
  return process.env.NEXT_PUBLIC_ACB_BROWSER_DEVELOPER === '1'
}

export const BROWSER_DEVELOPER_PARTS_HELP =
  '開発用の設定です。サイトの決まりにない部品の読み込み先を、開発中のアプリでだけ足します（ふつうのアプリでは使いません）。1行に1つ書きます。'

/**
 * What an admin wrote before plan B stays stored and shown, read only, with 「前に書いたものを消す」: a
 * current app ignores it, an app from before plan B still loads from it until it is updated.
 */
export const BROWSER_STORED_PARTS_NOTE =
  '今のアプリでは使いません。更新していない古いアプリは、更新されるまでこの先からも部品を読み込みます。要らなければ消してください。'

export const BROWSER_LOGIN_NOTE =
  'サイトへのログインを PC に覚えておけるのは、「AI の囲い」が「囲う」で、そのサイトを使えるメンバーだけです（アプリを起動し直してもそのままです）。それ以外のメンバーは、起動し直すたびにログインし直します。囲いのない AI がその PC で動くときは、覚えていたログインを先に消します（AI が実行するコマンドからログイン情報を読まれないようにするためです）。古いアプリはこれまでどおり覚えません。'

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

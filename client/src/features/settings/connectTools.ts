// 「仕事の道具をつなぐ」 (google-connector.md "One consent"): when the screen offers itself, what
// it lists, and what to tell after Google's page. Pure: the screen and its tests use it.
import type { GoogleFeature, MyGoogle } from '../../../shared/google'
import type { MySlack, SlackFeature } from '../../../shared/slack'
import { SLACK_SETUP_FEATURES } from '../../../../shared/core/slack'

/** What each Google feature does for the member, in their words (not the permission's name). */
export const TOOL_GOOGLE_TEXT: Record<GoogleFeature, string> = {
  minutes: '予定が一覧に出て、会議の議事録を AI が読めます',
  mail: 'AI が書いたメールを、あなたが確かめてから送れます',
  drive: '選んだ Drive のフォルダに、作った資料を置けます',
  inbox: '届いたメールから、やることを作れます',
  sheets: 'あなたが編集できる表に、AI のスクリプトが読み書きできます（消す操作は通しません）',
  inbox_archive: 'ACB で済んだメールを、Gmail でもアーカイブします（消したり送ったりはしません）',
}

export const TOOL_SLACK_TEXT: Record<SlackFeature, string> = {
  read: '自分あての Slack の DM やメンションを確かめられます',
  reply: 'Slack に返事を送れます',
  notices: '大事な知らせが Slack の DM で届きます',
}

export type ToolState = 'connected' | 'not-connected'

export interface ConnectToolItem<F extends string> {
  feature: F
  text: string
  state: ToolState
}

/**
 * Whether the screen opens by itself, decided once when the state has loaded (and kept while
 * the member connects, so the screen does not change under them): `null` = stays closed.
 * `only` = shown before, so it lists only what the company added since (「新しくつなぐもの」).
 */
export type ConnectToolsOffer = { only: { google: GoogleFeature[]; slack: boolean } | null } | null

export interface ConnectToolsView {
  onlyNew: boolean
  google: { items: ConnectToolItem<GoogleFeature>[]; canConnect: boolean; account: string | null; domainHint: string | null } | null
  slack: { items: ConnectToolItem<SlackFeature>[]; canConnect: boolean } | null
}

const list = <T>(v: readonly T[] | undefined): readonly T[] => v ?? []

/** Offered and never shown: what makes the screen open by itself. */
export function newGoogleFeatures(g: MyGoogle | null): GoogleFeature[] {
  if (!g || !g.available) return []
  return list(g.companyFeatures).filter(f => !g.features.includes(f) && !list(g.seen).includes(f))
}

export function newSlackFeatures(s: MySlack | null): SlackFeature[] {
  if (!s || !s.available || s.connected) return []
  return SLACK_SETUP_FEATURES.filter(f => !list(s.seen).includes(f))
}

/** Opens by itself only for what the company offers and the member was never shown. */
export function connectToolsOffer(g: MyGoogle | null, s: MySlack | null): ConnectToolsOffer {
  const gNew = newGoogleFeatures(g)
  const sNew = newSlackFeatures(s)
  if (gNew.length === 0 && sNew.length === 0) return null
  const shownBefore = list(g?.seen).length > 0 || list(s?.seen).length > 0
  return { only: shownBefore ? { google: gNew, slack: sNew.length > 0 } : null }
}

/**
 * The screen for the member's state: everything the company offers, or (`only`, the latched
 * offer of a later first run) just what was new when it opened.
 */
export function connectToolsView(g: MyGoogle | null, s: MySlack | null, only: { google: GoogleFeature[]; slack: boolean } | null = null): ConnectToolsView {
  let google: ConnectToolsView['google'] = null
  const features = only ? only.google : list(g?.companyFeatures)
  if (g?.available && features.length > 0) {
    google = {
      items: features.map(f => ({ feature: f, text: TOOL_GOOGLE_TEXT[f], state: g.features.includes(f) ? 'connected' : 'not-connected' })),
      canConnect: list(g.companyFeatures).some(f => !g.features.includes(f)),
      account: g.connected ? g.googleEmail : null,
      domainHint: g.domain ? `会社の Google アカウント（@${g.domain}）で、ACB に登録しているのと同じメールアドレスのものを選んでください。` : null,
    }
  }

  let slack: ConnectToolsView['slack'] = null
  if (s?.available && (!only || only.slack)) {
    slack = {
      items: SLACK_SETUP_FEATURES.map(f => ({ feature: f, text: TOOL_SLACK_TEXT[f], state: s.features.includes(f) ? 'connected' : 'not-connected' })),
      canConnect: !s.connected,
    }
  }
  return { onlyNew: only !== null, google, slack }
}

/**
 * After Google's page: what was asked and is still missing (the member unticked it, or closed
 * the page). Told plainly once; nothing is asked again by itself (no loop).
 */
export function googleDeclined(asked: readonly GoogleFeature[], after: MyGoogle): GoogleFeature[] {
  return asked.filter(f => !after.features.includes(f))
}

export function googleDeclinedText(declined: readonly GoogleFeature[]): string | null {
  if (declined.length === 0) return null
  return `次のことは、Google の画面で許可されなかったため使えません：${declined.map(f => TOOL_GOOGLE_TEXT[f].replace(/ます$/, 'る')).join('／')}。使いたくなったら、設定の「仕事の道具をつなぐ」からもう一度つなげます。`
}

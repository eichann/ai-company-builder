/**
 * The words members see for the things in the app (「新しい画面のデモ（言葉の決まり）」, owner
 * 2026-11-02): one plain name per kind of thing — never 「型」, a category (「やりとり」,
 * 「まとまり」), an id or a type's machine name — the states in everyday words, what to do next,
 * and the calm one-liners for waiting, empty and failing. Every screen (the task list, search,
 * ⌘K, the record tabs, 「あなたの番」) takes its words from here, so they stay the same
 * everywhere. Pure: main, the renderer and tests import it. The icons are
 * `src/shared/ui/ThingIcon.tsx`.
 */

/** What a member can open, by how it is shown (one icon and one name each). */
export type ThingKind =
  | 'task' | 'minutes_check' | 'meeting' | 'decision' | 'incoming' | 'outbound' | 'sent'
  | 'approval' | 'reply_request' | 'bundle' | 'consultation' | 'skill' | 'counterpart' | 'file' | 'folder' | 'other'

/** The fixed names; `bundle` and `other` are named by their type's own label (案件, 番組, プロジェクト…). */
export const THING_NAMES: Readonly<Record<Exclude<ThingKind, 'bundle' | 'other'>, string>> = {
  task: 'やること',
  minutes_check: '議事録を確認する',
  meeting: '会議の記録',
  decision: '決めたこと',
  incoming: '来た連絡',
  outbound: '送るメールの下書き',
  sent: '送ったもの',
  approval: '承認のお願い',
  reply_request: '返事のお願い',
  consultation: 'AIへの相談',
  skill: 'スキル',
  counterpart: '相手',
  file: 'ファイル',
  folder: 'フォルダ',
}

/** A record as far as its look goes: its type, the type's label and interfaces, its state. */
export interface ThingRecord {
  type: string
  /** The type's own label from its definition (案件, 番組…); used for types the core does not name. */
  typeLabel?: string | null
  implements?: readonly string[]
  state?: string | null
  /** An outbound message's channel (`slack` → 「送る Slack の返事」). */
  channel?: string | null
  /** A task that is a meeting's 「議事録を確認する」. */
  minutesCheck?: boolean
}

const SENT_STATES = new Set(['sent', 'unknown'])

/** The kind a record is shown as. A business plugin's type implementing `bundle` is a `bundle`. */
export function thingKindOf(r: ThingRecord): ThingKind {
  switch (r.type) {
    case 'task': return r.minutesCheck ? 'minutes_check' : 'task'
    case 'meeting': return 'meeting'
    case 'decision': return 'decision'
    case 'interaction': return 'incoming'
    case 'outbound_message': return r.state && SENT_STATES.has(r.state) ? 'sent' : 'outbound'
    case 'approval': return 'approval'
    case 'reply_request': return 'reply_request'
  }
  if (r.implements?.includes('bundle')) return 'bundle'
  if (r.implements?.includes('counterpart')) return 'counterpart'
  return 'other'
}

/** The plain name of a record's kind: the core's own words, a company's or plugin's type by its label. */
export function thingName(r: ThingRecord): string {
  const kind = thingKindOf(r)
  if (kind === 'outbound' && r.channel === 'slack') return '送る Slack の返事'
  if (kind === 'counterpart' || kind === 'bundle' || kind === 'other') return label(r.typeLabel) ?? (kind === 'counterpart' ? THING_NAMES.counterpart : '記録')
  return THING_NAMES[kind]
}

const label = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null)

/** Which picture a bundle type gets: its own label decides (the core never names a plugin's type). */
export function bundleLook(typeLabel: string | null | undefined): 'deal' | 'program' | 'project' {
  const l = typeLabel ?? ''
  if (/案件|商談|取引/.test(l)) return 'deal'
  if (/番組|企画|制作/.test(l)) return 'program'
  return 'project'
}

/**
 * Where bundles of several kinds mix (the member's own list, search across departments): the kinds
 * actually there, joined (「案件・プロジェクト」). One kind → its name; none → the company's word.
 */
export function bundleWords(typeLabels: ReadonlyArray<string | null | undefined>, fallback = 'プロジェクト'): string {
  const seen: string[] = []
  for (const l of typeLabels) {
    const t = label(l)
    if (t && !seen.includes(t)) seen.push(t)
  }
  return seen.length ? seen.join('・') : fallback
}

// --- States -----------------------------------------------------------------------------
// Shown only in the header of an opened record; list rows say what to do next instead (3b).
const STATE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  task: {
    todo: '未着手', in_progress: '進めている', review: '確かめてもらっている', waiting: '返事待ち', done: '完了',
    awaiting_acceptance: '引き受け待ち', declined: '受けられないと返した', preparing: 'AI が用意している', cancelled: 'アーカイブ済み',
  },
  meeting: { received: '届いた', reading: 'AI が読んでいる', read: 'AI が読み終えた', failed: '読めなかった', skipped: '読まない' },
  decision: { unconfirmed: 'まだ確かめていない', confirmed: '確かめた', retracted: '取り消した' },
  outbound_message: { draft: '下書き', sent: '送った', unknown: '届いたか分からない', discarded: 'やめた（しまった）' },
  approval: {
    pending: '承認待ち', approved: '承認した', sent_back: '差し戻した', stale: '中身が変わったので使えない',
    withdrawn: '取り下げた', failed: 'うまくいかなかった',
  },
  reply_request: {
    preparing: 'AI が用意している', open: '返事をする', waiting_reply: '相手の返事待ち', checking: 'AI が確かめている',
    closed: '終わった', dropped: '返事をしない',
  },
}

/** Any type's states the core's types share, for a type without its own words above. */
const COMMON_STATE_WORDS: Readonly<Record<string, string>> = {
  ...STATE_WORDS.task, ...STATE_WORDS.meeting, ...STATE_WORDS.decision, ...STATE_WORDS.outbound_message, ...STATE_WORDS.approval,
  // Archiving (アーカイブ) is the task's word; another type's 中止 stays 「やめた」.
  cancelled: 'やめた（しまった）', handled: '対応済み', bundle_waiting: 'まとまりの分を待っている', bundle_working: 'まとまりの分を進めている',
}

/** A state in members' words; a state no table knows is shown as it is (a company's own word). */
export function stateWord(state: string | null | undefined, type?: string): string | null {
  if (!state) return null
  return (type ? STATE_WORDS[type]?.[state] : undefined) ?? COMMON_STATE_WORDS[state] ?? state
}

// --- Next steps and turns ---------------------------------------------------------------

/** The one main button of a row or a record (5.). */
export const NEXT_STEP = {
  complete: '完了にする',
  askToCheck: '終わったので見てもらう',
  accept: '引き受ける',
  takeOver: '自分で進める',
  checkAndSend: '確かめて送る',
  check: '確かめる',
  finishCheck: '確認を終える',
  reopen: 'やり直す',
} as const

/** Whose turn it is, for a row's small line: 「あなたの番」「田中さんの番」「相手の番」「AI の番」. */
export function turnWords(turn: { kind: 'me' } | { kind: 'ai' } | { kind: 'outside' } | { kind: 'person'; name: string }): string {
  switch (turn.kind) {
    case 'me': return 'あなたの番'
    case 'ai': return 'AI の番'
    case 'outside': return '相手の番'
    case 'person': return `${turn.name}さんの番`
  }
}

/** 「あなたの番」 groups by kind with one line on what to do (4.). */
export const TURN_ASKS: Readonly<Partial<Record<ThingKind, string>>> = {
  minutes_check: '確かめてください',
  outbound: '確かめて送ってください',
  approval: '承認してください',
  reply_request: '返事をしてください',
  meeting: '選んでください',
}

/** 「承認のお願い 3件 — 承認してください」. */
export function turnGroupLine(name: string, count: number, ask?: string): string {
  return `${name} ${count}件${ask ? ` — ${ask}` : ''}`
}

// --- Waiting, empty, failing (6.) -------------------------------------------------------
export const CALM = {
  loading: '読み込んでいます',
  emptyTasks: 'まだやることはありません。ここに、あなたが押すものが並びます',
  emptyLinks: 'まだありません',
  notFound: '見つかりませんでした',
  offline: 'サーバーにつながらないため、表示できません。つながると自動で読み直します',
  failed: 'うまくいきませんでした。少し待ってから、もう一度押してください',
  notAllowed: (who?: string) => `このやることは、あなたには変えられません${who ? `（${who}さんに頼んでください）` : ''}`,
  changedFirst: (who?: string) => `${who ? `${who}さんが` : 'ほかの人が'}先に変えました。最新を読み込みました。もう一度押してください`,
  aiWorking: 'AI が反映しています…（あと少し）',
  aiDone: (what: string) => `AI が反映しました：${what}`,
} as const

/** Who can see it, in plain words: 「あなただけ」 is the one that gets a lock (5b). */
export const ONLY_YOU = 'あなただけ'

// --- The middle's tabs grouped by kind (「種類ごとにまとめる」, owner 2026-11-04) ---------------
/** The groups, in the order they stand: files, tasks, bundles (案件／プロジェクト…), meetings, decisions, the rest. */
export const TAB_KIND_GROUPS = ['file', 'task', 'bundle', 'meeting', 'decision', 'other'] as const
export type TabKindGroup = typeof TAB_KIND_GROUPS[number]

/** Which group a record's tab stands in (a file's is `file`; a record not read yet, `other`). */
export function tabKindGroupOf(r: ThingRecord | null | undefined): TabKindGroup {
  if (!r) return 'other'
  switch (thingKindOf(r)) {
    case 'task': case 'minutes_check': return 'task'
    case 'bundle': return 'bundle'
    case 'meeting': return 'meeting'
    case 'decision': return 'decision'
    default: return 'other'
  }
}

/**
 * A group's name: the core's words, the bundles by the labels of the ones open (「案件・プロジェクト」,
 * `bundleWords`), and 「その他」 for the rest.
 */
export function tabKindGroupName(group: TabKindGroup, bundleTypeLabels: ReadonlyArray<string | null | undefined> = []): string {
  switch (group) {
    case 'file': return THING_NAMES.file
    case 'task': return THING_NAMES.task
    case 'bundle': return bundleWords(bundleTypeLabels)
    case 'meeting': return THING_NAMES.meeting
    case 'decision': return THING_NAMES.decision
    case 'other': return 'その他'
  }
}

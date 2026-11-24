// 「預かり」 (private-folders.md "Holding: review"; owner decision 2026-11-23 「B」): what the console
// says about a held item and what it sends. Pure: the page and its tests share these.
//
// Everything shown comes from the review API's own answer (`HoldingReviewItem` / `…Detail`): the API
// answers an item only to someone who may review it, so nothing here looks a folder up elsewhere.
import { ApiError, type HoldingCause, type HoldingReviewFile, type HoldingReviewItem, type HoldingTakeRequest } from './api'
import { describeError } from './errors'
import { parseServerDate } from './format'

export const HOLDING_TAB_LABEL = '預かり'

export const HOLDING_HELP =
  '見る権限がなくなった人の PC に、まだ届けていなかった変更が残っていたときに、ここで預かります。30日たつと自動的に捨てます。'

export const HOLDING_EMPTY = '預かっているものはありません。'

/** Why the member stopped reading the folder (the row's 「…とき」). */
export const CAUSE_LABELS: Record<HoldingCause, string> = {
  readers: '見る人から外れたとき',
  'left-company': '会社を離れたとき',
  'folder-deleted': 'フォルダを削除したとき',
  role: '役割が変わったとき',
  rules: '見られる決まりが変わったとき',
}

/** 「〇〇さん」 (the name the server answered; never looked up elsewhere). */
export function personLabel(item: Pick<HoldingReviewItem, 'userName'>): string {
  const name = item.userName?.trim()
  return name ? `${name}さん` : '名前のわからない人'
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days until the clock discards it (0 when today or past). */
export function daysLeft(expiresAt: string, now: Date = new Date()): number {
  const at = parseServerDate(expiresAt)
  if (!at) return 0
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / DAY_MS))
}

export function expiryText(expiresAt: string, now: Date = new Date()): string {
  const days = daysLeft(expiresAt, now)
  return days <= 0 ? 'まもなく自動的に捨てます' : `あと${days}日で自動的に捨てます`
}

/** Within 7 days of the clock's discard (the admin home's 「あと7日で自動的に捨てます」). */
export function expiresSoon(expiresAt: string, now: Date = new Date()): boolean {
  return daysLeft(expiresAt, now) <= 7
}

/** The entries counted as 「まだ届けていなかった変更」 etc., for the row. */
export function countsText(item: Pick<HoldingReviewItem, 'counts'>): string {
  const c = item.counts
  const parts = [`変更 ${c.changed + c.deleted}件`]
  if (c.backup > 0) parts.push(`バックアップ ${c.backup}件`)
  if (c.personal > 0) parts.push(`本人のメモ ${c.personal}件`)
  if (c.namesOnly > 0) parts.push(`名前だけ ${c.namesOnly}件`)
  return parts.join('・')
}

export type FileGroupId = 'changes' | 'backup' | 'personal' | 'names'

/** The groups of the detail, in order (design memo §8). */
export function groupTitle(group: FileGroupId, person: string): string {
  switch (group) {
    case 'changes':
      return 'まだ届けていなかった変更'
    case 'backup':
      return `${person}の版（バックアップ）`
    case 'personal':
      return '本人のメモ（フォルダには入れられません）'
    case 'names':
      return '預かれなかったファイル（名前だけ）'
  }
}

export const FILE_GROUP_ORDER: FileGroupId[] = ['changes', 'backup', 'personal', 'names']

/** Which group an entry is shown in: anything whose content is not held (a deletion aside) is a name only. */
export function fileGroup(file: HoldingReviewFile): FileGroupId {
  if (file.kind === 'names-only' || (!file.held && file.kind !== 'deleted')) return 'names'
  if (file.kind === 'personal') return 'personal'
  if (file.kind === 'backup') return 'backup'
  return 'changes'
}

export function groupFiles(files: HoldingReviewFile[]): Array<{ group: FileGroupId; files: HoldingReviewFile[] }> {
  return FILE_GROUP_ORDER.map((group) => ({ group, files: files.filter((f) => fileGroup(f) === group) })).filter((g) => g.files.length > 0)
}

/**
 * The entries ticked when the detail opens (design memo §4): the unsent changes the server says may go
 * into the folder. Backups are not ticked; 本人のメモ and names only can never be (the server says
 * `takeable: false` for them, and refuses them anyway).
 */
export function defaultSelection(files: HoldingReviewFile[], folderGone: boolean): Set<number> {
  if (folderGone) return new Set()
  return new Set(files.filter((f) => f.takeable && (f.kind === 'changed' || f.kind === 'deleted')).map((f) => f.idx))
}

/** Someone changed the folder's file since the member's version (or that version is unknown). */
export function changedSince(file: HoldingReviewFile): boolean {
  return file.standing !== 'unchanged'
}

/** A chosen content that would land on a file changed since: what 「上書きする」 is about. */
export function wouldMeetLaterChange(file: HoldingReviewFile): boolean {
  return file.kind !== 'deleted' && file.inFolderNow && changedSince(file)
}

/**
 * The body of `POST …/take`: only entries the server marked takeable among those ticked, in order, and
 * `whenChanged` always stated (「上書きする」 only when the reviewer chose it).
 */
export function takeRequest(files: HoldingReviewFile[], selected: ReadonlySet<number>, overwrite: boolean): HoldingTakeRequest {
  return {
    files: files.filter((f) => f.takeable && selected.has(f.idx)).map((f) => f.idx).sort((a, b) => a - b),
    whenChanged: overwrite ? 'overwrite' : 'alongside',
  }
}

/** One line about where an entry stands, for its row. */
export function fileStateText(file: HoldingReviewFile): string | null {
  if (file.dropped === 'secret') return 'パスワードなどが入っているため、中身は預かっていません'
  if (file.dropped === 'too-large') return '大きすぎるため、中身は預かっていません'
  if (file.kind === 'names-only' || (!file.held && file.kind !== 'deleted')) return '中身は預かっていません'
  if (file.kind === 'personal') return null
  if (file.kind === 'deleted') {
    if (!file.inFolderNow) return '消したファイル（フォルダにはもうありません）'
    return changedSince(file) ? '消したファイル（その後ほかの人が変えたため、入れても消しません）' : '消したファイル'
  }
  if (file.kind === 'backup') return 'もとの場所には置かず、名前を変えて並べて置きます'
  if (file.standing === 'unknown') return file.inFolderNow ? 'もとにした版がわかりません（その後の変更があるものとして扱います）' : '新しいファイル'
  if (file.standing === 'changed') return file.inFolderNow ? 'その後ほかの人が変えています' : 'その後ほかの人が消しています'
  return file.inFolderNow ? '変えたファイル' : '新しいファイル'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A refused review request, in plain words, and what the page does next. */
export interface HoldingProblem {
  message: string
  /** The item is no longer the caller's to decide (decided, expired, or not visible): close it and reload the list. */
  gone: boolean
  /** Entries the server named (no place now, or not takeable): marked in the list. */
  files: number[]
}

const KEPT = '預かったものはそのまま残しています。'

/** The review codes (shared/types/private-holding.ts `HOLDING_REVIEW_CODES`), in the console's own words. */
export function describeHoldingError(err: unknown): HoldingProblem {
  const problem = (message: string, gone = false, files: number[] = []): HoldingProblem => ({ message, gone, files })
  if (!(err instanceof ApiError)) return problem(describeError(err))
  const files = Array.isArray(err.body?.files) ? (err.body.files as unknown[]).filter((n): n is number => Number.isInteger(n)) : []
  switch (err.code) {
    case 'ALREADY_DECIDED':
      return problem('ほかの人が先に決めました。一覧を読み込み直しました。', true)
    case 'EXPIRED':
      return problem('預かってから30日たったため、自動的に捨てました。一覧を読み込み直しました。', true)
    case 'FOLDER_GONE':
      return problem(`このフォルダはもうないため、ダウンロードするか捨てることだけができます。${KEPT}`)
    case 'PATH_TAKEN':
      return problem(`フォルダの中の形が変わっていて、置けないファイルがありました（同じ名前のファイルがフォルダの場所にあります）。印のついたファイルを外すか、ダウンロードしてからもう一度お試しください。${KEPT}`, false, files)
    case 'NOT_TAKEABLE':
      return problem(`フォルダに入れられないものが選ばれていました（本人のメモ・名前だけのもの・中身が見つからないもの）。印のついたファイルを外してください。${KEPT}`, false, files)
    case 'TAKE_REFUSED':
      // The server's sentence names only fixed reasons (its REFUSAL_WORDS), never a folder or a path.
      return problem(err.message.startsWith('フォルダに入れられない') ? err.message : `フォルダに入れられないファイルがありました。${KEPT}`)
    case 'BUSY':
      return problem(`フォルダが使われているため、今は入れられませんでした。少したってからもう一度お試しください。${KEPT}`)
    case 'INVALID':
      return problem('送った内容を受け付けられませんでした。読み込み直してから、もう一度お試しください。')
  }
  if (err.status === 404) return problem('この預かりはもう見られません。ほかの人が決めたか、確かめる人が変わった可能性があります。一覧を読み込み直しました。', true)
  if (err.status === 410) return problem('預かってから30日たったため、自動的に捨てました。一覧を読み込み直しました。', true)
  if (err.status === 503) return problem(`今は処理できませんでした。少したってからもう一度お試しください。${KEPT}`)
  return problem(describeError(err))
}

/** A download refused: the version may simply not exist (a new file has no earlier version). */
export function describeDownloadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return 'このファイルのこの版はありません。一覧を読み込み直してください。'
  return describeError(err)
}

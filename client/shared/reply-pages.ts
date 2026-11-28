/**
 * A rich reply kept as a page (chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］［コードとして見る］"):
 * the IPC payloads and the file-name rule. Pure: main writes the file (`electron/features/reply-pages/ipc.ts`), the
 * chat only hands over what the page holds and which consultation it came from. Where it goes is `replyPageFolderOf`
 * (reply-style.ts): the member's 今日のフォルダ's `ページ/`, on this computer only.
 */
import { fileNameProblem } from './file-names'

/** Which consultation the reply is from: main names the page after its title. */
export interface ReplyPageConsultation {
  companyId: string
  sessionId: string
}

export type ReplyPageSaveResult =
  | { success: true; path: string; name: string }
  | { success: false; error: string }

/** A page larger than this is not a reply (characters; a reply is cut long before). */
export const REPLY_PAGE_MAX_CHARS = 5_000_000
/** Free names tried (「名前 (2).html」…) before giving up: nothing is ever replaced. */
export const REPLY_PAGE_MAX_TRIES = 50
/** A consultation not named yet, or a name with nothing left. */
export const REPLY_PAGE_FALLBACK_NAME = 'AI の返事'
const MAX_BASE = 40

/** Characters a file name must not hold or cannot show honestly: path and Windows ones, and (below) the invisible. */
const UNSAFE = /[/\\<>:"|?*]/g
/** Control, invisible and direction characters (code points, so no such character is written in this file). */
const INVISIBLE: readonly (readonly [number, number])[] = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
const shown = (char: string) => !INVISIBLE.some(([from, to]) => { const at = char.codePointAt(0)!; return at >= from && at <= to })

/**
 * The page's name without `.html`: the consultation's title, made safe for a file (unsafe characters become spaces,
 * no leading dot, no trailing space or dot, at most 40 characters), else 「AI の返事」.
 */
export function replyPageBaseName(title: unknown): string {
  if (typeof title !== 'string' || title.trim() === '新しい相談') return REPLY_PAGE_FALLBACK_NAME
  const visible = Array.from(title.normalize('NFC'), char => (shown(char) ? char : ' ')).join('')
  const cleaned = Array.from(visible.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, ''))
    .slice(0, MAX_BASE).join('').replace(/[\s.]+$/, '')
  return cleaned && !fileNameProblem(`${cleaned}.html`) ? cleaned : REPLY_PAGE_FALLBACK_NAME
}

/** The `n`th name tried: 「名前.html」, then 「名前 (2).html」, …. */
export const replyPageFileName = (base: string, n: number): string => (n <= 1 ? `${base}.html` : `${base} (${n}).html`)

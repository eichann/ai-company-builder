/**
 * ACB's own player over a document's Google Drive videos (doc-frame.md "ACB's player over Drive embeds
 * (plan 4)"). The document stays as it is — its CSP, its session, its bytes —: the player is a view of
 * ACB's own, placed above the document's view where the document embeds a Drive video (or over the
 * document's area, for a link the member pressed or a row of the band), and it plays the bytes main
 * relays from the server's stream route with the member's session.
 *
 * Pure: the player's address (`acb-drive-video://<token>/…`), where a player goes on screen, which
 * actions its page may ask for, and the plain Japanese of what went wrong. Main decides which file a
 * player plays (an id it read itself from the document it served, or a link the member pressed); the
 * page and the renderer only ever name a view and an index.
 */
import { driveAddressVideoId } from './doc-drive-videos'
import type { DocViewBounds } from './doc-frame'

export const DRIVE_PLAYER_SCHEME = 'acb-drive-video'

/** A player's token: 32 lowercase hex characters (16 random bytes), the address's host. */
export const DRIVE_PLAYER_TOKEN_RE = /^[0-9a-f]{32}$/

/** At most this many players over one document's embeds (the band lists as many videos). */
export const DRIVE_PLAYERS_MAX = 10

/**
 * What the player's own page may ask main for, by going to `<action>` under its token (a link or its
 * one script; main refuses the navigation and acts): ［ここで再生］ / ［もう一度］ (`play`), ［ブラウザで開く］
 * (`browser`), ［やめる］ while the member picks in the browser (`cancel`), ［閉じる］ on a player over the
 * area (`close`), and the video failing to play (`unplayable`: a codec the app lacks; `failed`: the
 * bytes stopped coming).
 */
export const DRIVE_PLAYER_ACTIONS = ['play', 'browser', 'cancel', 'close', 'unplayable', 'failed'] as const
export type DrivePlayerAction = typeof DRIVE_PLAYER_ACTIONS[number]

/** The page itself, the video's bytes, or an action. */
export type DrivePlayerTarget = { token: string; kind: 'page' } | { token: string; kind: 'video' } | { token: string; kind: 'action'; action: DrivePlayerAction }

/** The address of a player's page (`?v=` only makes each load its own). */
export function drivePlayerPageUrl(token: string, version = 0): string {
  return `${DRIVE_PLAYER_SCHEME}://${token}/?v=${version}`
}

/**
 * Read a player address on the raw string: exactly `acb-drive-video://<token>/` then nothing (the
 * page), `video` (its bytes) or one of the actions; a query or fragment is dropped. Anything else —
 * another path, a user-info or port, an encoded name — is null.
 */
export function parseDrivePlayerUrl(url: unknown): DrivePlayerTarget | null {
  if (typeof url !== 'string' || url.length > 512) return null
  const prefix = `${DRIVE_PLAYER_SCHEME}://`
  if (url.slice(0, prefix.length).toLowerCase() !== prefix) return null
  let rest = url.slice(prefix.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const token = rest.slice(0, slash)
  const path = rest.slice(slash + 1)
  if (!DRIVE_PLAYER_TOKEN_RE.test(token)) return null
  if (path === '') return { token, kind: 'page' }
  if (path === 'video') return { token, kind: 'video' }
  return (DRIVE_PLAYER_ACTIONS as readonly string[]).includes(path) ? { token, kind: 'action', action: path as DrivePlayerAction } : null
}

/**
 * The Drive file id of a web link the member pressed in a document, when it may play in ACB's player:
 * the band's own narrowing (`https://drive.google.com` exactly, then the core's file-link rule).
 */
export function driveLinkVideoId(url: unknown): string | null {
  return driveAddressVideoId(url)
}

/** Where a player goes on screen (window DIP) and where its video sits inside it (player-local DIP). */
export interface DrivePlayerPlacement {
  bounds: DocViewBounds
  /** The whole embed's box inside the player: the part outside the document's area is cut off, not squeezed. */
  stage: DocViewBounds
}

/** A player over an embed smaller than this either way is not worth showing (the document's own box shows). */
const EMBED_MIN_SIDE = 24
/** An embed's box the document reports is believed only up to this size (DIP): a sanity bound, not layout. */
const EMBED_MAX_SIDE = 16384

/**
 * A player over an embed: `box` is where the document lays the embed out (its view's own DIP, as main
 * read it), `area` where the document's view is on screen (window DIP). The player covers the part of
 * the box inside the area and keeps the video the size of the whole box; null when nothing of it is in
 * the area, or the box is not a sane rectangle. Cosmetic only: a document can lie about its layout,
 * never about which file plays.
 */
export function embedPlacement(area: DocViewBounds, box: DocViewBounds): DrivePlayerPlacement | null {
  const values = [box.x, box.y, box.width, box.height]
  if (!values.every(v => Number.isFinite(v))) return null
  if (box.width < EMBED_MIN_SIDE || box.height < EMBED_MIN_SIDE || box.width > EMBED_MAX_SIDE || box.height > EMBED_MAX_SIDE) return null
  const left = Math.max(area.x, Math.round(area.x + box.x))
  const top = Math.max(area.y, Math.round(area.y + box.y))
  const right = Math.min(area.x + area.width, Math.round(area.x + box.x + box.width))
  const bottom = Math.min(area.y + area.height, Math.round(area.y + box.y + box.height))
  if (right - left < 1 || bottom - top < 1) return null
  return {
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    stage: { x: Math.round(area.x + box.x) - left, y: Math.round(area.y + box.y) - top, width: Math.round(box.width), height: Math.round(box.height) },
  }
}

/** The margin around a player over the whole area (DIP). */
const OVERLAY_MARGIN = 24

/**
 * A player over the document's area (a link the member pressed, a row of the band: there is no spot to
 * anchor it): centred, 16:9 plus its bar, as large as the area allows with a margin; null when the area
 * is too small to hold one.
 */
export function overlayPlacement(area: DocViewBounds, bar = 32): DrivePlayerPlacement | null {
  const maxWidth = Math.min(area.width - 2 * OVERLAY_MARGIN, 1280)
  const maxHeight = area.height - 2 * OVERLAY_MARGIN
  if (maxWidth < 160 || maxHeight < 120) return null
  let width = maxWidth
  let height = Math.round(width * 9 / 16) + bar
  if (height > maxHeight) {
    height = maxHeight
    width = Math.min(maxWidth, Math.round((height - bar) * 16 / 9))
  }
  const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
  return { bounds, stage: { x: 0, y: 0, width, height } }
}

/** What the player shows (main's state; its page is drawn from it). */
export type DrivePlayerView =
  | { kind: 'poster' }
  | { kind: 'checking' }
  | { kind: 'picking' }
  /** `at`: from where it was when it was hidden (seconds). */
  | { kind: 'playing'; at?: number }
  /** Hidden while it played: paused, its streams stopped; ［続きから再生］ goes on. */
  | { kind: 'paused' }
  | { kind: 'error'; message: string; retry: boolean; browser: boolean }

/** The server's stream route refuses a file the member has not picked for viewing (or picked under another account): pick it, then play. */
export const DRIVE_PLAYER_NEEDS_PICK = new Set(['DRIVE_VIEW_NOT_PICKED', 'GOOGLE_CONSENT_NEEDED'])

export const DRIVE_PLAYER_WORDS = {
  offline: 'サーバーに接続できませんでした。インターネットの接続を確かめてから、もう一度お試しください。',
  failed: '動画を読み込めませんでした。もう一度お試しください。',
  unplayable: 'この動画はアプリの中では再生できない形式です。ブラウザで開いて見てください。',
  notVideo: '動画ではないファイルのため、ここでは再生できません。',
  cancelled: '動画が選ばれなかったため、再生していません。［もう一度］を押すと、ブラウザでもう一度選べます。',
  timedOut: '選ばれないまま時間が過ぎました。［もう一度］を押すと、ブラウザでもう一度選べます。',
  notKept: '選んだ動画を使えませんでした。',
  signedOut: 'サーバーへのログインが切れました。ログインし直してから、もう一度お試しください。',
  noCompany: 'この資料の動画は、ここでは再生できません。ブラウザで開いて見てください。',
} as const

/**
 * What the member reads when the stream route refused (`status`, its JSON `{ error, code }`): the
 * server's own Japanese sentence when it gave one (a cap's 「今日は…」, Google's refusal), else a fixed
 * one. ［もう一度］ except for a file that is not a video; ［ブラウザで開く］ always.
 */
export function drivePlayerRefusal(status: number, body: unknown): Extract<DrivePlayerView, { kind: 'error' }> {
  const { error, code } = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; code?: unknown }
  const sentence = typeof error === 'string' && error.trim() !== '' && error.length <= 400 ? error.trim() : null
  if (code === 'DRIVE_VIEW_NOT_VIDEO') return { kind: 'error', message: sentence ?? DRIVE_PLAYER_WORDS.notVideo, retry: false, browser: true }
  if (status === 401) return { kind: 'error', message: DRIVE_PLAYER_WORDS.signedOut, retry: true, browser: true }
  return { kind: 'error', message: sentence ?? DRIVE_PLAYER_WORDS.failed, retry: true, browser: true }
}

/** One byte range as a `<video>` asks it: exactly `bytes=a-b` or `bytes=a-`; anything else null. */
export function parseByteRange(value: unknown): { start: number; end: number | null } | null {
  const m = typeof value === 'string' ? /^bytes=(\d{1,15})-(\d{0,15})$/.exec(value.trim()) : null
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? null : Number(m[2])
  return end !== null && end < start ? null : { start, end }
}

/** A 206's `Content-Range: bytes a-b/size` (size known, a ≤ b < size); anything else null. */
export function parseContentRange(value: unknown): { start: number; end: number; size: number } | null {
  const m = typeof value === 'string' ? /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(value.trim()) : null
  if (!m) return null
  const [start, end, size] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return start <= end && end < size ? { start, end, size } : null
}

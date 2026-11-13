/**
 * Google Drive through the Google connection (`.claude/rules/google-drive.md`).
 * Part of the Google connector's module (with google-client.ts,
 * google-connector.ts, google-meetings.ts): Drive is a connection, never a
 * core role (owner, 2026-11-01), so nothing outside the connector names it.
 *
 * Least privilege: `drive.file` only — Google itself lets ACB open just the
 * files a person picked with Google Picker or ACB created. On top of that,
 * ACB keeps the person's picks (`google_drive_picks`) and reads or writes into
 * nothing else: the AI can read a file or put into a folder only after the
 * member chose it in Google Picker.
 *
 * - The Picker's token: a fresh access token with exactly `drive.file`
 *   (google-client.ts `pickerToken`), the admin's Picker API key and app id,
 *   handed once to the Picker page in the member's browser that holds a
 *   one-time pick ticket the member's app asked for with its session
 *   (`startPick` → `pageConfig` → `pageResult`; Google Picker needs a
 *   signed-in browser, so it is not shown inside the app). Never to a record
 *   token, never stored or logged; the ticket is stored as its sha256.
 * - Picks (`savePicks`, session): every id is opened with Google first (drive.file
 *   answers only for files picked through the Picker for this app); a folder
 *   must be a folder the member can add to, a file one ACB can read.
 * - Reading (`read`, record token): a picked file only; Docs / Slides / Sheets
 *   exported as text, a text file as is, a PDF as bytes (the app saves it
 *   under `.personal/`). Marked as outside text; never stored or logged.
 * - Putting (`put`, act token): PDF or HTML only (content checked, ≤ 10 MB),
 *   into a picked folder that nobody outside the company can see (putting into
 *   a folder shared outside is sending outside: a person's act, not the AI's).
 *   The receipt is written before the upload; one per request key (the same
 *   put is never sent twice); the upload is never retried; a lost answer is
 *   `unknown` and looked up by the put's id (Drive `appProperties.acbPutId`),
 *   never re-sent. Returns Drive's link and revision id.
 */
import { GOOGLE_SCOPE } from '../../shared/core/google'
import {
  checkDriveFileName, checkDrivePutContent, DRIVE_DOC_MIME, DRIVE_DOC_REFUSED_OUTSIDE, drivePickableFor, drivePickRefusedText, driveFolderSharingText, isDrivePickPurpose, type DriveFolderSharing, type DrivePickPurpose, type DrivePickRefusedWhy, DRIVE_FOLDER_MIME, DRIVE_PICK_MAX_FILES, DRIVE_PICK_SAVING_GRACE_MS, DRIVE_PICK_TICKET_KEPT_AFTER_MS, DRIVE_PICK_TICKETS_OPEN_MAX, DRIVE_PICK_TICKET_TTL_MS, DRIVE_PICK_TTL_MS, drivePreselectIds, isDrivePickTicket, DRIVE_PICKABLE_MIMES, DRIVE_PUT_MAX_BYTES, DRIVE_READ_AS,
  DRIVE_READ_PDF_MAX_BYTES, DRIVE_READ_TEXT_MAX, DRIVE_TEXT_FOOTER, DRIVE_TEXT_HEADER, driveDocFetchesOutside, driveFolderReachesOutside, drivePutForm, driveRevisionOf, isDriveId, isDrivePickMode,
  type DrivePermissionLike,
} from '../../shared/core/google-drive'
import { INSTRUCTION_LIKE_WORDS } from '../../shared/core/instruction-like'
import { neutralizeOutsideText, outsideTextFlags } from '../../shared/core/outside-text'
import type { DriveAiStatus, DriveOwnFile, DriveOwnFiles, DrivePick, DrivePickerPageConfig, DrivePickTicketStarted, DrivePickTicketState, DrivePicksResult, DrivePutAnswer, DrivePutView, DriveReadAnswer, DriveUpdatableFile } from '../../shared/types/google-drive'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { DriveDocBaseline, DrivePickRow, DrivePutRow, PickTicketDirectory } from '../ports/google-drive'
import type { Member } from './access'
import type { GoogleClient, GoogleRequest, GoogleResult } from './google-client'
import { cleanExportText } from './google-meetings'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

export interface GoogleDriveDeps {
  companyData: CompanyDataSource
  google: Pick<GoogleClient, 'request' | 'pickerToken'>
  clock: Clock
  ids: IdGenerator
  /** The operator's stop file names `google` or `*`. */
  operatorStopped(): Promise<boolean>
  vaultEnabled(): boolean
  /** Where the Picker page loads Google's script from (https://apis.google.com, or the practice Google's origin). */
  pickerScriptOrigin: string
  /** The waits of a Google document's baseline (read per use; `lib/config.ts` `driveDocTiming`). */
  docTiming?: () => DriveDocTiming
  /** Where the document checks' diagnostics go (default: console); never a file id, name, text or token. */
  log?: Pick<Console, 'warn'>
  /** sha256 of bytes, lower-case hex (composition: node's crypto). */
  sha256(bytes: Uint8Array): string
  /** The membership now (a pick ticket's member must still be one when the page uses it). */
  memberOf(companyId: string, userId: string): Member | null
  /** Which company a pick ticket (by its sha256) belongs to: the control plane's lookup. */
  pickTickets: PickTicketDirectory
}

/**
 * A picked file checked for linking it to a record (records.md "Drive and PC file links"): its revision when linked, its name as picked, its type and the sha256 of the content ACB
 * read (export or download, as `read` does; null when it could not be read). Nothing of it is logged.
 */
export interface DriveLinkableFile {
  fileId: string
  revisionId: string | null
  name: string
  mimeType: string | null
  sha256: string | null
}

/**
 * A scheduled job's run (jobs.md "A deliverable place outside"): the one folder its responsible person chose, and
 * whether a run is one of the same job's (an update may name only a file a run of this job made).
 */
export interface DriveJobScope {
  folderId: string
  sameJob(runId: string): boolean
}

/** Who puts a file: the member's AI (record token) or the member. */
export interface DriveActor {
  kind: 'ai' | 'person'
  conversationId: string | null
  runId: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const REQUEST_KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const TRUNCATED = '\n【長いため、ここから先は省きました】'
const PICKS_LISTED = 20
const OWN_FILES_LISTED = 30
/** The AI's status lists at most this many files its member's puts made (one per file, newest first; `putsMore` says there are more). */
const PUT_FILES_LISTED = 50
const PERMISSION_PAGES = 5

const STOPPED = 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。'
const PICKER_NOT_CONFIGURED = '管理者が Google Drive のファイル選び（Picker）をまだ設定していません。管理者に「つなぎ先」→「Google」の設定を頼んでください。'
const FEATURE_OFF = '「Drive で選んだものを読む・置く」をオフにしています。アプリの「設定」→「Google」の「Drive で選んだものを読む・置く」で［オンにする］を押してください。'
const GOOGLE_UNAVAILABLE_TEXT = 'Google Drive とやりとりできませんでした。少し待ってからもう一度お試しください。'
const APP_UPDATE_NEEDED = 'Google Drive のファイル選びは、新しいアプリで使えます（ブラウザで選ぶ形になりました）。アプリを新しくしてから、もう一度お試しください。'
/** A ticket a page can no longer use (unknown, another company's, expired, used, closed): one answer for all. */
const TICKET_GONE = refuse('gone', 'この画面は、もう使えません。アプリに戻って、もう一度 Google Drive から選び始めてください。', { code: 'PICK_TICKET_GONE' })
const TICKET_NOT_FOUND = refuse('not-found', 'この Google Drive の選び直しは見つかりません。', { code: 'PICK_TICKET_NOT_FOUND' })

/** The stored result of a picked ticket (written by this module), read back strictly. */
function pickedState(raw: string | null): DrivePickTicketState {
  try {
    const v = JSON.parse(raw ?? '') as unknown
    if (isObj(v) && Array.isArray(v.picks) && typeof v.refused === 'number') {
      return { state: 'picked', picks: v.picks as DrivePick[], refused: v.refused, ...(isObj(v.refusedWhy) ? { refusedWhy: v.refusedWhy as DrivePickRefusedWhy } : {}) }
    }
  } catch { /* fall through */ }
  return { state: 'failed', error: '選んだものを確かめられませんでした。' }
}

function failedError(raw: string | null): string {
  try {
    const v = JSON.parse(raw ?? '') as unknown
    if (isObj(v) && typeof v.error === 'string') return v.error
  } catch { /* fall through */ }
  return 'Google Drive のファイル選びを始められませんでした。'
}

const NO_CONSENT = 'Google Drive を使う許可がまだありません。アプリが Google の画面を開くので、メンバーに「許可」を押してもらってください（Drive は、メンバーが選んだファイルとフォルダだけを使います）。'

/** A Google call that did not give a usable answer → the member-facing refusal. */
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }
const codePoint = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '')
/**
 * HTML and JSON can spell words as escapes (`&#x3010;`, `\u0049gnore`): a copy with them decoded, for the
 * instruction-like flags only — the text handed to the AI stays as read. Null for any other type.
 */
function decodedForFlags(text: string, mimeType: string): string | null {
  if (mimeType === 'text/html') {
    return text
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h: string) => codePoint(parseInt(h, 16)))
      .replace(/&#(\d{1,7});?/g, (_, d: string) => codePoint(Number(d)))
      .replace(/&(lt|gt|amp|quot|apos|nbsp);/gi, (_, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? '')
  }
  if (mimeType === 'application/json') return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  return null
}

function googleRefusal(r: Extract<GoogleResult, { ok: false }>, noAccess: string): Outcome<never> {
  if (r.kind === 'not-sent') {
    if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'token-refused'].includes(r.reason)) {
      return refuse('conflict', NO_CONSENT, { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'drive' })
    }
    if (r.reason === 'feature-off') {
      return refuse('conflict', FEATURE_OFF, { code: 'GOOGLE_FEATURE_OFF', feature: 'drive' })
    }
    if (['operator-stopped', 'not-configured', 'off', 'vault-off', 'not-member', 'practice-real-secret'].includes(r.reason)) {
      return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
    }
  }
  if (r.kind === 'refused' && (r.status === 403 || r.status === 404)) return refuse('forbidden', noAccess, { code: 'DRIVE_NO_ACCESS' })
  return refuse('unavailable', 'Google Drive とやりとりできませんでした。少し待ってからもう一度お試しください。', { code: 'GOOGLE_UNAVAILABLE' })
}

function pickView(p: DrivePickRow): DrivePick {
  return { id: p.fileId, kind: p.kind, name: p.name, mimeType: p.mimeType, pickedAt: p.pickedAt, expiresAt: p.expiresAt }
}

function putView(p: DrivePutRow): DrivePutView {
  return {
    id: p.id, state: p.state, name: p.name, mimeType: p.mimeType, bytes: p.bytes, sha256: p.sha256, folderId: p.folderId, folderName: p.folderName,
    fileId: p.fileId, revisionId: p.revisionId, link: p.link, createdAt: p.createdAt, finishedAt: p.finishedAt, reason: p.reason, skills: p.skills,
    updatedFileId: p.updatedFileId,
  }
}

/** Drive's multipart upload body: the metadata as JSON, then the file. */
function multipart(boundaryId: string, metadata: unknown, mimeType: string, bytes: Uint8Array): { contentType: string; bytes: Uint8Array } {
  // The file is PDF / HTML checked before; a boundary of the put's own id plus a fixed tail is not in it in practice.
  const boundary = `acb-boundary-${boundaryId}-7f3c9e`
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`)
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
  const out = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength)
  out.set(head, 0)
  out.set(bytes, head.byteLength)
  out.set(tail, head.byteLength + bytes.byteLength)
  return { contentType: `multipart/related; boundary=${boundary}`, bytes: out }
}

/** A time Google answered, as it may appear in a log line: only an RFC 3339 UTC timestamp, else a fixed word. */
function logStamp(v: string | null): string {
  if (v === null) return 'unread'
  return isLogStamp(v) ? v : 'unusual'
}
const isLogStamp = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v)

/**
 * How long after the upload answer a new Google document's times may lie (google-drive.md "A Google document's own
 * changes"; real Google, 2026-11-12: ~4 s for the file, ~3 s for its one revision): the observation's longest budget
 * (`ACB_DRIVE_DOC_BUDGET_MS`, at most 25 s) and a little more for the two clocks — no longer, so an edit merged into the
 * member's revision can only come from those seconds.
 */
const DOC_BASELINE_WINDOW_MS = 30_000
/** At most this many reads of the revisions and the file while the observation waits for them to settle. */
const DOC_BASELINE_MAX_READS = 12

/** The waits around a Google document's baseline (ms; google-drive.md "A Google document's own changes"). */
export interface DriveDocTiming {
  /** Between the two exports, and before an export's one retry. */
  settleMs: number
  /** After the upload answer, before the revisions and the file are first read (Drive's processing moved them ~3–4 s). */
  quietMs: number
  /** Between two reads that must agree. */
  gapMs: number
  /** After the upload answer, the observation gives up (`still-settling`). */
  budgetMs: number
}
export const DRIVE_DOC_TIMING_DEFAULTS: DriveDocTiming = { settleMs: 1500, quietMs: 8000, gapMs: 2000, budgetMs: 25_000 }

/** One revision of a Google document as `revisions.list` gives it (an id or a time Google left out is null). */
interface DocRevision {
  id: string | null
  at: string | null
  /** `lastModifyingUser.me`: the member's own account made it last (ACB writes with their token). */
  me: boolean
}

export function createGoogleDriveService(deps: GoogleDriveDeps) {
  const { companyData, google, clock, ids } = deps
  const log = deps.log ?? console
  const handle = (companyId: string) => companyData.forCompany(companyId)
  const drive = (companyId: string, userId: string, req: Omit<GoogleRequest, 'api' | 'scope'>) =>
    google.request(companyId, userId, { api: 'drive', scope: GOOGLE_SCOPE.driveFile, ...req })

  /** The company's Google is on (operator, client, switch, vault) and the Picker is registered. */
  async function available(companyId: string): Promise<boolean> {
    if (await deps.operatorStopped()) return false
    const c = handle(companyId).connectors
    const client = c.client()
    return !!client && client.enabled && deps.vaultEnabled() && c.picker() !== null
  }

  /** A file's metadata as drive.file lets ACB see it. */
  async function meta(companyId: string, userId: string, fileId: string): Promise<Extract<GoogleResult, { ok: true }> | Extract<GoogleResult, { ok: false }>> {
    return drive(companyId, userId, {
      method: 'GET', path: `/drive/v3/files/${fileId}`,
      query: { fields: 'id,name,mimeType,trashed,modifiedTime,capabilities(canAddChildren)', supportsAllDrives: 'true' },
      operation: 'drive.files.get',
    })
  }

  /** Who can see what is put into the folder; null when it could not be read in full. */
  async function folderPermissions(companyId: string, userId: string, folderId: string): Promise<DrivePermissionLike[] | Extract<GoogleResult, { ok: false }> | null> {
    const out: DrivePermissionLike[] = []
    let pageToken: string | null = null
    for (let page = 0; page < PERMISSION_PAGES; page++) {
      const r = await drive(companyId, userId, {
        method: 'GET', path: `/drive/v3/files/${folderId}/permissions`,
        query: { fields: 'nextPageToken,permissions(type,domain,emailAddress,role)', supportsAllDrives: 'true', pageSize: '100', ...(pageToken ? { pageToken } : {}) },
        operation: 'drive.permissions.list',
      })
      if (!r.ok) return r
      const body = isObj(r.json) ? r.json : {}
      for (const p of Array.isArray(body.permissions) ? body.permissions : []) if (isObj(p)) out.push(p)
      pageToken = str(body.nextPageToken)
      if (!pageToken) return out
    }
    return null
  }

  const docTiming = () => deps.docTiming?.() ?? DRIVE_DOC_TIMING_DEFAULTS
  /** Waits until `performance.now()` reaches `atMs` (the observation's monotonic clock; never the server clock port). */
  const sleepUntil = async (atMs: number) => {
    const left = atMs - performance.now()
    if (left > 0) await new Promise<void>(resolve => setTimeout(resolve, left))
  }
  const settle = () => sleepUntil(performance.now() + docTiming().settleMs)

  /**
   * A Google document's fingerprint (google-drive.md "A Google document's own changes"): the sha256 of its text as Drive
   * exports it (`text/plain`, the export `drive_read` uses; BOM and line ends cleaned), with the member's own `drive.file`
   * token (a file ACB made: the scope allows exporting it). A failed export is tried once more after a short wait; null
   * when that fails too (refused, too large, no answer).
   */
  async function docFingerprint(companyId: string, userId: string, fileId: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await settle()
      const r = await drive(companyId, userId, {
        method: 'GET', path: `/drive/v3/files/${fileId}/export`, query: { mimeType: 'text/plain' }, binary: true, operation: 'drive.files.export',
      })
      if (r.ok && r.bytes) return deps.sha256(new TextEncoder().encode(cleanExportText(new TextDecoder().decode(r.bytes))))
    }
    return null
  }

  /**
   * A Google document's revisions (`revisions.list`, every page, oldest first; a `drive.file` call on a file ACB made):
   * each one's id, `modifiedTime` and whether the member's own account made it last (`lastModifyingUser.me`). A change of
   * content, formatting or images makes a new revision or (merged into the newest, as Docs does for one account's edits
   * close together) moves its time; viewing does neither. Null when the list could not be read in full, is empty, or its
   * newest entry has no usable id or time.
   */
  async function docRevisions(companyId: string, userId: string, fileId: string): Promise<DocRevision[] | null> {
    let pageToken: string | null = null
    const out: DocRevision[] = []
    for (let page = 0; page < 10; page++) {
      const r = await drive(companyId, userId, {
        method: 'GET', path: `/drive/v3/files/${fileId}/revisions`,
        query: { fields: 'nextPageToken,revisions(id,modifiedTime,lastModifyingUser(me))', pageSize: '1000', ...(pageToken ? { pageToken } : {}) },
        operation: 'drive.revisions.list',
      })
      if (!r.ok || !isObj(r.json)) return null
      for (const rev of Array.isArray(r.json.revisions) ? r.json.revisions.filter(isObj) : []) {
        out.push({
          id: typeof rev.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(rev.id) ? rev.id : null,
          at: str(rev.modifiedTime),
          me: isObj(rev.lastModifyingUser) && rev.lastModifyingUser.me === true,
        })
      }
      pageToken = str(r.json.nextPageToken)
      if (!pageToken) {
        const newest = out[out.length - 1]
        return newest && newest.id && newest.at ? out : null
      }
    }
    return null
  }

  /** Whether anyone made or changed a comment (or a reply) on the file after `since`; null when it could not be read. */
  async function commentedSince(companyId: string, userId: string, fileId: string, since: string): Promise<boolean | null> {
    const r = await drive(companyId, userId, {
      method: 'GET', path: `/drive/v3/files/${fileId}/comments`,
      query: { fields: 'comments(id,modifiedTime)', startModifiedTime: since, includeDeleted: 'true', pageSize: '1' },
      operation: 'drive.comments.list',
    })
    if (!r.ok || !isObj(r.json)) return null
    return Array.isArray(r.json.comments) && r.json.comments.length > 0
  }

  /**
   * Right after Drive answered a put that made or updated a Google document — inside that request only: its baseline,
   * kept on the receipt only when it is provably ACB's own (google-drive.md "A Google document's own changes"):
   * (a) two exports a moment apart give the same text (not a stale or half-processed one);
   * (b) Drive's processing after the import was observed to its end: nothing is read until `quietMs` after the answer
   *     (it moved the revision's and the file's times ~3–4 s after it), then the newest revision (id, time, count) and the
   *     file (time, last modifier) must be the same in two reads `gapMs` apart; still changing `budgetMs` after the answer
   *     (or after `DOC_BASELINE_MAX_READS` reads) keeps none (`still-settling`);
   * (c) every revision was made last by the member's own account (`lastModifyingUser.me`; ACB writes with their token),
   *     and so was the file's last change (`files.get`: a witness that does not rest on the revision list);
   * (d) exactly one revision is new: the only one of a new document, or the only one after the previous baseline's
   *     revision on an update (that revision still listed) — a second revision, even the member's, is refused;
   * (e) the file's `modifiedTime` and the newest revision's are both within `DOC_BASELINE_WINDOW_MS` after the upload
   *     answer's, never before it.
   * The newest revision's id and time **as observed once settled** are kept; the baseline's time stays the upload
   * answer's (comments are compared from it, the earliest moment ACB's text existed).
   * Not covered (accepted, the same family as the update's If-Match race): an edit merged by Docs into the member's
   * revision during the observation — the member's own (the owner's decision of 2026-11-12: the writer's own edits may be
   * overwritten), or another account's followed by the member's (a merged revision names only its last modifier). Another
   * account's edit that stays its own revision is refused by (c). A put found after a lost answer never gets one.
   * Every drop logs one line naming the failed step; never a file id, name, text or token.
   */
  async function keepDocBaseline(
    companyId: string, row: Pick<DrivePutRow, 'id' | 'userId' | 'mimeType' | 'fileId' | 'state'>, uploadedAt: string | null,
    previousRevision: string | null, answeredAtMs: number,
  ): Promise<void> {
    if (row.mimeType !== DRIVE_DOC_MIME || row.state !== 'done' || !row.fileId) return
    type Step = 'no-upload-time' | 'export-failed' | 'export-differs' | 'no-revision' | 'still-settling' | 'not-me'
      | 'base-revision-gone' | 'revision-count' | 'file-unread' | 'file-not-me' | 'outside-window'
    const drop = (step: Step, detail = '') => log.warn(`[google-drive] document baseline not kept: ${step}${detail}`)
    const fileId = row.fileId
    const uploadMs = uploadedAt ? Date.parse(uploadedAt) : NaN
    if (!uploadedAt || Number.isNaN(uploadMs)) return drop('no-upload-time')
    const first = await docFingerprint(companyId, row.userId, fileId)
    if (!first) return drop('export-failed')
    await settle()
    const second = await docFingerprint(companyId, row.userId, fileId)
    if (!second) return drop('export-failed')
    if (second !== first) return drop('export-differs')

    // (b) The observation: Drive's processing given its time, then two equal reads `gapMs` apart.
    const timing = docTiming()
    await sleepUntil(answeredAtMs + timing.quietMs)
    const snapshot = async (): Promise<{ revisions: DocRevision[]; file: { at: string | null; me: boolean } } | 'no-revision' | 'file-unread'> => {
      const revisions = await docRevisions(companyId, row.userId, fileId)
      if (!revisions) return 'no-revision'
      const f = await drive(companyId, row.userId, {
        method: 'GET', path: `/drive/v3/files/${fileId}`,
        query: { fields: 'modifiedTime,lastModifyingUser(me)', supportsAllDrives: 'true' },
        operation: 'drive.files.get',
      })
      if (!f.ok || !isObj(f.json)) return 'file-unread'
      return { revisions, file: { at: str(f.json.modifiedTime), me: isObj(f.json.lastModifyingUser) && f.json.lastModifyingUser.me === true } }
    }
    let seen = await snapshot()
    if (typeof seen === 'string') return drop(seen)
    let reads = 1
    for (;;) {
      if (reads >= DOC_BASELINE_MAX_READS || performance.now() + timing.gapMs - answeredAtMs > timing.budgetMs) {
        return drop('still-settling', ` (reads: ${reads})`)
      }
      await sleepUntil(performance.now() + timing.gapMs)
      const again = await snapshot()
      reads++
      if (typeof again === 'string') return drop(again)
      const [a, b] = [seen.revisions[seen.revisions.length - 1], again.revisions[again.revisions.length - 1]]
      const same = again.revisions.length === seen.revisions.length && a.id === b.id && a.at === b.at
        && again.file.at === seen.file.at && again.file.me === seen.file.me
      seen = again
      if (same) break
    }
    const { revisions, file } = seen

    // (c) Every revision, not only the new ones: a document ACB made is updated only from a baseline like this one, and
    // the check before an update refuses any new revision, so a revision not the member's never belongs in it.
    const foreign = revisions.filter(r => !r.me).length
    if (foreign > 0) return drop('not-me', ` (revisions: ${revisions.length}, not the member's: ${foreign}, the newest the member's: ${revisions[revisions.length - 1].me})`)
    const newest = revisions[revisions.length - 1]
    // (d) Exactly one new revision: ACB's upload. Post-import processing moves a time, it adds no revision (real Google).
    let fresh = revisions.length
    if (previousRevision !== null) {
      const at = revisions.findIndex(r => r.id === previousRevision)
      if (at < 0) return drop('base-revision-gone', ` (revisions: ${revisions.length})`)
      fresh = revisions.length - 1 - at
    }
    if (fresh !== 1) return drop('revision-count', ` (revisions: ${revisions.length}, new: ${fresh})`)
    if (!file.me) return drop('file-not-me')
    // (e) Both times after the upload answer and within the window (a time not in RFC 3339 UTC form is outside).
    const inWindow = (t: string | null) => {
      const ms = t !== null && isLogStamp(t) ? Date.parse(t) : NaN
      return !Number.isNaN(ms) && ms >= uploadMs && ms - uploadMs <= DOC_BASELINE_WINDOW_MS
    }
    if (!inWindow(file.at) || !inWindow(newest.at)) {
      return drop('outside-window', ` upload=${logStamp(uploadedAt)} file=${logStamp(file.at)} newest-revision=${logStamp(newest.at)} revisions=${revisions.length}`)
    }
    const baseline: DriveDocBaseline = { fingerprint: first, revision: newest.id as string, revisionAt: newest.at as string, at: uploadedAt }
    handle(companyId).googleDrive.setDocBaseline(row.id, baseline)
  }

  /** Looks for ACB's own file of a put whose answer was lost: by the put's id in appProperties. */
  async function reconcile(companyId: string, row: DrivePutRow): Promise<DrivePutRow> {
    if (row.state !== 'unknown' && row.state !== 'sending') return row
    const r = await drive(companyId, row.userId, {
      method: 'GET', path: '/drive/v3/files',
      query: {
        q: `appProperties has { key='acbPutId' and value='${row.id}' } and trashed = false`,
        fields: 'files(id,headRevisionId,version,webViewLink)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '2',
      },
      operation: 'drive.files.list',
    })
    if (!r.ok) return row
    const files = isObj(r.json) && Array.isArray(r.json.files) ? r.json.files.filter(isObj) : []
    const found = files[0]
    if (!found || !isDriveId(found.id)) return row
    const settled = {
      state: 'done' as const, fileId: found.id as string, revisionId: driveRevisionOf(found.headRevisionId, found.version), link: str(found.webViewLink),
      reason: 'found-by-correlation', finishedAt: clock.now(),
    }
    // No fingerprint here: found after a lost answer (maybe much later), the text now may not be what ACB uploaded.
    handle(companyId).googleDrive.settlePut(row.id, settled)
    return { ...row, ...settled }
  }

  /**
   * Checks each picked id with Google (drive.file answers only for picks): what may be kept, how many were refused and why.
   * `purpose` (files): `read` keeps only types the AI reads; `link` any file (owner decision 2026-11-14, 「つなぐだけ」).
   * `sharing` (a pick ticket's folder): who sees what is put there, read right after the pick and said to the person.
   */
  async function checkPicks(member: Member, body: unknown, purpose: DrivePickPurpose = 'read', sharing = false): Promise<Outcome<{ rows: DrivePickRow[]; refused: number; why: DrivePickRefusedWhy; sharing: Map<string, DriveFolderSharing> }>> {
    if (!isObj(body) || !isDrivePickMode(body.mode)) return refuse('bad-request', 'mode must be folder or files')
    const max = body.mode === 'folder' ? 1 : DRIVE_PICK_MAX_FILES
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > max || !body.ids.every(isDriveId)) {
      return refuse('bad-request', `ids must list 1–${max} Drive ids`)
    }
    const kind = body.mode === 'folder' ? 'folder' : 'file'
    const now = clock.now()
    const expiresAt = new Date(clock.nowMs() + DRIVE_PICK_TTL_MS[kind]).toISOString()
    const rows: DrivePickRow[] = []
    let refused = 0
    const why: DrivePickRefusedWhy = {}
    const refuseOne = (reason: keyof DrivePickRefusedWhy) => { refused++; why[reason] = (why[reason] ?? 0) + 1 }
    const shared = new Map<string, DriveFolderSharing>()
    for (const id of [...new Set(body.ids as string[])]) {
      const r = await meta(member.companyId, member.userId, id)
      if (!r.ok) {
        if (r.kind === 'refused') { refuseOne('no-access'); continue }
        return googleRefusal(r, '')
      }
      const f = isObj(r.json) ? r.json : {}
      const mimeType = str(f.mimeType) ?? ''
      const name = (str(f.name) ?? '').normalize('NFC').slice(0, 300)
      const canAdd = isObj(f.capabilities) && f.capabilities.canAddChildren === true
      if (f.id !== id || name === '') { refuseOne('no-access'); continue }
      if (f.trashed === true) { refuseOne('gone'); continue }
      if (kind === 'folder' && mimeType !== DRIVE_FOLDER_MIME) { refuseOne('not-folder'); continue }
      if (kind === 'folder' && !canAdd) { refuseOne('cannot-add'); continue }
      if (kind === 'file' && !drivePickableFor(purpose, mimeType)) {
        // A folder or a shortcut is not "a type the AI cannot read": its own words (review of #690).
        refuseOne(mimeType === DRIVE_FOLDER_MIME ? 'folder' : mimeType === 'application/vnd.google-apps.shortcut' ? 'shortcut' : 'type')
        continue
      }
      rows.push({ userId: member.userId, fileId: id, kind, name, mimeType, pickedAt: now, expiresAt })
      if (kind === 'folder' && sharing) {
        // Said right after the pick (the put asks again and refuses the AI): nobody outside the company, or not known.
        const domain = handle(member.companyId).connectors.client()?.domain
        // A failure here (even a thrown one) never fails the pick: the sharing is then not known (the put asks again).
        const perms = domain ? await folderPermissions(member.companyId, member.userId, id).catch(() => null) : null
        shared.set(id, !domain || perms === null || !Array.isArray(perms) ? 'unknown' : driveFolderReachesOutside(perms, domain) ? 'outside' : 'inside')
      }
    }
    return ok({ rows, refused, why, sharing: shared })
  }

  /** Keeps checked picks (a re-pick renews them). Synchronous: called in the same stretch as the ticket's compare-and-set. */
  function keepPicks(member: Member, rows: DrivePickRow[]): void {
    const h = handle(member.companyId).googleDrive
    h.prunePicks(clock.now())
    if (rows.length > 0) h.savePicks(rows)
  }

  /** POST …/me/google/drive/picks: keeps what the person picked, each checked with Google. */
  async function savePicks(member: Member, body: unknown): Promise<Outcome<DrivePicksResult>> {
    const checked = await checkPicks(member, body)
    if (!checked.ok) return checked
    keepPicks(member, checked.value.rows)
    return ok({ picks: checked.value.rows.map(pickView), refused: checked.value.refused })
  }

  /** The Picker is registered and the member has the Drive permission (else the app asks Google first). */
  function pickReady(member: Member): Refusal | null {
    const c = handle(member.companyId).connectors
    if (!c.picker()) return refuse('conflict', PICKER_NOT_CONFIGURED, { code: 'DRIVE_PICKER_NOT_CONFIGURED' })
    const grant = c.grant('google', member.userId)
    if (!grant || grant.status !== 'active' || !grant.scopes.includes(GOOGLE_SCOPE.driveFile)) {
      return refuse('conflict', NO_CONSENT, { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'drive' })
    }
    if (grant.featuresOff.includes('drive')) return refuse('conflict', FEATURE_OFF, { code: 'GOOGLE_FEATURE_OFF', feature: 'drive' })
    return null
  }

  const ticketHash = (ticket: string) => deps.sha256(new TextEncoder().encode(ticket))

  /**
   * The open, unexpired ticket a Picker page names: found by the ticket's sha256 (the control plane's lookup
   * answers its company, like a key-broker token), then read through that company's handle. Anything else
   * (unknown, expired, used, cancelled) is null and answered alike.
   */
  function ticketOf(body: unknown) {
    if (!isObj(body) || !isDrivePickTicket(body.ticket)) return null
    const hash = ticketHash(body.ticket)
    const companyId = deps.pickTickets.companyOf(hash)
    if (!companyId) return null
    const h = handle(companyId).googleDrive
    const row = h.pickTicketByHash(hash)
    if (!row || row.state !== 'open' || clock.nowMs() >= Date.parse(row.expiresAt)) return null
    return { h, row, companyId }
  }

  return {
    /** Where the Picker page loads Google's script from (its CSP names it). */
    pickerScriptOrigin: deps.pickerScriptOrigin,

    /**
     * GET /api/records-ai/google/drive/status: whether the Drive tools work, the member's grant, live picks and
     * the files their puts made (what `drive_put` may update): one entry per Drive file (its latest put), newest first,
     * `PUT_FILES_LISTED` at a time (`putsNext` reads on with `putsBefore`); `fileId`: just that file, whatever its age
     * (what the app checks before an overwrite). `scope` (a scheduled job's run): only its folder.
     */
    async aiStatus(member: Member, scope?: DriveJobScope, query: { fileId?: unknown; putsBefore?: unknown } = {}): Promise<Outcome<DriveAiStatus>> {
      const h = handle(member.companyId)
      const grant = h.connectors.grant('google', member.userId)
      const now = clock.now()
      // A job's run: its own folder only, selected in the query (never cut off by the member's other picks and puts),
      // and only the files runs of the same job made (what it may update).
      const scopedPick = scope ? h.googleDrive.pick(member.userId, scope.folderId, now) : null
      const picks = scope ? (scopedPick && scopedPick.kind === 'folder' ? [scopedPick] : []) : h.googleDrive.picks(member.userId, now, PICKS_LISTED)
      // The cursor is the last row's time and put id (`<createdAt>|<id>`): files put in the same instant are never skipped.
      const cursor = typeof query.putsBefore === 'string' ? /^(\d{4}-\d{2}-\d{2}T[\d:.]{8,15}Z)\|(drive-put-[A-Za-z0-9_-]{1,80})$/.exec(query.putsBefore) : null
      const before = cursor ? { createdAt: cursor[1], id: cursor[2] } : undefined
      let rows: DrivePutRow[]
      let next: string | undefined
      if (query.fileId !== undefined) {
        // One file (eligibility is per file: `putOfFile`, as the put itself checks), never cut off by a list's length.
        const one = isDriveId(query.fileId) ? h.googleDrive.putOfFile(member.userId, query.fileId) : null
        rows = one && (!scope || one.folderId === scope.folderId) ? [one] : []
      } else {
        rows = h.googleDrive.donePutFiles(member.userId, { limit: PUT_FILES_LISTED + 1, ...(scope ? { folderId: scope.folderId } : {}), ...(before ? { before } : {}) })
        if (rows.length > PUT_FILES_LISTED) {
          rows = rows.slice(0, PUT_FILES_LISTED)
          next = `${rows[rows.length - 1].createdAt}|${rows[rows.length - 1].id}`
        }
      }
      const puts: DriveUpdatableFile[] = []
      for (const p of rows) {
        if (!p.fileId) continue
        if (scope && (!p.runId || !scope.sameJob(p.runId))) continue
        puts.push({ fileId: p.fileId, name: p.name, mimeType: p.mimeType, folderId: p.folderId, link: p.link, revisionId: p.revisionId, at: p.finishedAt ?? p.createdAt })
      }
      const isAvailable = await available(member.companyId)
      // Google is on but the admin has not registered the Picker: the AI is told why there are no Drive tools.
      const pickerMissing = !isAvailable && !(await deps.operatorStopped()) && !!h.connectors.client()?.enabled && deps.vaultEnabled() && h.connectors.picker() === null
      return ok({
        available: isAvailable,
        granted: grant?.status === 'active' && grant.scopes.includes(GOOGLE_SCOPE.driveFile),
        picks: picks.map(pickView),
        puts,
        ...(next ? { putsNext: next } : {}),
        ...(pickerMissing ? { reason: 'picker-not-configured' as const } : {}),
      })
    },

    /**
     * POST …/me/google/drive/picker { mode } (session): the old Picker window's token (released apps up to
     * release-20261109). Fails closed: Google Picker does not work inside the app's own window (Google needs a
     * signed-in browser and blocks signing in inside embedded browsers), and the token is now handed out only
     * through a one-time pick ticket to the page in the member's browser (`startPick`).
     */
    async pickerSession(_member: Member, body: unknown): Promise<Outcome<never>> {
      if (!isObj(body) || !isDrivePickMode(body.mode)) return refuse('bad-request', 'mode must be folder or files')
      return refuse('conflict', APP_UPDATE_NEEDED, { code: 'DRIVE_PICKER_APP_UPDATE_NEEDED' })
    },

    /**
     * POST …/me/google/drive/pick-tickets { mode, fileIds? } (session): a one-time pick ticket for the Picker
     * page the app opens in the member's browser (google-drive.md "Picker and its token"). Bound to the
     * company (the row's), the member, the mode and its maximum; 10 minutes; only the ticket's sha256 is
     * kept. Nothing is asked of Google here: the page gets the token with the ticket.
     */
    async startPick(member: Member, body: unknown): Promise<Outcome<DrivePickTicketStarted>> {
      if (!isObj(body) || !isDrivePickMode(body.mode)) return refuse('bad-request', 'mode must be folder or files')
      const mode = body.mode
      if (body.purpose !== undefined && !isDrivePickPurpose(body.purpose)) return refuse('bad-request', 'purpose must be read or link')
      // `link` (a person linking files to a record) is a files pick only; anything else reads (the AI's).
      const purpose: DrivePickPurpose = mode === 'files' && body.purpose === 'link' ? 'link' : 'read'
      if (await deps.operatorStopped()) return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
      const ready = pickReady(member)
      if (ready) return ready
      if (!(await available(member.companyId))) return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
      const h = handle(member.companyId).googleDrive
      const now = clock.now()
      // Only tickets well past their end (and past a pick still being kept) go: a result the app has not read yet stays.
      h.prunePickTickets(new Date(clock.nowMs() - DRIVE_PICK_TICKET_KEPT_AFTER_MS).toISOString())
      if (h.openPickTickets(member.userId, now) >= DRIVE_PICK_TICKETS_OPEN_MAX) {
        return refuse('rate-limited', 'Google Drive から選ぶ画面が、もういくつも開いています。ブラウザで選び終えるか閉じてから、もう一度お試しください。', { code: 'PICK_TICKETS_TOO_MANY' })
      }
      const ticket = ids.newToken()
      // From the same instant as createdAt (two clock reads made the stored lifetime 1 ms longer now and then).
      const expiresAt = new Date(Date.parse(now) + DRIVE_PICK_TICKET_TTL_MS).toISOString()
      const id = ids.newId()
      h.createPickTicket({
        id, userId: member.userId, ticketHash: ticketHash(ticket), mode, purpose, maxItems: mode === 'folder' ? 1 : DRIVE_PICK_MAX_FILES,
        fileIds: mode === 'files' ? drivePreselectIds(body.fileIds) : [], state: 'open', configHandedAt: null, result: null,
        createdAt: now, expiresAt, finishedAt: null,
      })
      return ok({ ticketId: id, ticket, expiresAt })
    },

    /**
     * GET …/me/google/drive/pick-tickets/:ticketId (session, the member's own ticket only): waiting (and
     * whether the person's choice is being kept), or the result. A result can be read again until the app
     * acknowledges it (DELETE) or the ticket is pruned well after its end: a lost answer loses nothing.
     */
    pickState(member: Member, ticketId: string): Outcome<DrivePickTicketState> {
      const row = handle(member.companyId).googleDrive.pickTicket(member.userId, ticketId)
      if (!row) return TICKET_NOT_FOUND
      if (row.state === 'picked') return ok(pickedState(row.result))
      if (row.state === 'cancelled') return ok({ state: 'cancelled' })
      if (row.state === 'failed') return ok({ state: 'failed', error: failedError(row.result) })
      // Saving asks Google about a few ids: it may finish a little after the ticket's end.
      const overAt = Date.parse(row.expiresAt) + (row.state === 'saving' ? DRIVE_PICK_SAVING_GRACE_MS : 0)
      if (clock.nowMs() >= overAt) return ok({ state: 'expired' })
      return ok({ state: 'waiting', opened: row.configHandedAt !== null, ...(row.state === 'saving' ? { saving: true } : {}) })
    },

    /**
     * DELETE …/me/google/drive/pick-tickets/:ticketId (session): the app read the result, or stopped waiting.
     * The ticket is removed; a page still using it gets nothing more, and a pick being kept meanwhile is not
     * kept (its compare-and-set finds no ticket).
     */
    cancelPick(member: Member, ticketId: string): Outcome<{ closed: true }> {
      const h = handle(member.companyId).googleDrive
      if (!h.pickTicket(member.userId, ticketId)) return TICKET_NOT_FOUND
      h.dropPickTicket(member.userId, ticketId)
      return ok({ closed: true })
    },

    /**
     * POST /api/google-picker/config { ticket } (public; the page in the member's browser): the Picker's
     * config — the drive.file token, the API key, the app id, the Google account to use — once per ticket,
     * while it is open and not expired; the member must still be one. A refusal after the claim closes the
     * ticket as failed (the app says why); a ticket closed while Google was asked gets nothing.
     */
    async pageConfig(body: unknown): Promise<Outcome<DrivePickerPageConfig>> {
      const found = ticketOf(body)
      if (!found) return TICKET_GONE
      const { h, row, companyId } = found
      if (!h.claimPickTicketConfig(row.id, clock.now())) return TICKET_GONE
      const fail = (r: Refusal): Refusal => {
        h.movePickTicket(row.id, ['open'], 'failed', { result: JSON.stringify({ error: r.body.error }), finishedAt: clock.now() })
        return r
      }
      const member = deps.memberOf(companyId, row.userId)
      if (!member) return fail(TICKET_GONE)
      if (await deps.operatorStopped()) return fail(refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' }))
      const connectors = handle(companyId).connectors
      const picker = connectors.picker()
      if (!picker) return fail(refuse('conflict', PICKER_NOT_CONFIGURED, { code: 'DRIVE_PICKER_NOT_CONFIGURED' }))
      const token = await google.pickerToken(companyId, member.userId)
      if (!token.ok) {
        if (token.reason === 'picker-scope-too-wide') {
          return fail(refuse('unavailable', 'Google から、Drive のファイル選びに必要な分より広い許可が届いたため、使いませんでした。管理者に知らせてください。', { code: 'DRIVE_PICKER_SCOPE' }))
        }
        return fail(googleRefusal({ ok: false, kind: 'not-sent', reason: token.reason as never }, '') as Refusal)
      }
      // The app may have stopped waiting while Google answered: then the token goes nowhere.
      const still = h.pickTicketByHash(row.ticketHash)
      if (!still || still.state !== 'open' || still.id !== row.id) return TICKET_GONE
      const account = connectors.grant('google', member.userId)?.accountEmail ?? null
      return ok({
        accessToken: token.accessToken, apiKey: picker.apiKey, appId: picker.appId, scriptOrigin: deps.pickerScriptOrigin, mode: row.mode,
        // Linking offers every file type (「AI では中身を読めません」 for the ones drive_read cannot read); reading, the readable ones.
        ...(row.mode === 'files' ? { purpose: row.purpose } : {}),
        mimeTypes: row.mode === 'files' && row.purpose === 'link' ? [] : DRIVE_PICKABLE_MIMES, maxItems: row.maxItems, ...(row.mode === 'files' && row.fileIds.length > 0 ? { fileIds: row.fileIds } : {}),
        ...(account ? { account } : {}),
      })
    },

    /**
     * POST /api/google-picker/result { ticket, mode, action: picked | cancel, ids? } (public; the page): the
     * person's choice, once per ticket. A pick needs the config handed out first, the ticket's mode and at
     * most its maximum of Drive ids; it is checked exactly as `POST /me/google/drive/picks` checks it, for the
     * member the ticket belongs to, and kept only if the ticket is still being saved (one synchronous
     * compare-and-set with the write: a ticket the app closed meanwhile keeps nothing). 「キャンセル」 or the
     * page closed = cancelled.
     */
    async pageResult(body: unknown): Promise<Outcome<{ state: 'picked' | 'cancelled'; kept: number; refused: number; message?: string }>> {
      const found = ticketOf(body)
      if (!found) return TICKET_GONE
      const { h, row, companyId } = found
      const b = body as Record<string, unknown>
      if (b.action === 'cancel') {
        if (!h.movePickTicket(row.id, ['open'], 'cancelled', { finishedAt: clock.now() })) return TICKET_GONE
        return ok({ state: 'cancelled', kept: 0, refused: 0 })
      }
      if (b.action !== 'picked') return refuse('bad-request', 'action must be picked or cancel')
      if (row.configHandedAt === null) return TICKET_GONE
      if (b.mode !== row.mode) return refuse('bad-request', 'mode does not match the ticket')
      if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > row.maxItems || !b.ids.every(isDriveId)) {
        return refuse('bad-request', `ids must list 1–${row.maxItems} Drive ids`)
      }
      if (!h.movePickTicket(row.id, ['open'], 'saving', {})) return TICKET_GONE
      const failed = (error: string) => h.movePickTicket(row.id, ['saving'], 'failed', { result: JSON.stringify({ error }), finishedAt: clock.now() })
      const member = deps.memberOf(companyId, row.userId)
      if (!member) {
        failed(TICKET_GONE.body.error)
        return TICKET_GONE
      }
      let checked: Awaited<ReturnType<typeof checkPicks>>
      try {
        checked = await checkPicks(member, { mode: row.mode, ids: b.ids }, row.purpose, true)
      } catch (error) {
        failed(GOOGLE_UNAVAILABLE_TEXT)
        throw error
      }
      if (!checked.ok) {
        failed(checked.body.error)
        return checked
      }
      const { rows, refused, why, sharing } = checked.value
      const picks = rows.map(r => ({ ...pickView(r), ...(sharing.has(r.fileId) ? { sharing: sharing.get(r.fileId) } : {}) }))
      const result: DrivePicksResult & { refusedWhy: DrivePickRefusedWhy } = { picks, refused, refusedWhy: why }
      // No await between the compare-and-set and the write: nothing else can run in between.
      if (!h.movePickTicket(row.id, ['saving'], 'picked', { result: JSON.stringify(result), finishedAt: clock.now() })) return TICKET_GONE
      keepPicks(member, rows)
      // What the page says (the app says it too): how many were not usable and why; a folder the AI cannot put into.
      const notUsable = drivePickRefusedText(refused, why)
      const outside = picks.map(p => driveFolderSharingText(p.sharing)).find(t => t !== null) ?? null
      const message = rows.length === 0
        ? `選んだものは使えませんでした。${notUsable ?? ''}アプリに戻って、選び直してください。`
        : `選びました。${notUsable ?? ''}${outside ?? ''}アプリに戻ってください。`
      return ok({ state: 'picked', kept: rows.length, refused, message })
    },

    /** POST …/me/google/drive/picks { mode, ids } (session): keeps what the person picked, each checked with Google. */
    savePicks,

    /**
     * A file the member picked, checked for linking it to a record (session only; the records route
     * asks it before the engine links, records.md "Drive and PC file links"). Only the
     * member's own live pick of a file, or a file their own put made (done), opened with their own
     * `drive.file` token — never anyone else's, never to look at a file someone else linked. The revision is Drive's `headRevisionId`
     * (a binary file) or `version:<n>` (a Google document, which has no head revision); the sha256 is
     * over the bytes ACB read (Docs / Slides / Sheets exported as `read` does, others downloaded,
     * ≤ 10 MB), null when that failed or the type cannot be read. Nothing of the content is kept.
     */
    async linkable(member: Member, fileId: unknown): Promise<Outcome<DriveLinkableFile>> {
      if (!isDriveId(fileId)) return refuse('bad-request', 'fileId must be a Drive id')
      const h = handle(member.companyId).googleDrive
      const live = h.pick(member.userId, fileId, clock.now())
      // A live pick of a file, or a file the member's own put made (ACB created it, so drive.file opens it).
      const pick = live?.kind === 'file' ? live : null
      const put = pick ? null : h.putOfFile(member.userId, fileId)
      if (!pick && !put) {
        return refuse('forbidden', 'Google Drive で選んだファイルだけをつなげます。もう一度選んでください。', { code: 'DRIVE_NOT_PICKED' })
      }
      const knownName = pick?.name ?? put?.name ?? ''
      const noAccess = 'このファイルを Google Drive から開けませんでした（消されたか、見られなくなった可能性があります）。'
      const m = await drive(member.companyId, member.userId, {
        method: 'GET', path: `/drive/v3/files/${fileId}`,
        query: { fields: 'id,name,mimeType,trashed,headRevisionId,version', supportsAllDrives: 'true' },
        operation: 'drive.files.get',
      })
      if (!m.ok) return googleRefusal(m, noAccess)
      const f = isObj(m.json) ? m.json : {}
      if (f.trashed === true || f.id !== fileId) return refuse('forbidden', noAccess, { code: 'DRIVE_NO_ACCESS' })
      const mimeType = str(f.mimeType)
      const revisionId = driveRevisionOf(f.headRevisionId, f.version)
      const how = mimeType ? DRIVE_READ_AS[mimeType] : undefined
      let sha256: string | null = null
      if (how) {
        const r = how.how === 'export'
          ? await drive(member.companyId, member.userId, { method: 'GET', path: `/drive/v3/files/${fileId}/export`, query: { mimeType: how.mime }, binary: true, operation: 'drive.files.export' })
          : await drive(member.companyId, member.userId, { method: 'GET', path: `/drive/v3/files/${fileId}`, query: { alt: 'media', supportsAllDrives: 'true' }, binary: true, operation: 'drive.files.download' })
        if (r.ok && r.bytes && r.bytes.byteLength <= DRIVE_READ_PDF_MAX_BYTES) sha256 = deps.sha256(r.bytes)
      }
      return ok({ fileId, revisionId, name: (str(f.name) ?? knownName).normalize('NFC').slice(0, 300), mimeType, sha256 })
    },

    /**
     * The file a put of this member made, to link it to the consultation's record right after the put
     * (records.md "Drive and PC file links"): the receipt is the proof — the member's own
     * put, done, Drive's file id known. Its facts come from the receipt (the revision Drive answered,
     * the name as put, the sha256 of the bytes ACB uploaded); Google is not asked again. Null otherwise.
     */
    putLinkable(member: Member, putId: string): DriveLinkableFile | null {
      const row = handle(member.companyId).googleDrive.put(member.userId, putId)
      if (!row || row.state !== 'done' || !row.fileId || !isDriveId(row.fileId)) return null
      return { fileId: row.fileId, revisionId: row.revisionId, name: row.name, mimeType: row.mimeType, sha256: row.sha256 }
    },

    /**
     * GET …/me/google/drive/files (session): the member's own Drive files ACB may open — live picks of a
     * file and the files their puts made — with their names (the member's own), newest first, for the
     * app's 「Google Drive のファイルをつなぐ」. Only the caller's own rows; nothing asked of Google.
     * Empty while Drive is not available for the company (the app then opens the Picker, which says why).
     */
    async ownFiles(member: Member): Promise<Outcome<DriveOwnFiles>> {
      if (!(await available(member.companyId))) return ok({ files: [] })
      const h = handle(member.companyId).googleDrive
      const now = clock.now()
      const out = new Map<string, DriveOwnFile>()
      // File picks only, in the query: folder picks never take a place of the 30.
      for (const p of h.picksOfKind(member.userId, 'file', now, OWN_FILES_LISTED)) {
        out.set(p.fileId, { id: p.fileId, name: p.name, mimeType: p.mimeType, source: 'picked', at: p.pickedAt })
      }
      // One entry per file (its latest put): re-putting one file never pushes another out of the list.
      for (const p of h.donePutFiles(member.userId, { limit: OWN_FILES_LISTED })) {
        if (p.fileId && !out.has(p.fileId)) out.set(p.fileId, { id: p.fileId, name: p.name, mimeType: p.mimeType, source: 'put', at: p.finishedAt ?? p.createdAt })
      }
      return ok({ files: [...out.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, OWN_FILES_LISTED) })
    },

    /**
     * POST /api/records-ai/google/drive/read { fileId } (any token): the member's own live pick of a file, or a file
     * their own put made (`putOfFile`: this member, this company, a done receipt — ACB created it, so their `drive.file`
     * token opens it; owner decision 2026-11-13), as outside text (or a PDF's bytes). Never another member's put.
     */
    async read(member: Member, body: unknown): Promise<Outcome<DriveReadAnswer>> {
      if (!isObj(body) || !isDriveId(body.fileId)) return refuse('bad-request', 'fileId must be a Drive id')
      const fileId = body.fileId
      const h = handle(member.companyId).googleDrive
      const live = h.pick(member.userId, fileId, clock.now())
      const pick = live?.kind === 'file' ? live : null
      const put = pick ? null : h.putOfFile(member.userId, fileId)
      if (!pick && !put) {
        return refuse('forbidden', 'このファイルはメンバーが選んだものでも、このメンバーの drive_put で置いたものでもありません。drive_pick_files でメンバーに選んでもらってください。', { code: 'DRIVE_NOT_PICKED' })
      }
      const knownName = pick?.name ?? put?.name ?? ''
      const noAccess = 'このファイルを Google Drive から開けませんでした（消されたか、見られなくなった可能性があります）。'
      const m = await meta(member.companyId, member.userId, fileId)
      if (!m.ok) return googleRefusal(m, noAccess)
      const f = isObj(m.json) ? m.json : {}
      const mimeType = str(f.mimeType) ?? ''
      const how = DRIVE_READ_AS[mimeType]
      if (!how || f.trashed === true) return refuse('bad-request', 'この種類のファイルは読めません（Google ドキュメント・スライド・スプレッドシート、PDF、テキスト・Markdown・CSV・HTML・JSON だけ）。', { code: 'DRIVE_TYPE_UNREADABLE' })
      const file = { id: fileId, name: (str(f.name) ?? knownName).normalize('NFC'), mimeType, modifiedTime: str(f.modifiedTime) }
      const base = { file, header: DRIVE_TEXT_HEADER, footer: DRIVE_TEXT_FOOTER }
      if (how.how === 'download' && how.kind === 'pdf') {
        const r = await drive(member.companyId, member.userId, { method: 'GET', path: `/drive/v3/files/${fileId}`, query: { alt: 'media', supportsAllDrives: 'true' }, binary: true, operation: 'drive.files.download' })
        if (!r.ok) return googleRefusal(r, noAccess)
        const bytes = r.bytes ?? new Uint8Array()
        if (bytes.byteLength > DRIVE_READ_PDF_MAX_BYTES) return refuse('bad-request', 'この PDF は大きすぎて読めません（10 MB まで）。', { code: 'DRIVE_FILE_TOO_LARGE' })
        if (checkDrivePutContent('pdf', bytes) !== null && bytes.byteLength <= DRIVE_PUT_MAX_BYTES) return refuse('bad-request', 'PDF として読めませんでした。', { code: 'DRIVE_TYPE_UNREADABLE' })
        return ok({ ...base, text: null, truncated: false, pdfBase64: Buffer.from(bytes).toString('base64'), instructionLike: [] })
      }
      const r = how.how === 'export'
        ? await drive(member.companyId, member.userId, { method: 'GET', path: `/drive/v3/files/${fileId}/export`, query: { mimeType: how.mime }, binary: true, operation: 'drive.files.export' })
        : await drive(member.companyId, member.userId, { method: 'GET', path: `/drive/v3/files/${fileId}`, query: { alt: 'media', supportsAllDrives: 'true' }, binary: true, operation: 'drive.files.download' })
      if (!r.ok) return googleRefusal(r, noAccess)
      let text = cleanExportText(new TextDecoder().decode(r.bytes ?? new Uint8Array()))
      const truncated = text.length > DRIVE_READ_TEXT_MAX
      if (truncated) text = text.slice(0, DRIVE_READ_TEXT_MAX) + TRUNCATED
      return ok({
        // 【】 → 〔〕 (outside-text.ts): the text cannot close the block, in an older app too.
        ...base, text: neutralizeOutsideText(text), truncated, pdfBase64: null,
        instructionLike: [...new Set([...outsideTextFlags(text), ...outsideTextFlags(decodedForFlags(text, mimeType) ?? '')])]
          .map(label => ({ label, words: INSTRUCTION_LIKE_WORDS[label] ?? label })),
      })
    },

    /**
     * POST /api/records-ai/google/drive/put (act token): a PDF / HTML / Markdown / text file as is into a picked folder,
     * or HTML / Markdown converted into a Google document (`as: 'google_doc'`); with `updateFileId`, a new revision of a file an
     * earlier put of this member made in that same folder (google-drive.md "Overwriting"). `scope` (a scheduled
     * job's run, jobs.md "A deliverable place outside"): only into that one folder — checked here at every call.
     */
    async put(member: Member, actor: DriveActor, body: unknown, scope?: DriveJobScope): Promise<Outcome<DrivePutAnswer>> {
      if (!isObj(body)) return refuse('bad-request', 'Body must be a JSON object')
      if (!isDriveId(body.folderId)) return refuse('bad-request', 'folderId must be a Drive id')
      const form = drivePutForm(body.kind, body.as)
      if (!form) return refuse('bad-request', 'Google Drive に置けるのは PDF・HTML・Markdown（.md）・テキスト（.txt）のファイル（そのまま）、または Google ドキュメントにする HTML と Markdown だけです。', { code: 'DRIVE_TYPE_REFUSED' })
      const named = checkDriveFileName(body.name, form.kind, form.as)
      if ('error' in named) return refuse('bad-request', named.error, { code: 'DRIVE_NAME_REFUSED' })
      if (typeof body.requestKey !== 'string' || !REQUEST_KEY_RE.test(body.requestKey)) return refuse('bad-request', 'requestKey is 8–100 letters, digits, . _ : -')
      if (typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)) return refuse('bad-request', 'sha256 must be 64 lower-case hex characters')
      if (body.updateFileId !== undefined && !isDriveId(body.updateFileId)) return refuse('bad-request', 'updateFileId must be a Drive id')
      const updateFileId = body.updateFileId as string | undefined
      if (typeof body.contentBase64 !== 'string' || body.contentBase64.length > Math.ceil(DRIVE_PUT_MAX_BYTES / 3) * 4 + 4) {
        return refuse('bad-request', `ファイルが大きすぎます（${DRIVE_PUT_MAX_BYTES / 1024 / 1024} MB まで）。`, { code: 'DRIVE_FILE_TOO_LARGE' })
      }
      const bytes = new Uint8Array(Buffer.from(body.contentBase64, 'base64'))
      if (deps.sha256(bytes) !== body.sha256) return refuse('bad-request', 'ファイルの中身が送る途中で変わりました。もう一度お試しください。', { code: 'DRIVE_CONTENT_MISMATCH' })
      const contentProblem = checkDrivePutContent(form.kind, bytes)
      if (contentProblem) return refuse('bad-request', contentProblem, { code: 'DRIVE_CONTENT_REFUSED' })
      // Drive's conversion fetches what a document points to (an image, a stylesheet): nothing may reach outside that way.
      // A file put as is is stored as its bytes (nothing converted or fetched): not asked (google-drive.md "Markdown and text as they are").
      if (form.as === 'google_doc' && driveDocFetchesOutside(form.kind, new TextDecoder().decode(bytes))) {
        return refuse('bad-request', DRIVE_DOC_REFUSED_OUTSIDE, { code: 'DRIVE_EXTERNAL_RESOURCE', alternative: 'as: file' })
      }
      // A scheduled job's run: the one folder its responsible person chose, nothing else.
      if (scope && body.folderId !== scope.folderId) {
        return refuse('forbidden', 'この定期の仕事が置けるのは、責任者が選んだフォルダだけです。', { code: 'DRIVE_FOLDER_NOT_GRANTED' })
      }

      const h = handle(member.companyId)
      const now = clock.now()
      const folderPick = h.googleDrive.pick(member.userId, body.folderId, now)
      if (!folderPick || folderPick.kind !== 'folder') {
        return refuse('forbidden', 'このフォルダはメンバーが選んだものではありません。drive_pick_folder でメンバーに置き場所を選んでもらってください。', { code: 'DRIVE_FOLDER_NOT_PICKED' })
      }
      // Overwriting: only a file this member's own put made (ACB made it), in this same folder, of the same kind.
      let target: DrivePutRow | null = null
      if (updateFileId !== undefined) {
        target = h.googleDrive.putOfFile(member.userId, updateFileId)
        if (!target) {
          return refuse('forbidden', 'このファイルは、このメンバーの drive_put で作ったものではないため、上書きできません。新しいファイルとして置いてください。', { code: 'DRIVE_FILE_NOT_OURS' })
        }
        if (target.folderId !== body.folderId) {
          return refuse('forbidden', 'このファイルは、このフォルダに置いたものではないため、上書きできません。', { code: 'DRIVE_FILE_NOT_IN_FOLDER' })
        }
        if (target.mimeType !== form.driveMime) {
          return refuse('bad-request', '上書きは同じ種類どうしだけです（Google ドキュメントは Google ドキュメントで、PDF は PDF で、HTML は HTML で、Markdown（.md）は Markdown で、テキストはテキストで）。', { code: 'DRIVE_UPDATE_KIND_MISMATCH' })
        }
        // A job's run updates only what runs of the same job made (never a file of a consultation or another job).
        if (scope && (!target.runId || !scope.sameJob(target.runId))) {
          return refuse('forbidden', 'この定期の仕事が上書きできるのは、この仕事が前に置いたファイルだけです。新しいファイルとして置いてください。', { code: 'DRIVE_FILE_NOT_THIS_JOB' })
        }
        // A file a decision or an attachment rests on keeps its revision: never overwritten (Drive may drop old revisions).
        if (h.records.driveFileFixed(updateFileId as string)) {
          return refuse('conflict', 'このファイルは決めたことや添付の根拠として記録されているため、上書きしません。新しいファイルとして置いてください。', { code: 'DRIVE_FILE_FIXED' })
        }
      }
      const targetId = target ? updateFileId as string : null

      const id = `drive-put-${ids.newId()}`.replace(/[^A-Za-z0-9_-]/g, '')
      const row: DrivePutRow = {
        id, userId: member.userId, requestKey: body.requestKey, actorKind: actor.kind, conversationId: actor.conversationId, runId: actor.runId,
        // An update keeps the Drive file's name (Drive is not asked to rename it): the receipt says the name it has.
        folderId: body.folderId, folderName: folderPick.name, name: target ? target.name : named.name, mimeType: form.driveMime, bytes: bytes.byteLength, sha256: body.sha256,
        state: 'sending', fileId: null, revisionId: null, link: null, reason: null, createdAt: now, finishedAt: null, skills: null, updatedFileId: targetId,
        docBaseline: null,
      }

      // The receipt first: the same request (the app's key: same file, folder, name, form and target) is answered with what it made.
      const claimed = h.googleDrive.claimPut(row)
      if (!claimed.claimed) {
        const e = claimed.existing
        if (e.folderId !== row.folderId || e.name !== row.name || e.sha256 !== row.sha256 || e.mimeType !== row.mimeType || e.updatedFileId !== row.updatedFileId) {
          return refuse('conflict', 'この requestKey は別のファイルに使われています。', { code: 'DRIVE_PUT_KEY_REUSED' })
        }
        if (e.state === 'sending') return refuse('conflict', 'このファイルはいま Google Drive に置いているところです。', { code: 'DRIVE_PUT_IN_PROGRESS' })
        // done, or unknown (looked up again; never re-sent).
        return ok({ drivePut: putView(await reconcile(member.companyId, e)), existing: true })
      }
      // What the receipt copied (the AI's consultation's Skills, records.md "Which Skill").
      row.skills = claimed.skills

      // Before the upload: the folder is still a folder ACB may add to, and (for the AI) nobody outside sees it;
      // an update's file is still there, in that folder, editable, and (for the AI) not shared outside by itself.
      const refusedBefore = await (async (): Promise<Outcome<never> | null> => {
        const m = await meta(member.companyId, member.userId, row.folderId)
        if (!m.ok) return googleRefusal(m, 'この置き場所を Google Drive で開けませんでした（消されたか、見られなくなった可能性があります）。')
        const f = isObj(m.json) ? m.json : {}
        if (f.mimeType !== DRIVE_FOLDER_MIME || f.trashed === true || !(isObj(f.capabilities) && f.capabilities.canAddChildren === true)) {
          return refuse('forbidden', 'この置き場所には置けません（フォルダでないか、追加できる権限がありません）。', { code: 'DRIVE_FOLDER_REFUSED' })
        }
        const domain = h.connectors.client()?.domain
        if (!domain) return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
        if (actor.kind === 'ai') {
          const perms = await folderPermissions(member.companyId, member.userId, row.folderId)
          if (perms === null || !Array.isArray(perms)) {
            return refuse('forbidden', 'このフォルダを誰が見られるか確かめられないため、AI からは置けません。メンバー本人が Google Drive に置いてください。', { code: 'DRIVE_FOLDER_SHARING_UNKNOWN' })
          }
          if (driveFolderReachesOutside(perms, domain)) {
            return refuse('forbidden', 'このフォルダは社外の人も見られるため、AI からは置けません（社外に渡すのはメンバー本人の操作です）。社内だけのフォルダを選んでもらうか、メンバー本人が置いてください。', { code: 'DRIVE_FOLDER_SHARED_OUTSIDE' })
          }
        }
        if (targetId === null) return null
        const fileRefused = 'このファイルは上書きできません（消されたか、別の場所に移されたか、直す権限がありません）。新しいファイルとして置いてください。'
        const t = await drive(member.companyId, member.userId, {
          method: 'GET', path: `/drive/v3/files/${targetId}`,
          query: { fields: 'id,mimeType,trashed,parents,headRevisionId,version,capabilities(canEdit)', supportsAllDrives: 'true' },
          operation: 'drive.files.get',
        })
        if (!t.ok) return googleRefusal(t, fileRefused)
        const tf = isObj(t.json) ? t.json : {}
        const parents = Array.isArray(tf.parents) ? tf.parents : []
        if (tf.id !== targetId || tf.trashed === true || tf.mimeType !== form.driveMime || !parents.includes(row.folderId) || !(isObj(tf.capabilities) && tf.capabilities.canEdit === true)) {
          return refuse('forbidden', fileRefused, { code: 'DRIVE_FILE_REFUSED' })
        }
        // Someone changed it in Drive since ACB's last put: never written over.
        const changedSince = refuse('conflict', 'このファイルは、前に置いたあとに Google Drive で直されています。上書きすると直したところが消えるため、新しいファイルとして置いてください。', { code: 'DRIVE_FILE_CHANGED_SINCE' })
        if (form.driveMime === DRIVE_DOC_MIME) {
          // A Google document's `version` moves without any edit (real Google, 2026-11-12: opened once, nothing typed). Its
          // baseline is compared instead — text, newest revision and comments — and any doubt refuses. Never `version`.
          const notVerifiable = (why: string) => refuse('conflict', `${why}、Google Drive で直されていないか確かめられないため、上書きしません。新しいファイルとして置いてください。`, { code: 'DRIVE_FILE_NOT_VERIFIABLE' })
          const base = target?.docBaseline
          if (!base) return notVerifiable('このファイルは前に置いたときの控えがなく')
          // Which part differed is logged (never the file, its text or names): what real Google does is still to confirm.
          const differs = (part: 'text' | 'revision-id' | 'revision-time') => {
            log.warn(`[google-drive] document update refused: changed since the baseline (${part})`)
            return changedSince
          }
          const now = await docFingerprint(member.companyId, member.userId, targetId)
          if (now === null) return notVerifiable('このファイルの今の中身を読めず')
          if (now !== base.fingerprint) return differs('text')
          // Formatting, images, a chart or a suggestion change no text but make a new revision — or, merged into the newest
          // one (Docs does so for one account's edits close together, and ACB writes as the member), move its time. A
          // later time on the same revision is refused even when it is the member's own: it cannot be told apart from
          // their bold merged into ACB's revision (google-drive.md, the owner's decision).
          const revisions = await docRevisions(member.companyId, member.userId, targetId)
          if (revisions === null) return notVerifiable('このファイルの変更履歴を読めず')
          const newest = revisions[revisions.length - 1]
          if (newest.id !== base.revision) return differs('revision-id')
          if (newest.at !== base.revisionAt) return differs('revision-time')
          const commented = await commentedSince(member.companyId, member.userId, targetId, base.at)
          if (commented === null) return notVerifiable('このファイルのコメントを読めず')
          if (commented) {
            log.warn('[google-drive] document update refused: changed since the baseline (comment)')
            return refuse('conflict', 'このファイルには、前に置いたあとにコメントが付いています。上書きするとコメントが外れるおそれがあるため、新しいファイルとして置いてください。', { code: 'DRIVE_FILE_CHANGED_SINCE' })
          }
        } else {
          // A file with binary content: its head revision is the receipt's (it changes only with new content).
          const current = driveRevisionOf(tf.headRevisionId, tf.version)
          if (current === null || current !== target?.revisionId) return changedSince
        }
        if (actor.kind !== 'ai') return null
        // A file can be shared outside on its own, whatever its folder says: then updating it is sending outside.
        const filePerms = await folderPermissions(member.companyId, member.userId, targetId)
        if (filePerms === null || !Array.isArray(filePerms)) {
          return refuse('forbidden', 'このファイルを誰が見られるか確かめられないため、AI からは上書きできません。', { code: 'DRIVE_FILE_SHARING_UNKNOWN' })
        }
        if (driveFolderReachesOutside(filePerms, domain)) {
          return refuse('forbidden', 'このファイルは社外の人も見られるため、AI からは上書きできません（社外に渡すのはメンバー本人の操作です）。', { code: 'DRIVE_FILE_SHARED_OUTSIDE' })
        }
        return null
      })()
      if (refusedBefore) {
        h.googleDrive.dropPut(id)
        return refusedBefore
      }

      // The revision a record may point to stays in Drive: a file's head revision is kept forever before it is replaced
      // (Drive drops old revisions of binary files after 30 days / 100 revisions). A Google document's revisions cannot
      // be kept that way (Drive keeps them itself); a document a decision rests on is never overwritten (above).
      if (target && target.revisionId && !target.revisionId.startsWith('version:')) {
        const kept = await drive(member.companyId, member.userId, {
          method: 'PATCH', path: `/drive/v3/files/${targetId}/revisions/${encodeURIComponent(target.revisionId)}`,
          query: { fields: 'id,keepForever' }, body: { keepForever: true }, operation: 'drive.revisions.keep',
        })
        if (!kept.ok || !(isObj(kept.json) && kept.json.keepForever === true)) {
          h.googleDrive.dropPut(id)
          return refuse('conflict', '今の版を Google Drive に残せなかったため、上書きしませんでした。新しいファイルとして置いてください。', { code: 'DRIVE_REVISION_NOT_KEPT' })
        }
      }
      const fields = 'id,headRevisionId,version,webViewLink,modifiedTime'
      const r = targetId !== null
        // A new revision of the same file: only its content and ACB's correlation id (the lookup after a lost answer).
        ? await drive(member.companyId, member.userId, {
          method: 'PATCH', path: `/upload/drive/v3/files/${targetId}`,
          query: { uploadType: 'multipart', supportsAllDrives: 'true', fields },
          rawBody: multipart(id, { appProperties: { acbPutId: id } }, form.uploadMime, bytes), operation: 'drive.files.update',
        })
        : await drive(member.companyId, member.userId, {
          method: 'POST', path: '/upload/drive/v3/files',
          query: { uploadType: 'multipart', supportsAllDrives: 'true', fields },
          rawBody: multipart(id, { name: named.name, parents: [row.folderId], mimeType: form.driveMime, appProperties: { acbPutId: id } }, form.uploadMime, bytes),
          operation: 'drive.files.create',
        })
      const answeredAtMs = performance.now()
      if (r.ok) {
        const j = isObj(r.json) ? r.json : {}
        const made = isDriveId(j.id) ? j.id : null
        const settled = {
          state: 'done' as const, fileId: targetId ?? made, revisionId: driveRevisionOf(j.headRevisionId, j.version),
          link: str(j.webViewLink) ?? target?.link ?? null, reason: null, finishedAt: clock.now(),
        }
        h.googleDrive.settlePut(id, settled)
        // An update names the revision its check started from (always there: an update without a baseline was refused
        // above; '' would match no revision and keep none).
        await keepDocBaseline(member.companyId, { ...row, ...settled }, str(j.modifiedTime), targetId !== null ? (target?.docBaseline?.revision ?? '') : null, answeredAtMs)
        return ok({ drivePut: putView({ ...row, ...settled }), existing: false })
      }
      if (r.kind === 'unknown' || r.kind === 'server-error') {
        // It may be in Drive: never sent again; looked up by the put's id now and on every later read.
        h.googleDrive.settlePut(id, { state: 'unknown', fileId: null, revisionId: null, link: null, reason: 'answer-lost', finishedAt: null })
        return ok({ drivePut: putView(await reconcile(member.companyId, { ...row, state: 'unknown', reason: 'answer-lost' })), existing: false })
      }
      // Refused or not sent: nothing was made; the key is free again.
      h.googleDrive.dropPut(id)
      return googleRefusal(r, targetId !== null ? 'このファイルを上書きできませんでした（Google Drive が断りました）。' : 'この置き場所に置けませんでした（Google Drive が断りました）。')
    },

    /**
     * A scheduled job's deliverable place (jobs.md "A deliverable place outside", kind `drive_folder`): the member's
     * own live pick of this folder — its name and when the pick ends — or null (not picked by them, expired, a file,
     * not a Drive id). Nothing asked of Google: the put asks again at every call.
     */
    folderPlace(companyId: string, userId: string, folderId: unknown): { name: string; expiresAt: string } | null {
      if (!isDriveId(folderId)) return null
      const pick = handle(companyId).googleDrive.pick(userId, folderId, clock.now())
      return pick && pick.kind === 'folder' ? { name: pick.name, expiresAt: pick.expiresAt } : null
    },

    /**
     * The files a scheduled job's run put (jobs.md "A deliverable place outside"): the member's own done
     * receipts of that run, one per Drive file (its latest put), with the receipt's facts — to link them to the
     * やること the run's finish made. Google is not asked.
     */
    runDeliverables(member: Member, runId: string): DriveLinkableFile[] {
      const h = handle(member.companyId)
      // Its own receipts, and those it was answered with again (a repeat of an earlier put: nothing uploaded twice, but
      // the run's operation names that receipt — S10b's `drive-put` reference).
      const rows = [...h.googleDrive.runPuts(member.userId, runId, 50)]
      for (const op of h.aiRuns.operations(runId)) {
        if (op.refKind !== 'drive-put' || !op.refId) continue
        const row = h.googleDrive.put(member.userId, op.refId)
        if (row && row.state === 'done' && !rows.some(r => r.id === row.id)) rows.push(row)
      }
      const byFile = new Map<string, DriveLinkableFile>()
      for (const p of rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (p.fileId && isDriveId(p.fileId)) byFile.set(p.fileId, { fileId: p.fileId, revisionId: p.revisionId, name: p.name, mimeType: p.mimeType, sha256: p.sha256 })
      }
      return [...byFile.values()]
    },

    /**
     * After a scheduled job's 「もう一度」 (jobs.md "「もう一度」"): the Drive file an earlier run's put made, for the next
     * run's turn — only the member's own done receipt, written by one of `runIds` (the occurrence's runs: never a
     * consultation's receipt a run was answered with again), whose folder is `folderId` (the place chosen now — the
     * receipt's folder, Google is not asked where the file is today), with a Drive file id:
     * `{ id: <the file id>, name: <the name it was put with> }`, else null.
     */
    madeFile(member: Member, folderId: string, putId: string, runIds: ReadonlySet<string>): { id: string; name: string } | null {
      if (!/^drive-put-[A-Za-z0-9_-]{1,80}$/.test(putId)) return null
      const row = handle(member.companyId).googleDrive.put(member.userId, putId)
      if (!row || row.state !== 'done' || !row.runId || !runIds.has(row.runId) || row.folderId !== folderId || !isDriveId(row.fileId)) return null
      return { id: row.fileId, name: row.name }
    },

    /** GET /api/records-ai/google/drive/puts/:putId: the member's own put (an unknown one is looked up again). */
    async putState(member: Member, putId: string, scope?: Pick<DriveJobScope, 'folderId'>): Promise<Outcome<DrivePutAnswer>> {
      const row = /^drive-put-[A-Za-z0-9_-]{1,80}$/.test(putId) ? handle(member.companyId).googleDrive.put(member.userId, putId) : null
      // A job's run: only receipts of its own folder (another one is not there for it — nothing answered, Google not asked).
      if (!row || (scope && row.folderId !== scope.folderId)) return refuse('not-found', 'Not found', { code: 'DRIVE_PUT_NOT_FOUND' })
      return ok({ drivePut: putView(await reconcile(member.companyId, row)), existing: true })
    },
  }
}

export type GoogleDriveService = ReturnType<typeof createGoogleDriveService>

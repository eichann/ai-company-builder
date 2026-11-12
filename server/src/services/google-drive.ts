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
 * member chose it in the Picker window.
 *
 * - The Picker's token (`pickerSession`, the member's app session only): a
 *   fresh access token with exactly `drive.file` (google-client.ts
 *   `pickerToken`), the admin's Picker API key and app id. Never to a record
 *   token, never stored or logged.
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
  checkDriveFileName, checkDrivePutContent, DRIVE_FOLDER_MIME, DRIVE_PICK_MAX_FILES, DRIVE_PICK_TTL_MS, DRIVE_PICKABLE_MIMES, DRIVE_PUT_MAX_BYTES, DRIVE_READ_AS,
  DRIVE_READ_PDF_MAX_BYTES, DRIVE_READ_TEXT_MAX, DRIVE_TEXT_FOOTER, DRIVE_TEXT_HEADER, driveDocFetchesOutside, driveFolderReachesOutside, drivePutForm, driveRevisionOf, isDriveId, isDrivePickMode,
  type DrivePermissionLike,
} from '../../shared/core/google-drive'
import { INSTRUCTION_LIKE_WORDS } from '../../shared/core/instruction-like'
import { neutralizeOutsideText, outsideTextFlags } from '../../shared/core/outside-text'
import type { DriveAiStatus, DriveOwnFile, DriveOwnFiles, DrivePick, DrivePickerSession, DrivePicksResult, DrivePutAnswer, DrivePutView, DriveReadAnswer, DriveUpdatableFile } from '../../shared/types/google-drive'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { DrivePickRow, DrivePutRow } from '../ports/google-drive'
import type { Member } from './access'
import type { GoogleClient, GoogleRequest, GoogleResult } from './google-client'
import { cleanExportText } from './google-meetings'
import { ok, refuse, type Outcome } from './outcome'

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
  /** sha256 of bytes, lower-case hex (composition: node's crypto). */
  sha256(bytes: Uint8Array): string
}

/**
 * A picked file checked for linking it to a record (records.md "File links without the shared
 * folder"): its revision when linked, its name as picked, its type and the sha256 of the content ACB
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
const PERMISSION_PAGES = 5

const STOPPED = 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。'
const NO_CONSENT = 'Google Drive を使う許可がまだありません。アプリが Google の画面を開くので、メンバーに「許可」を押してもらってください（Drive は、メンバーが選んだファイルとフォルダだけを使います）。'

/** A Google call that did not give a usable answer → the member-facing refusal. */
function googleRefusal(r: Extract<GoogleResult, { ok: false }>, noAccess: string): Outcome<never> {
  if (r.kind === 'not-sent') {
    if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'token-refused'].includes(r.reason)) {
      return refuse('conflict', NO_CONSENT, { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'drive' })
    }
    if (r.reason === 'feature-off') {
      return refuse('conflict', '「Drive で選んだものを読む・置く」をオフにしています。アプリの「設定」→「Google」でオンにしてください。', { code: 'GOOGLE_FEATURE_OFF', feature: 'drive' })
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

export function createGoogleDriveService(deps: GoogleDriveDeps) {
  const { companyData, google, clock, ids } = deps
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
    handle(companyId).googleDrive.settlePut(row.id, settled)
    return { ...row, ...settled }
  }

  return {
    /** Where the Picker page loads Google's script from (its CSP names it). */
    pickerScriptOrigin: deps.pickerScriptOrigin,

    /**
     * GET /api/records-ai/google/drive/status: whether the Drive tools work, the member's grant, live picks and
     * the files their puts made (what `drive_put` may update). `scope` (a scheduled job's run): only its folder.
     */
    async aiStatus(member: Member, scope?: DriveJobScope): Promise<Outcome<DriveAiStatus>> {
      const h = handle(member.companyId)
      const grant = h.connectors.grant('google', member.userId)
      const now = clock.now()
      // A job's run: its own folder only, selected in the query (never cut off by the member's other picks and puts),
      // and only the files runs of the same job made (what it may update).
      const scopedPick = scope ? h.googleDrive.pick(member.userId, scope.folderId, now) : null
      const picks = scope ? (scopedPick && scopedPick.kind === 'folder' ? [scopedPick] : []) : h.googleDrive.picks(member.userId, now, PICKS_LISTED)
      const rows = scope ? h.googleDrive.donePutsInFolder(member.userId, scope.folderId, OWN_FILES_LISTED) : h.googleDrive.donePuts(member.userId, OWN_FILES_LISTED)
      const puts = new Map<string, DriveUpdatableFile>()
      for (const p of rows) {
        if (!p.fileId || puts.has(p.fileId)) continue
        if (scope && (!p.runId || !scope.sameJob(p.runId))) continue
        puts.set(p.fileId, { fileId: p.fileId, name: p.name, mimeType: p.mimeType, folderId: p.folderId, link: p.link, revisionId: p.revisionId, at: p.finishedAt ?? p.createdAt })
      }
      return ok({
        available: await available(member.companyId),
        granted: grant?.status === 'active' && grant.scopes.includes(GOOGLE_SCOPE.driveFile),
        picks: picks.map(pickView),
        puts: [...puts.values()],
      })
    },

    /** POST …/me/google/drive/picker { mode } (session): what the app's Picker window needs. */
    async pickerSession(member: Member, body: unknown): Promise<Outcome<DrivePickerSession>> {
      if (!isObj(body) || !isDrivePickMode(body.mode)) return refuse('bad-request', 'mode must be folder or files')
      if (await deps.operatorStopped()) return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
      const picker = handle(member.companyId).connectors.picker()
      if (!picker) {
        return refuse('conflict', '管理者が Google Drive のファイル選び（Picker）をまだ設定していません。管理者に「つなぎ先」→「Google」の設定を頼んでください。', { code: 'DRIVE_PICKER_NOT_CONFIGURED' })
      }
      const token = await google.pickerToken(member.companyId, member.userId)
      if (!token.ok) {
        if (token.reason === 'picker-scope-too-wide') {
          return refuse('unavailable', 'Google から、Drive のファイル選びに必要な分より広い許可が届いたため、使いませんでした。管理者に知らせてください。', { code: 'DRIVE_PICKER_SCOPE' })
        }
        return googleRefusal({ ok: false, kind: 'not-sent', reason: token.reason as never }, '')
      }
      return ok({
        accessToken: token.accessToken, expiresAt: new Date(token.expiresAtMs).toISOString(), apiKey: picker.apiKey, appId: picker.appId,
        scriptOrigin: deps.pickerScriptOrigin, mode: body.mode,
      })
    },

    /** POST …/me/google/drive/picks { mode, ids } (session): keeps what the person picked, each checked with Google. */
    async savePicks(member: Member, body: unknown): Promise<Outcome<DrivePicksResult>> {
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
      for (const id of [...new Set(body.ids as string[])]) {
        const r = await meta(member.companyId, member.userId, id)
        if (!r.ok) {
          if (r.kind === 'refused') { refused++; continue }
          return googleRefusal(r, '')
        }
        const f = isObj(r.json) ? r.json : {}
        const mimeType = str(f.mimeType) ?? ''
        const name = (str(f.name) ?? '').normalize('NFC').slice(0, 300)
        const canAdd = isObj(f.capabilities) && f.capabilities.canAddChildren === true
        const fits = f.trashed !== true && f.id === id && name !== '' && (kind === 'folder' ? mimeType === DRIVE_FOLDER_MIME && canAdd : DRIVE_PICKABLE_MIMES.includes(mimeType))
        if (!fits) { refused++; continue }
        rows.push({ userId: member.userId, fileId: id, kind, name, mimeType, pickedAt: now, expiresAt })
      }
      const h = handle(member.companyId).googleDrive
      h.prunePicks(now)
      if (rows.length > 0) h.savePicks(rows)
      return ok({ picks: rows.map(pickView), refused })
    },

    /**
     * A file the member picked, checked for linking it to a record (session only; the records route
     * asks it before the engine links, records.md "File links without the shared folder"). Only the
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
     * (records.md "File links without the shared folder"): the receipt is the proof — the member's own
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
      for (const p of h.donePuts(member.userId, OWN_FILES_LISTED)) {
        if (p.fileId && !out.has(p.fileId)) out.set(p.fileId, { id: p.fileId, name: p.name, mimeType: p.mimeType, source: 'put', at: p.finishedAt ?? p.createdAt })
      }
      return ok({ files: [...out.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, OWN_FILES_LISTED) })
    },

    /** POST /api/records-ai/google/drive/read { fileId } (any token): a picked file, as outside text (or a PDF's bytes). */
    async read(member: Member, body: unknown): Promise<Outcome<DriveReadAnswer>> {
      if (!isObj(body) || !isDriveId(body.fileId)) return refuse('bad-request', 'fileId must be a Drive id')
      const fileId = body.fileId
      const pick = handle(member.companyId).googleDrive.pick(member.userId, fileId, clock.now())
      if (!pick || pick.kind !== 'file') {
        return refuse('forbidden', 'このファイルはメンバーが選んだものではありません。drive_pick_files でメンバーに選んでもらってください。', { code: 'DRIVE_NOT_PICKED' })
      }
      const noAccess = 'このファイルを Google Drive から開けませんでした（消されたか、見られなくなった可能性があります）。'
      const m = await meta(member.companyId, member.userId, fileId)
      if (!m.ok) return googleRefusal(m, noAccess)
      const f = isObj(m.json) ? m.json : {}
      const mimeType = str(f.mimeType) ?? ''
      const how = DRIVE_READ_AS[mimeType]
      if (!how || f.trashed === true) return refuse('bad-request', 'この種類のファイルは読めません（Google ドキュメント・スライド・スプレッドシート、PDF、テキストだけ）。', { code: 'DRIVE_TYPE_UNREADABLE' })
      const file = { id: fileId, name: (str(f.name) ?? pick.name).normalize('NFC'), mimeType, modifiedTime: str(f.modifiedTime) }
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
        instructionLike: outsideTextFlags(text).map(label => ({ label, words: INSTRUCTION_LIKE_WORDS[label] ?? label })),
      })
    },

    /**
     * POST /api/records-ai/google/drive/put (act token): a PDF / HTML into a picked folder, or HTML / Markdown
     * converted into a Google document (`as: 'google_doc'`); with `updateFileId`, a new revision of a file an
     * earlier put of this member made in that same folder (google-drive.md "Overwriting"). `scope` (a scheduled
     * job's run, jobs.md "A deliverable place outside"): only into that one folder — checked here at every call.
     */
    async put(member: Member, actor: DriveActor, body: unknown, scope?: DriveJobScope): Promise<Outcome<DrivePutAnswer>> {
      if (!isObj(body)) return refuse('bad-request', 'Body must be a JSON object')
      if (!isDriveId(body.folderId)) return refuse('bad-request', 'folderId must be a Drive id')
      const form = drivePutForm(body.kind, body.as)
      if (!form) return refuse('bad-request', 'Google Drive に置けるのは PDF と HTML（そのまま）、または Google ドキュメントにする HTML と Markdown だけです。', { code: 'DRIVE_TYPE_REFUSED' })
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
      if (form.as === 'google_doc' && driveDocFetchesOutside(form.kind, new TextDecoder().decode(bytes))) {
        return refuse('bad-request', '外を読み込むかもしれない部分（画像・スタイル・URL）があるため、Google ドキュメントにできません。外のページは [文字](URL) か <a href> のリンクだけにし、style や外の画像は外してください（画像は data: で埋め込めます）。', { code: 'DRIVE_EXTERNAL_RESOURCE' })
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
          return refuse('bad-request', '上書きは同じ種類どうしだけです（Google ドキュメントは Google ドキュメントで、PDF は PDF で、HTML は HTML で）。', { code: 'DRIVE_UPDATE_KIND_MISMATCH' })
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
        // Someone changed it in Drive since ACB's last put (its revision is not the receipt's): never written over.
        const current = driveRevisionOf(tf.headRevisionId, tf.version)
        if (current === null || current !== target?.revisionId) {
          return refuse('conflict', 'このファイルは、前に置いたあとに Google Drive で直されています。上書きすると直したところが消えるため、新しいファイルとして置いてください。', { code: 'DRIVE_FILE_CHANGED_SINCE' })
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
      const fields = 'id,headRevisionId,version,webViewLink'
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
      if (r.ok) {
        const j = isObj(r.json) ? r.json : {}
        const made = isDriveId(j.id) ? j.id : null
        const settled = {
          state: 'done' as const, fileId: targetId ?? made, revisionId: driveRevisionOf(j.headRevisionId, j.version),
          link: str(j.webViewLink) ?? target?.link ?? null, reason: null, finishedAt: clock.now(),
        }
        h.googleDrive.settlePut(id, settled)
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

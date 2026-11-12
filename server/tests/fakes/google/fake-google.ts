/**
 * The fake Google (「練習用の Google」, milestone 4 design N13 / G2): a small
 * Hono app with the data in memory that answers the OAuth 2.0, Calendar,
 * Meet, Drive and Gmail calls the server makes, in the shapes of Google's
 * public reference pages. Used by the server tests (passed straight in) and
 * on the staging server (`pnpm fake:google`, `serve.ts`).
 *
 * Test and staging code only: it lives under `server/tests/`, which the
 * production image never copies (server/Dockerfile copies `server/src` and
 * `shared`), and nothing in `server/src` may import it
 * (`tests/unit/layering.test.ts`).
 *
 * One origin, Google's paths. Google spreads these over several hosts; every
 * path below is the real one, and no two hosts share a path, so a practice
 * redirect maps each host onto this one base URL by path alone:
 *
 *   accounts.google.com           GET  /o/oauth2/v2/auth             (authorization endpoint)
 *   oauth2.googleapis.com         POST /token, POST /revoke
 *   www.googleapis.com            GET  /oauth2/v3/userinfo
 *   openidconnect.googleapis.com  GET  /v1/userinfo
 *   www.googleapis.com            GET  /calendar/v3/calendars/{calendarId}/events[/{eventId}]
 *   meet.googleapis.com           GET  /v2/conferenceRecords, /v2/conferenceRecords/{id},
 *                                      /v2/conferenceRecords/{id}/smartNotes[/{noteId}],
 *                                      /v2/conferenceRecords/{id}/transcripts[/{transcriptId}],
 *                                      /v2/conferenceRecords/{id}/transcripts/{transcriptId}/entries,
 *                                      /v2/conferenceRecords/{id}/participants
 *   www.googleapis.com            GET  /drive/v3/files/{fileId}, /drive/v3/files/{fileId}/export
 *                                 GET  /drive/v3/files (appProperties search), /drive/v3/files/{fileId}/permissions
 *                                 POST /upload/drive/v3/files?uploadType=multipart (a Google document from text/html or text/markdown)
 *                                 PATCH /upload/drive/v3/files/{fileId}?uploadType=multipart (a new revision of the same file)
 *   apis.google.com               GET  /js/api.js — a stand-in Google Picker (staging only; picks through /__picker/*)
 *   gmail.googleapis.com          POST /gmail/v1/users/{userId}/messages/send
 *                                 POST /upload/gmail/v1/users/{userId}/messages/send?uploadType=media (message/rfc822 bytes)
 *                                 GET  /gmail/v1/users/{userId}/messages (q `after:<seconds>`, labelIds, maxResults, pageToken)
 *                                 GET  /gmail/v1/users/{userId}/messages/{id} (format minimal | metadata | full)
 *                                 GET  /gmail/v1/users/{userId}/threads/{id} (format full | minimal)
 *                                 GET  /gmail/v1/users/{userId}/profile (historyId)
 *                                 GET  /gmail/v1/users/{userId}/history (startHistoryId, historyTypes, pageToken, maxResults;
 *                                      404 for a start older than the kept history)
 *                                 POST /gmail/v1/users/{userId}/threads/{id}/modify, …/messages/{id}/modify (gmail.modify)
 *                                 POST /gmail/v1/users/{userId}/threads/{id}/trash (gmail.modify; ACB never calls it)
 *   sheets.googleapis.com         GET  /v4/spreadsheets/{id}, POST /v4/spreadsheets/{id}:batchUpdate,
 *                                 GET|PUT /v4/spreadsheets/{id}/values/{range}, POST …/values/{range}:append | :clear,
 *                                 GET /v4/spreadsheets/{id}/values:batchGet, POST …/values:batchUpdate | :batchClear
 *
 * Sheets (the relay, google-connector.md "The relay"): each spreadsheet has an owner, editors and
 * readers; a write by anyone else, or a read by a stranger, is 403 PERMISSION_DENIED (as Google
 * answers "The caller does not have permission"). Clears and deletes are implemented too, so a
 * test can prove the relay never sends one (`requests`, `spreadsheet()`).
 *
 * Practice values only, recognisable at a glance: client secrets start with
 * `fake-google-secret-`, access tokens `ya29.fake-`, refresh tokens
 * `1//fake-`, authorization codes `4/fake-`. Any other bearer value is 401.
 *
 * Drive with `drive.file` (google-drive.md): a file or folder that Meet did
 * not make is reachable only once the account picked it for this client
 * (`pick`, or the stand-in Picker) or the client created it — as Google holds
 * `drive.file`. A refresh may ask for a subset of the granted scopes (`scope`).
 *
 * Stricter than Google where the server is meant to be strict anyway (so a
 * sloppy server fails here): the authorization request must carry `state`
 * and an S256 PKCE challenge (Google accepts a request without them, or with
 * `plain`), and Gmail refuses a From that is not the token's account (Gmail
 * itself may rewrite it instead).
 */
import { createHash, randomBytes } from 'crypto'
import { Hono, type Context } from 'hono'
import { defaultGoogleSeed, type ArtifactState, type GoogleSeed, type SeedArtifact, type SeedEvent, type SeedDriveFile, type SeedMail, type SeedSpreadsheet } from './seed'

export const FAKE_GOOGLE_SECRET_PREFIX = 'fake-google-secret-'
export const FAKE_ACCESS_TOKEN_PREFIX = 'ya29.fake-'
export const FAKE_REFRESH_TOKEN_PREFIX = '1//fake-'
export const FAKE_CODE_PREFIX = '4/fake-'
/** Who edits a Drive file in the fake's "someone edits it" helpers unless told otherwise: not the member ACB writes as. */
export const SOMEONE_ELSE = 'someone.else@other.example'

export const GOOGLE_SCOPES = {
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
  calendarEventsReadonly: 'https://www.googleapis.com/auth/calendar.events.readonly',
  meetReadonly: 'https://www.googleapis.com/auth/meetings.space.readonly',
  driveMeetReadonly: 'https://www.googleapis.com/auth/drive.meet.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  driveFile: 'https://www.googleapis.com/auth/drive.file',
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  documentsReadonly: 'https://www.googleapis.com/auth/documents.readonly',
  driveMetadataReadonly: 'https://www.googleapis.com/auth/drive.metadata.readonly',
} as const

/** The scopes milestone 4 asks for (design §5-2). */
export const MILESTONE4_SCOPES = [
  GOOGLE_SCOPES.openid, GOOGLE_SCOPES.email, GOOGLE_SCOPES.calendarEventsReadonly,
  GOOGLE_SCOPES.meetReadonly, GOOGLE_SCOPES.driveMeetReadonly, GOOGLE_SCOPES.gmailSend,
]

const AUTH = 'https://www.googleapis.com/auth/'
/** Google's short names, granted (and reported in `scope`) as the long form. */
const SCOPE_ALIASES: Record<string, string> = { email: GOOGLE_SCOPES.email, profile: GOOGLE_SCOPES.profile }
/** Every scope the fake accepts in an authorization request. */
const KNOWN_SCOPES = new Set<string>([
  ...Object.values(GOOGLE_SCOPES),
  `${AUTH}calendar`, `${AUTH}calendar.readonly`, `${AUTH}calendar.events`,
  `${AUTH}meetings.space.created`,
  `${AUTH}drive`, `${AUTH}drive.readonly`, `${AUTH}spreadsheets.readonly`, `${AUTH}documents`,
  `${AUTH}gmail.compose`, `${AUTH}gmail.modify`, `${AUTH}gmail.metadata`, 'https://mail.google.com/',
])
/** Any one of these lets a call through (each method's "Authorization scopes" list). */
const NEEDS = {
  calendar: [GOOGLE_SCOPES.calendarEventsReadonly, `${AUTH}calendar.readonly`, `${AUTH}calendar.events`, `${AUTH}calendar`],
  meet: [GOOGLE_SCOPES.meetReadonly, `${AUTH}meetings.space.created`],
  drive: [GOOGLE_SCOPES.driveMeetReadonly, GOOGLE_SCOPES.driveFile, `${AUTH}drive.readonly`, `${AUTH}drive`],
  gmailSend: [GOOGLE_SCOPES.gmailSend, `${AUTH}gmail.compose`, `${AUTH}gmail.modify`, 'https://mail.google.com/'],
  gmailRead: [GOOGLE_SCOPES.gmailReadonly, `${AUTH}gmail.modify`, 'https://mail.google.com/'],
  gmailModify: [`${AUTH}gmail.modify`, 'https://mail.google.com/'],
  docs: [GOOGLE_SCOPES.documentsReadonly, `${AUTH}documents`, `${AUTH}drive`, `${AUTH}drive.readonly`],
  sheetsRead: [GOOGLE_SCOPES.spreadsheets, `${AUTH}spreadsheets.readonly`, `${AUTH}drive`, `${AUTH}drive.readonly`],
  sheetsWrite: [GOOGLE_SCOPES.spreadsheets, `${AUTH}drive`],
}
/** Drive scopes that reach every file the account can open (not only Meet's). */
const DRIVE_FULL = new Set([`${AUTH}drive.readonly`, `${AUTH}drive`])

export interface FakeGoogleOptions {
  seed?: GoogleSeed
  /** Milliseconds since the epoch; tests pass their own clock. */
  now?: () => number
  /** Serve `/__fake/*` (sign-in choice, faults, outside changes, sent mail). Off by default. */
  controlRoutes?: boolean
  /** Refresh tokens per client and account before the oldest is invalidated (Google: 100). */
  refreshTokenLimit?: number
  /** Drive's export limit (10 MB). */
  exportLimitBytes?: number
}

export interface FakeClient {
  clientId: string
  clientSecret: string
  redirectUris: string[]
  /** An internal app: only accounts of this Workspace domain may sign in ("Error 403: org_internal"). */
  internalDomain?: string
}

/** Who "signs in" at the authorization endpoint (there is no screen to click). */
export type SignIn = { email: string; withholdScopes?: string[] } | { deny: true }

export interface SentMessage {
  id: string
  threadId: string
  /** The account the token belongs to. */
  account: string
  from: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  headers: Record<string, string>
  sentAt: string
  /** `raw` (messages.send with JSON) or `upload` (the media upload of message/rfc822 bytes). */
  via: 'raw' | 'upload'
  /** The message as it arrived (CRLF), for a test that parses it again. */
  raw: string
  /** The attached files (multipart/mixed parts with `Content-Disposition: attachment`), decoded. */
  attachments: Array<{ filename: string | null; contentType: string; disposition: string; bytes: Buffer }>
}

export interface FakeGoogleRequestLog {
  method: string
  path: string
  status: number
  /** The query string (`?…`, or '') and every header value as received: a test can prove nothing of ACB's own token arrived. */
  search: string
  headerValues: string[]
}

export interface FakeGoogleFaults {
  /** Delay every answer by this many milliseconds (0 = none). */
  delayMs: number
  /** The next `count` API / token requests answer `status` (500 or 429 shapes) without doing anything. */
  failNext(count?: number, status?: number): void
  /** Like `failNext`, only for requests whose path starts with `prefix` (others are answered). */
  failOn(prefix: string, count?: number, status?: number): void
  /**
   * Someone edits the next Google document exported just before the export (new text, a later `modifiedTime`, a new
   * revision made by `by` — default another person, `SOMEONE_ELSE`). Called again before that export: the edits are
   * made in order (the last one's text stays). `omittedFromRevisions`: the edit changes the text and the file's last
   * modifier but `revisions.list` does not show it (Google documents that it may omit or merge revisions).
   */
  editBeforeNextExport(content: string, by?: string, omittedFromRevisions?: boolean): void
  /** The next `count` `files.get` of a Google document's metadata are refused with 403 (the file is unchanged). */
  failNextFileGets(count: number): void
  /**
   * Drive's processing after the next import into a Google document (create or update; real Google, 2026-11-12): the
   * upload is answered with one `modifiedTime`, and the file's then moves `ms` later (default 2000) with no edit and no
   * new revision. `revisionMs`: the newest revision's `modifiedTime` moves that much later too (real Google: the file's by
   * ~4 s, its one revision's by ~3 s); `fileTimeAs`: the file's time answered as this (malformed) value from then on, or as this function of the
   * answered time gives it; `afterMs`: the move happens that much real time after the answer (default at once).
   */
  moveTimeAfterNextImport(opts?: { ms?: number; revisionMs?: number; fileTimeAs?: string | ((answeredMs: number) => string); afterMs?: number }): void
  /**
   * Right after the next import into a Google document (before its answer is used), these edits are made in order —
   * as `editBeforeNextExport` makes them (`by` default another person; `omittedFromRevisions`: no revision shown, the
   * text and the file's last modifier change: a merged revision names only its last modifier).
   */
  editAfterNextImport(edits: Array<{ content: string; by?: string; omittedFromRevisions?: boolean }>): void
  /** Drive still processing: after each of the next `count` `files.get` answers on a Google document, its `modifiedTime` moves `ms` later (default 1000). */
  settleFileAfterNextGets(count: number, ms?: number): void
  /**
   * Drive still processing: after each of the next `count` complete `revisions.list` answers, the newest revision's
   * `modifiedTime` moves `ms` later (default 1000; no edit, no new revision).
   */
  settleRevisionAfterNextLists(count: number, ms?: number): void
  /**
   * The next import into a Google document leaves another revision list than one new revision: `extra-own` — the
   * uploading account makes one more revision right after (a change of look, no text change); `merged` — the import is
   * merged into the newest revision before it (no new id; its time moves); `pruned` — every older revision is dropped.
   */
  reshapeRevisionsAfterNextImport(kind: 'extra-own' | 'merged' | 'pruned'): void
  /** The next `count` `revisions.list` calls are refused with 403 (the file is unchanged); `afterPages`: only after that many pages answered. */
  failNextRevisionLists(count: number, afterPages?: number): void
  /** `revisions.list` answers at most `size` revisions a page with a `nextPageToken` (0 = one page, the default). */
  pageRevisions(size: number): void
  /** `revisions.list` leaves `lastModifyingUser` out of the newest revision even when asked (Google may: an unknown user). */
  hideNewestRevisionAuthor(on: boolean): void
  /** The next `count` exports of a Drive file are refused with 403 (not retried by a client; the file is unchanged). */
  failNextExports(count: number): void
  /** The next `count` `files.list` searches are refused with 403 (a lost answer's lookup that does not get through). */
  failNextFileSearches(count: number): void
  /** The next export of a Drive file answers this text instead of the file's (Drive still processing it); the file is unchanged. */
  staleNextExport(text: string): void
  /**
   * The next `count` Gmail sends are stored (the mail went out) and then never
   * answered: over a real socket the connection is cut; through `app.fetch`
   * the promise stays pending until `close()`. 「届いたか分からない」.
   */
  dropAnswerAfterSend(count?: number): void
  /** A refresh that asks for fewer scopes gets every granted one anyway (a Google that ignores `scope`). */
  ignoreRefreshScope: boolean
  /** Drive opens this document (`files.get`) but refuses its export with 403 and this reason (Gemini's notes in production; a Drive file too). */
  refuseExport(docId: string, reason?: string): void
  /** `documents.get` of this document answers 403 with this reason (the API not turned on, say). */
  refuseDocs(docId: string, reason?: string): void
  /** The owner's 「閲覧者にコピーやダウンロードを許可しない」: Drive says so; the Docs API still answers, as the worst case. */
  blockCopy(docId: string): void
  reset(): void
}

/** A change someone makes to a calendar event. */
export interface EventChange {
  removeAttendee?: string
  /** Invited later (needsAction). */
  addAttendee?: string
  /** This attendee declines. */
  decline?: string
  summary?: string
  visibility?: SeedEvent['visibility']
}

export interface FakeGoogle {
  app: Hono
  /** Registers an OAuth client; the secret must be a practice one. */
  addClient(client: Partial<FakeClient> & { redirectUris: string[] }): FakeClient
  /** Who signs in at the next authorization requests (default: the seed's member). */
  signIn(choice: SignIn): void
  /** The person removed the app's access in their Google account: every token of theirs stops working. */
  revokeAllFor(email: string): void
  /** Someone changes a calendar event (removes an attendee, renames it): `updated`, `sequence` and `etag` move. */
  changeEvent(id: string, change: EventChange): void
  /** The minutes document is edited: new text (or one appended line), `version` + 1, new `modifiedTime`. */
  changeDoc(id: string, text?: string): void
  /** A Meet artifact moves on (e.g. ENDED → FILE_GENERATED). */
  setArtifactState(conferenceId: string, kind: 'smartNotes' | 'transcripts', artifactId: string, state: ArtifactState): void
  /** Every message Gmail "sent", oldest first. */
  sent: SentMessage[]
  /** A mail arrives in an account's Gmail (受信を読む). */
  deliver(mail: SeedMail): void
  /** The person archives a conversation in Gmail itself (its INBOX label off; a history entry). */
  archiveInGmail(account: string, threadId: string): void
  /** The person archives one message in Gmail itself (its INBOX label off; a history entry). */
  archiveMessageInGmail(account: string, messageId: string): void
  /** The person deletes a conversation in Gmail for good (a history entry). */
  deleteInGmail(account: string, threadId: string): void
  /** The labels of a conversation's messages now (for assertions), oldest first. */
  threadLabels(account: string, threadId: string): string[][]
  /** Gmail forgets the history before now: an older `startHistoryId` is answered 404. */
  expireHistory(): void
  /** A document's current version (null when unknown); for assertions. */
  doc(id: string): { text: string; version: number; modifiedTime: string } | null
  /** Live refresh tokens of an account (for the 100-per-account limit). */
  refreshTokenCount(clientId: string, email: string): number
  faults: FakeGoogleFaults
  requests: FakeGoogleRequestLog[]
  /** Releases every request held by `dropAnswerAfterSend`. */
  close(): void
  /** The account picked these files / folders for this client in Google Picker (drive.file now reaches them). */
  pick(clientId: string, email: string, ids: string[]): void
  /** A Drive file as it is now (null when unknown); for assertions. */
  driveFile(id: string): { name: string; mimeType: string; parents: string[]; content: Buffer; appProperties: Record<string, string>; createdBy: string | null; version: number; headRevisionId: string; uploadedAs: string | null; keptRevisions: string[]; modifiedTime: string; revisions: Array<{ id: string; modifiedTime: string; by: string }> } | null
  /** Someone shares this Drive file (or folder) by itself with another permission (anyone, another domain, a person). */
  shareDriveFile(id: string, permission: { type: 'user' | 'group' | 'domain' | 'anyone'; role: string; emailAddress?: string; domain?: string }): void
  /** Someone moves this Drive file into another folder (its parents become exactly that one). */
  moveDriveFile(id: string, folderId: string): void
  /** Drive answers `keepForever: false` for this file's revisions (as if it would not keep them). */
  refuseKeepForever(id: string): void
  /** Someone edits this Drive file in Drive itself (a new revision / version, not ACB's), as `by` (default `SOMEONE_ELSE`). */
  editDriveFile(id: string, content: string, by?: string): void
  /**
   * Someone edits this Google document and Docs merges the edit into its newest revision (as Docs does for edits close
   * together): new text, a later `modifiedTime`, the same newest revision id.
   */
  editDriveFileMerged(id: string, content: string): void
  /** Someone changes only the look of this Google document (bold, an image): a new revision, the same text; as `by`. */
  formatDriveFile(id: string, by?: string): void
  /** The same, merged by Docs into the newest revision (the member's own edit soon after ACB's): its id kept, its time moved. */
  formatDriveFileMerged(id: string): void
  /** Someone comments on this Drive file (no new revision, the same text). */
  commentOnDriveFile(id: string): void
  /**
   * Someone opens this Google document in the browser and closes it without typing (real Google, 2026-11-12): its
   * `version` moves, its content and revision history do not.
   */
  openDriveFile(id: string): void
  /** Every Drive file the app made (uploads), oldest first. */
  uploads(): Array<{ id: string; name: string; parents: string[]; mimeType: string }>
  /** A spreadsheet as it is now (null when unknown); for assertions. */
  spreadsheet(id: string): { title: string; sheets: Array<{ sheetId: number; title: string; rows: unknown[][] }> } | null
}

interface CodeGrant {
  clientId: string
  redirectUri: string
  email: string
  scopes: string[]
  codeChallenge: string
  offline: boolean
  expiresAt: number
  used: boolean
}
interface RefreshGrant { token: string; clientId: string; email: string; scopes: string[]; createdAt: number; live: boolean }
interface AccessGrant { clientId: string; email: string; scopes: string[]; expiresAt: number; refreshToken: string | null; live: boolean }

class GoogleApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {
    super(`google ${status}`)
  }
}

const STATUS_NAMES: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' }

/** Google's JSON error (`{ error: { code, message, errors?, status } }`). */
const apiError = (code: number, message: string, reason?: string, extra: Record<string, unknown> = {}) =>
  new GoogleApiError(code, { error: { code, message, ...(reason ? { errors: [{ message, domain: 'global', reason, ...extra }] } : {}), status: STATUS_NAMES[code] ?? 'UNKNOWN' } })

const unauthenticated = () => new GoogleApiError(401, {
  error: {
    code: 401,
    message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
    errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }],
    status: 'UNAUTHENTICATED',
  },
}, { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' })

const insufficientScope = (service: string) => new GoogleApiError(403, {
  error: {
    code: 403,
    message: 'Request had insufficient authentication scopes.',
    errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { service } }],
  },
}, { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="insufficient_scope"' })

/** The token endpoint's error (`{ error, error_description }`, RFC 6749 §5.2). */
const oauthError = (status: number, error: string, description: string) => new GoogleApiError(status, { error, error_description: description })

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomToken = (n = 24) => b64url(randomBytes(n))

/** RFC 3339 with an offset or Z (Calendar refuses timeMin/timeMax without one). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const now = options.now ?? (() => Date.now())
  const seed = options.seed ?? defaultGoogleSeed()
  const refreshLimit = options.refreshTokenLimit ?? 100
  const exportLimit = options.exportLimitBytes ?? 10 * 1024 * 1024
  const iso = (ms: number) => new Date(ms).toISOString()

  const users = new Map(seed.users.map(u => [u.email.toLowerCase(), u]))
  const clients = new Map<string, FakeClient>()
  const codes = new Map<string, CodeGrant>()
  const refreshTokens = new Map<string, RefreshGrant>()
  const accessTokens = new Map<string, AccessGrant>()
  let signInChoice: SignIn = { email: seed.users[0]?.email ?? '' }

  const created = now()
  const events = seed.events.map(e => ({ ...e, attendees: e.attendees.map(a => ({ ...a })), created, updated: created, sequence: 0 }))
  const conferences = seed.conferences.map(c => ({ ...c, smartNotes: c.smartNotes.map(a => ({ ...a })), transcripts: c.transcripts.map(a => ({ ...a })) }))
  const docs = new Map(seed.docs.map(d => [d.id, { ...d }]))
  const sent: SentMessage[] = []
  const mails: SeedMail[] = (seed.mails ?? []).map(m => ({ ...m, headers: { ...m.headers }, labelIds: [...m.labelIds] }))
  const requests: FakeGoogleRequestLog[] = []

  // ---- faults ----
  let failCount = 0
  let failStatus = 500
  let failPrefix: string | null = null
  const exportRefused = new Map<string, string>()
  const docsRefused = new Map<string, string>()
  const copyBlocked = new Set<string>()
  let dropCount = 0
  let editBeforeExport: Array<{ content: string; by: string; omitted: boolean }> = []
  let fileGetFailures = 0
  let revisionListFailures = 0
  let revisionListFailAfter = 0
  let revisionPageSize = 0
  let newestAuthorHidden = false
  let importTimeMove: { ms: number; revisionMs: number | null; fileTimeAs: string | ((answeredMs: number) => string) | null; afterMs: number } | null = null
  let pendingMoves: Array<{ dueAt: number; move: () => void }> = []
  let fileSettles = { count: 0, ms: 0 }
  let importEdits: Array<{ content: string; by: string; omitted: boolean }> = []
  let revisionSettles = { count: 0, ms: 0 }
  let importReshape: 'extra-own' | 'merged' | 'pruned' | null = null
  let exportFailures = 0
  let staleExport: string | null = null
  let searchFailures = 0
  const held = new Set<() => void>()
  const faults: FakeGoogleFaults = {
    delayMs: 0,
    failNext(count = 1, status = 500) { failCount = count; failStatus = status; failPrefix = null },
    failOn(prefix, count = 1, status = 500) { failCount = count; failStatus = status; failPrefix = prefix },
    dropAnswerAfterSend(count = 1) { dropCount = count },
    editBeforeNextExport(content, by = SOMEONE_ELSE, omittedFromRevisions = false) { editBeforeExport.push({ content, by, omitted: omittedFromRevisions }) },
    failNextFileGets(count) { fileGetFailures = count },
    failNextRevisionLists(count, afterPages = 0) { revisionListFailures = count; revisionListFailAfter = afterPages },
    pageRevisions(size) { revisionPageSize = size },
    hideNewestRevisionAuthor(on) { newestAuthorHidden = on },
    moveTimeAfterNextImport(opts = {}) { importTimeMove = { ms: opts.ms ?? 2000, revisionMs: opts.revisionMs ?? null, fileTimeAs: opts.fileTimeAs ?? null, afterMs: opts.afterMs ?? 0 } },
    settleFileAfterNextGets(count, ms = 1000) { fileSettles = { count, ms } },
    editAfterNextImport(edits) { importEdits = edits.map(e => ({ content: e.content, by: e.by ?? SOMEONE_ELSE, omitted: e.omittedFromRevisions ?? false })) },
    settleRevisionAfterNextLists(count, ms = 1000) { revisionSettles = { count, ms } },
    reshapeRevisionsAfterNextImport(kind) { importReshape = kind },
    failNextExports(count) { exportFailures = count },
    staleNextExport(text) { staleExport = text },
    failNextFileSearches(count) { searchFailures = count },
    ignoreRefreshScope: false,
    refuseExport(docId, reason = 'appNotAuthorizedToFile') { exportRefused.set(docId, reason) },
    refuseDocs(docId, reason = 'PERMISSION_DENIED') { docsRefused.set(docId, reason) },
    blockCopy(docId) { copyBlocked.add(docId) },
    reset() { faults.delayMs = 0; failCount = 0; failPrefix = null; dropCount = 0; editBeforeExport = []; importTimeMove = null; pendingMoves = []; fileSettles = { count: 0, ms: 0 }; importEdits = []; revisionSettles = { count: 0, ms: 0 }; importReshape = null; revisionListFailures = 0; revisionListFailAfter = 0; revisionPageSize = 0; fileGetFailures = 0; newestAuthorHidden = false; exportFailures = 0; staleExport = null; searchFailures = 0; faults.ignoreRefreshScope = false; exportRefused.clear(); docsRefused.clear(); copyBlocked.clear() },
  }

  const app = new Hono()
  const seen = (c: Context) => {
    const headerValues: string[] = []
    c.req.raw.headers.forEach(v => { headerValues.push(v) })
    return { search: new URL(c.req.url).search, headerValues }
  }

  app.use('*', async (c, next) => {
    applyDueMoves()
    const control = c.req.path.startsWith('/__fake/')
    if (!control && faults.delayMs > 0) await new Promise(r => setTimeout(r, faults.delayMs))
    if (!control && c.req.path !== '/o/oauth2/v2/auth' && failCount > 0 && (failPrefix === null || c.req.path.startsWith(failPrefix))) {
      failCount--
      const message = failStatus === 429 ? 'Resource has been exhausted (e.g. check quota).' : 'Internal error encountered.'
      const err = apiError(failStatus, message, failStatus === 429 ? 'rateLimitExceeded' : 'backendError')
      const res = c.json(err.body as object, failStatus as 500)
      requests.push({ method: c.req.method, path: c.req.path, status: failStatus, ...seen(c) })
      return res
    }
    await next()
    requests.push({ method: c.req.method, path: c.req.path, status: c.res.status, ...seen(c) })
  })

  app.onError((err, c) => {
    if (err instanceof GoogleApiError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v)
      return c.json(err.body as object, err.status as 400)
    }
    throw err
  })

  // ---- OAuth 2.0 ----

  function normalizeScopes(raw: string): string[] {
    return [...new Set(raw.split(/\s+/).filter(Boolean).map(s => SCOPE_ALIASES[s] ?? s))]
  }

  /** The error page Google shows instead of redirecting (unknown client, unregistered redirect URI). */
  const errorPage = (c: Context, status: number, error: string, detail: string) =>
    c.text(`Error ${status}: ${error}\n${detail}`, status as 400)

  app.get('/o/oauth2/v2/auth', c => {
    const q = c.req.query()
    const client = clients.get(q.client_id ?? '')
    if (!client) return errorPage(c, 401, 'invalid_client', 'The OAuth client was not found.')
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return errorPage(c, 400, 'redirect_uri_mismatch', 'You can\'t sign in to this app because it doesn\'t comply with Google\'s OAuth 2.0 policy.')
    }
    if (q.response_type !== 'code') return errorPage(c, 400, 'invalid_request', 'Invalid response_type: only "code" is supported.')
    if (!q.scope) return errorPage(c, 400, 'invalid_request', 'Missing required parameter: scope')
    const scopes = normalizeScopes(q.scope)
    const unknown = scopes.filter(s => !KNOWN_SCOPES.has(s))
    if (unknown.length > 0) return errorPage(c, 400, 'invalid_scope', `Some requested scopes were invalid. {invalid=[${unknown.join(', ')}]}`)
    if (!q.state) return errorPage(c, 400, 'invalid_request', 'The fake requires a state parameter.')
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) {
      return errorPage(c, 400, 'invalid_request', 'The fake requires a PKCE code_challenge with code_challenge_method=S256.')
    }
    const back = new URL(q.redirect_uri)
    back.searchParams.set('state', q.state)
    if ('deny' in signInChoice) {
      back.searchParams.set('error', 'access_denied')
      return c.redirect(back.toString(), 302)
    }
    const user = users.get(signInChoice.email.toLowerCase())
    if (!user) return errorPage(c, 400, 'invalid_request', 'The fake has no such account to sign in.')
    if (client.internalDomain && user.hd !== client.internalDomain) {
      return errorPage(c, 403, 'org_internal', 'This client is restricted to users within its organization.')
    }
    const withheld = new Set(normalizeScopes((signInChoice.withholdScopes ?? []).join(' ')))
    // openid and email are always granted; the person can untick the others (granular consent).
    const granted = scopes.filter(s => s === GOOGLE_SCOPES.openid || s === GOOGLE_SCOPES.email || !withheld.has(s))
    const code = `${FAKE_CODE_PREFIX}${randomToken()}`
    codes.set(code, {
      clientId: client.clientId, redirectUri: q.redirect_uri, email: user.email, scopes: granted,
      codeChallenge: q.code_challenge!, offline: q.access_type === 'offline', expiresAt: now() + 10 * 60_000, used: false,
    })
    back.searchParams.set('code', code)
    back.searchParams.set('scope', granted.join(' '))
    back.searchParams.set('authuser', '0')
    if (user.hd) back.searchParams.set('hd', user.hd)
    back.searchParams.set('prompt', 'consent')
    return c.redirect(back.toString(), 302)
  })

  async function formOf(c: Context): Promise<Record<string, string>> {
    const body = await c.req.parseBody().catch(() => ({}))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
    return out
  }

  function authenticateClient(c: Context, form: Record<string, string>): FakeClient {
    let id = form.client_id
    let secret = form.client_secret
    const basic = /^Basic (\S+)$/.exec(c.req.header('authorization') ?? '')
    if (basic) {
      const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':')
      id = decodeURIComponent(u ?? ''); secret = decodeURIComponent(p ?? '')
    }
    const client = clients.get(id ?? '')
    if (!client || client.clientSecret !== secret) throw oauthError(401, 'invalid_client', 'Unauthorized')
    return client
  }

  function issueAccess(clientId: string, email: string, scopes: string[], refreshToken: string | null) {
    const token = `${FAKE_ACCESS_TOKEN_PREFIX}${randomToken(32)}`
    accessTokens.set(token, { clientId, email, scopes, expiresAt: now() + 3599_000, refreshToken, live: true })
    return token
  }

  function issueRefresh(clientId: string, email: string, scopes: string[]) {
    const token = `${FAKE_REFRESH_TOKEN_PREFIX}${randomToken(32)}`
    refreshTokens.set(token, { token, clientId, email, scopes, createdAt: now(), live: true })
    // Google keeps a limited number per client and account and silently invalidates the oldest.
    const live = [...refreshTokens.values()].filter(r => r.live && r.clientId === clientId && r.email === email)
    for (const old of live.slice(0, Math.max(0, live.length - refreshLimit))) revokeRefresh(old.token)
    return token
  }

  function revokeRefresh(token: string) {
    const r = refreshTokens.get(token)
    if (!r) return
    r.live = false
    for (const a of accessTokens.values()) if (a.refreshToken === token) a.live = false
  }

  /** An unsigned-looking ID token: the claims Google puts in one (read it without trusting it; prefer userinfo). */
  function idToken(clientId: string, email: string): string {
    const u = users.get(email.toLowerCase())!
    const t = Math.floor(now() / 1000)
    const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)))
    const claims = { iss: 'https://accounts.google.com', azp: clientId, aud: clientId, sub: u.sub, email: u.email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}), iat: t, exp: t + 3599 }
    return `${enc({ alg: 'RS256', kid: 'fake-google-key', typ: 'JWT' })}.${enc(claims)}.${b64url(Buffer.from('fake-signature-not-verifiable'))}`
  }

  app.post('/token', async c => {
    const form = await formOf(c)
    const client = authenticateClient(c, form)
    if (form.grant_type === 'authorization_code') {
      const grant = codes.get(form.code ?? '')
      if (!grant || grant.clientId !== client.clientId) throw oauthError(400, 'invalid_grant', 'Malformed auth code.')
      if (grant.used || grant.expiresAt < now()) throw oauthError(400, 'invalid_grant', 'Bad Request')
      if (form.redirect_uri !== grant.redirectUri) throw oauthError(400, 'redirect_uri_mismatch', 'Bad Request')
      if (!form.code_verifier) throw oauthError(400, 'invalid_grant', 'Missing code verifier.')
      if (b64url(createHash('sha256').update(form.code_verifier).digest()) !== grant.codeChallenge) {
        throw oauthError(400, 'invalid_grant', 'Invalid code verifier.')
      }
      grant.used = true
      const refresh = grant.offline ? issueRefresh(client.clientId, grant.email, grant.scopes) : null
      return c.json({
        access_token: issueAccess(client.clientId, grant.email, grant.scopes, refresh),
        expires_in: 3599,
        ...(refresh ? { refresh_token: refresh } : {}),
        scope: grant.scopes.join(' '),
        token_type: 'Bearer',
        ...(grant.scopes.includes(GOOGLE_SCOPES.openid) ? { id_token: idToken(client.clientId, grant.email) } : {}),
      })
    }
    if (form.grant_type === 'refresh_token') {
      const r = refreshTokens.get(form.refresh_token ?? '')
      if (!r || !r.live || r.clientId !== client.clientId) throw oauthError(400, 'invalid_grant', 'Token has been expired or revoked.')
      // RFC 6749 §6: a subset of the granted scopes may be asked for.
      const asked = form.scope ? normalizeScopes(form.scope) : null
      if (asked && asked.some(s => !r.scopes.includes(s))) throw oauthError(400, 'invalid_scope', 'Some requested scopes were not granted.')
      const scopes = asked && !faults.ignoreRefreshScope ? asked : r.scopes
      return c.json({
        access_token: issueAccess(client.clientId, r.email, scopes, r.token),
        expires_in: 3599,
        scope: scopes.join(' '),
        token_type: 'Bearer',
        ...(r.scopes.includes(GOOGLE_SCOPES.openid) ? { id_token: idToken(client.clientId, r.email) } : {}),
      })
    }
    throw oauthError(400, 'unsupported_grant_type', `Invalid grant_type: ${form.grant_type ?? ''}`)
  })

  /** Revoking either token ends the whole grant (Google's revoke endpoint). */
  app.post('/revoke', async c => {
    const form = await formOf(c)
    const token = form.token ?? c.req.query('token') ?? ''
    const r = refreshTokens.get(token)
    const a = accessTokens.get(token)
    if (r?.live) { revokeRefresh(token); return c.body(null, 200) }
    if (a?.live) {
      a.live = false
      if (a.refreshToken) revokeRefresh(a.refreshToken)
      return c.body(null, 200)
    }
    throw oauthError(400, 'invalid_token', 'Token expired or revoked')
  })

  /** The bearer's grant, or 401; with `needs`, 403 unless one of them was granted. */
  function bearer(c: Context, needs?: string[], service = 'googleapis.com'): AccessGrant {
    const m = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')
    const token = m?.[1] ?? ''
    const a = token.startsWith(FAKE_ACCESS_TOKEN_PREFIX) ? accessTokens.get(token) : undefined
    if (!a || !a.live || a.expiresAt <= now()) throw unauthenticated()
    if (needs && !needs.some(s => a.scopes.includes(s))) throw insufficientScope(service)
    return a
  }

  const userinfo = (c: Context) => {
    const a = bearer(c)
    const u = users.get(a.email.toLowerCase())!
    const out: Record<string, unknown> = { sub: u.sub }
    if (a.scopes.includes(GOOGLE_SCOPES.profile)) Object.assign(out, { name: u.name, given_name: u.givenName, family_name: u.familyName })
    if (a.scopes.includes(GOOGLE_SCOPES.email)) Object.assign(out, { email: u.email, email_verified: true, ...(u.hd ? { hd: u.hd } : {}) })
    return c.json(out)
  }
  app.get('/oauth2/v3/userinfo', userinfo)
  app.get('/v1/userinfo', userinfo)

  // ---- Calendar v3 ----

  type LiveEvent = (typeof events)[number]
  const etagOf = (e: LiveEvent) => `"${(e.updated * 1000 + e.sequence).toString().padStart(16, '0')}"`

  function eventOut(e: LiveEvent, viewer: string) {
    const me = viewer.toLowerCase()
    return {
      kind: 'calendar#event',
      etag: etagOf(e),
      id: e.id,
      status: 'confirmed',
      htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
      created: iso(e.created),
      updated: iso(e.updated),
      summary: e.summary,
      creator: { email: e.organizer, ...(e.organizer.toLowerCase() === me ? { self: true } : {}) },
      organizer: { email: e.organizer, ...(e.organizer.toLowerCase() === me ? { self: true } : {}) },
      start: { dateTime: e.start, timeZone: 'Asia/Tokyo' },
      end: { dateTime: e.end, timeZone: 'Asia/Tokyo' },
      iCalUID: `${e.id}@google.com`,
      sequence: e.sequence,
      attendees: e.attendees.map(a => ({
        email: a.email,
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.email === e.organizer ? { organizer: true } : {}),
        ...(a.email.toLowerCase() === me ? { self: true } : {}),
        responseStatus: a.responseStatus,
      })),
      ...(e.meetingCode ? {
        hangoutLink: `https://meet.google.com/${e.meetingCode}`,
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/${e.meetingCode}`, label: `meet.google.com/${e.meetingCode}` }],
          conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet', iconUri: 'https://fonts.gstatic.com/s/i/productlogos/meet_2020q4/v6/web-512dp/logo_meet_2020q4_color_2x_web_512dp.png' },
          conferenceId: e.meetingCode,
        },
      } : {}),
      reminders: { useDefault: true },
      eventType: 'default',
      ...(e.privateFor?.some(x => x.toLowerCase() === me) ? { visibility: 'private' } : e.visibility ? { visibility: e.visibility } : {}),
      ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
    }
  }

  function calendarOwner(c: Context, a: AccessGrant): string {
    const id = decodeURIComponent(c.req.param('calendarId') ?? '')
    if (id === 'primary' || id.toLowerCase() === a.email.toLowerCase()) return a.email
    throw apiError(404, 'Not Found', 'notFound')
  }
  const onCalendar = (e: LiveEvent, owner: string) =>
    e.organizer.toLowerCase() === owner.toLowerCase() || e.attendees.some(x => x.email.toLowerCase() === owner.toLowerCase())

  app.get('/calendar/v3/calendars/:calendarId/events', c => {
    const a = bearer(c, NEEDS.calendar, 'calendar-json.googleapis.com')
    const owner = calendarOwner(c, a)
    const q = c.req.query()
    for (const k of ['timeMin', 'timeMax'] as const) {
      if (q[k] !== undefined && !RFC3339.test(q[k])) throw apiError(400, 'Bad Request', 'badRequest')
    }
    if (q.orderBy === 'startTime' && q.singleEvents !== 'true') {
      throw apiError(400, 'The requested ordering is not available for the particular query.', 'badRequest')
    }
    if (q.orderBy !== undefined && q.orderBy !== 'startTime' && q.orderBy !== 'updated') throw apiError(400, `Invalid value for orderBy: ${q.orderBy}`, 'invalid')
    const maxResults = q.maxResults === undefined ? 250 : Number(q.maxResults)
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2500) throw apiError(400, 'Invalid value for maxResults', 'invalid')
    const from = q.timeMin ? Date.parse(q.timeMin) : -Infinity
    const to = q.timeMax ? Date.parse(q.timeMax) : Infinity
    // timeMin bounds the event's end, timeMax its start (both exclusive).
    let list = events.filter(e => onCalendar(e, owner) && Date.parse(e.end) > from && Date.parse(e.start) < to)
    if (q.orderBy === 'startTime') list = [...list].sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
    else if (q.orderBy === 'updated') list = [...list].sort((x, y) => x.updated - y.updated)
    const offset = q.pageToken ? Number(Buffer.from(q.pageToken, 'base64url').toString()) : 0
    if (!Number.isInteger(offset) || offset < 0) throw apiError(400, 'Invalid page token value.', 'invalid')
    const pageItems = list.slice(offset, offset + maxResults)
    const next = offset + maxResults < list.length ? Buffer.from(String(offset + maxResults)).toString('base64url') : null
    return c.json({
      kind: 'calendar#events',
      etag: `"${now()}"`,
      summary: owner,
      description: '',
      updated: iso(Math.max(created, ...events.map(e => e.updated))),
      timeZone: 'Asia/Tokyo',
      accessRole: 'owner',
      defaultReminders: [{ method: 'popup', minutes: 10 }],
      ...(next ? { nextPageToken: next } : {}),
      items: pageItems.map(e => eventOut(e, owner)),
    })
  })

  app.get('/calendar/v3/calendars/:calendarId/events/:eventId', c => {
    const a = bearer(c, NEEDS.calendar, 'calendar-json.googleapis.com')
    const owner = calendarOwner(c, a)
    const e = events.find(x => x.id === c.req.param('eventId'))
    if (!e || !onCalendar(e, owner)) throw apiError(404, 'Not Found', 'notFound')
    return c.json(eventOut(e, owner))
  })

  // ---- Meet REST v2 ----

  type LiveConference = (typeof conferences)[number]
  const canSeeConference = (conf: LiveConference, email: string) => conf.participants.some(p => p.toLowerCase() === email.toLowerCase())
  const conferenceOut = (conf: LiveConference) => ({
    name: `conferenceRecords/${conf.id}`,
    startTime: conf.startTime,
    endTime: conf.endTime,
    expireTime: iso(Date.parse(conf.endTime) + 30 * 24 * 3600_000),
    space: conf.space,
  })
  const artifactOut = (conf: LiveConference, kind: 'smartNotes' | 'transcripts', a: SeedArtifact) => ({
    name: `conferenceRecords/${conf.id}/${kind}/${a.id}`,
    state: a.state,
    startTime: conf.startTime,
    ...(a.state !== 'STARTED' ? { endTime: conf.endTime } : {}),
    // The document exists once the file is generated.
    ...(a.state === 'FILE_GENERATED' ? { docsDestination: { document: a.docId, exportUri: `https://docs.google.com/document/d/${a.docId}/view` } } : {}),
  })
  const meetNotFound = () => apiError(404, 'Requested entity was not found.')

  /** The list filter: `space.meeting_code = "…"`, `space.name = "…"`, `start_time >= "…"` / `<=` / `>` / `<`, `end_time IS NULL`, joined by AND. */
  function conferenceFilter(filter: string): (conf: LiveConference) => boolean {
    const tests: ((conf: LiveConference) => boolean)[] = []
    for (const part of filter.split(/\s+AND\s+/i).map(s => s.trim()).filter(Boolean)) {
      let m = /^(space\.meeting_code|space\.name)\s*=\s*"([^"]*)"$/.exec(part)
      if (m) {
        const [, field, value] = m
        tests.push(conf => (field === 'space.name' ? conf.space : conf.meetingCode) === value)
        continue
      }
      m = /^(start_time|end_time)\s*(>=|<=|>|<|=)\s*"([^"]+)"$/.exec(part)
      if (m) {
        const [, field, op, value] = m
        const t = Date.parse(value)
        if (Number.isNaN(t)) throw apiError(400, `Invalid filter: ${part}`)
        tests.push(conf => {
          const v = Date.parse(field === 'start_time' ? conf.startTime : conf.endTime)
          return op === '>=' ? v >= t : op === '<=' ? v <= t : op === '>' ? v > t : op === '<' ? v < t : v === t
        })
        continue
      }
      if (/^end_time\s+IS\s+NULL$/i.test(part)) { tests.push(() => false); continue }
      throw apiError(400, `Invalid filter: ${part}`)
    }
    return conf => tests.every(t => t(conf))
  }

  function pageOf<T>(items: T[], c: Context, def: number) {
    const size = Math.min(c.req.query('pageSize') ? Number(c.req.query('pageSize')) : def, 100)
    if (!Number.isInteger(size) || size < 1) throw apiError(400, 'Invalid page size.')
    const token = c.req.query('pageToken')
    const offset = token ? Number(Buffer.from(token, 'base64url').toString()) : 0
    if (!Number.isInteger(offset) || offset < 0) throw apiError(400, 'Invalid page token.')
    const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString('base64url') : null
    return { slice: items.slice(offset, offset + size), next }
  }

  app.get('/v2/conferenceRecords', c => {
    const a = bearer(c, NEEDS.meet, 'meet.googleapis.com')
    const keep = conferenceFilter(c.req.query('filter') ?? '')
    const list = conferences.filter(conf => canSeeConference(conf, a.email) && keep(conf))
      .sort((x, y) => Date.parse(y.startTime) - Date.parse(x.startTime))
    const { slice, next } = pageOf(list, c, 25)
    // An empty list is `{}`: Google leaves out empty repeated fields.
    return c.json({ ...(slice.length ? { conferenceRecords: slice.map(conferenceOut) } : {}), ...(next ? { nextPageToken: next } : {}) })
  })

  function visibleConference(c: Context, a: AccessGrant): LiveConference {
    const conf = conferences.find(x => x.id === c.req.param('id'))
    if (!conf || !canSeeConference(conf, a.email)) throw meetNotFound()
    return conf
  }

  app.get('/v2/conferenceRecords/:id', c => c.json(conferenceOut(visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com')))))

  for (const kind of ['smartNotes', 'transcripts'] as const) {
    app.get(`/v2/conferenceRecords/:id/${kind}`, c => {
      const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
      const { slice, next } = pageOf(conf[kind], c, 10)
      return c.json({ ...(slice.length ? { [kind]: slice.map(a => artifactOut(conf, kind, a)) } : {}), ...(next ? { nextPageToken: next } : {}) })
    })
    app.get(`/v2/conferenceRecords/:id/${kind}/:artifactId`, c => {
      const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
      const a = conf[kind].find(x => x.id === c.req.param('artifactId'))
      if (!a) throw meetNotFound()
      return c.json(artifactOut(conf, kind, a))
    })
  }

  const participantId = (speaker: string) => Buffer.from(speaker).toString('base64url')
  app.get('/v2/conferenceRecords/:id/transcripts/:transcriptId/entries', c => {
    const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
    const t = conf.transcripts.find(x => x.id === c.req.param('transcriptId'))
    if (!t) throw meetNotFound()
    const { slice, next } = pageOf(t.entries ?? [], c, 10)
    return c.json({
      ...(slice.length ? { transcriptEntries: slice.map((e, i) => ({
        name: `conferenceRecords/${conf.id}/transcripts/${t.id}/entries/${i}`, participant: `conferenceRecords/${conf.id}/participants/${participantId(e.speaker)}`, text: e.text, languageCode: 'ja-JP',
      })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
    })
  })
  app.get('/v2/conferenceRecords/:id/participants', c => {
    const conf = visibleConference(c, bearer(c, NEEDS.meet, 'meet.googleapis.com'))
    const speakers = [...new Set(conf.transcripts.flatMap(t => (t.entries ?? []).map(e => e.speaker)))]
    const { slice, next } = pageOf(speakers, c, 100)
    return c.json({
      ...(slice.length ? { participants: slice.map(s => ({ name: `conferenceRecords/${conf.id}/participants/${participantId(s)}`, signedinUser: { user: 'users/fake', displayName: s } })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
    })
  })

  // ---- Drive v3 ----

  type LiveDoc = NonNullable<ReturnType<typeof docs.get>>
  const fileNotFound = (id: string) => apiError(404, `File not found: ${id}.`, 'notFound', { location: 'fileId', locationType: 'parameter' })

  /** With only `drive.meet.readonly`, files Meet did not create do not exist for the token (404, as Drive answers for files out of a narrow scope). */
  function visibleDoc(c: Context): { a: AccessGrant; d: LiveDoc } {
    const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
    const id = c.req.param('fileId') ?? ''
    const d = docs.get(id)
    if (!d || !d.readers.some(r => r.toLowerCase() === a.email.toLowerCase())) throw fileNotFound(id)
    const full = a.scopes.some(s => DRIVE_FULL.has(s))
    if (d.createdByMeet ? !(full || a.scopes.includes(GOOGLE_SCOPES.driveMeetReadonly)) : !full) throw fileNotFound(id)
    return { a, d }
  }

  // ---- Drive files that Meet did not make (drive.file: picked or made by the app) ----

  interface LiveDriveFile extends Omit<SeedDriveFile, 'content'> {
    content: Buffer
    parents: string[]
    appProperties: Record<string, string>
    /** The client that created it (drive.file reaches its own files). */
    createdBy: string | null
    /** `clientId|email` of the accounts that picked it for a client in Google Picker. */
    pickedFor: Set<string>
    modifiedTime: string
    headRevisionId: string
    /** Drive's file version: grows with every change (a Google document's only revision mark). */
    version: number
    /** The MIME type the content was uploaded as (a Google document converted from HTML / Markdown), or null. */
    uploadedAs: string | null
    /** Revisions marked keepForever (binary files only). */
    kept: Set<string>
    /** Every revision, oldest first (`revisions.list`): content, formatting or images changed — never a view. */
    history: Array<{ id: string; modifiedTime: string; by: string }>
    /** Who changed the file last (`files.get` `lastModifyingUser`): an edit's author; a view or a comment does not change it. */
    lastBy: string
    /** Comments on the file (`comments.list`). */
    comments: Array<{ id: string; createdTime: string; modifiedTime: string }>
  }
  /** A change of the file's content or look: a new head revision in its history and a later `modifiedTime`. */
  function newRevision(f: LiveDriveFile, by: string): void {
    f.headRevisionId = `rev-${randomToken(8)}`
    f.modifiedTime = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
    f.history.push({ id: f.headRevisionId, modifiedTime: f.modifiedTime, by })
    f.lastBy = by
  }
  /** `moveTimeAfterNextImport`: Drive's processing moves the time after the upload was answered (no edit, no new revision). */
  function settleImport(f: LiveDriveFile, by: string): void {
    if (f.mimeType === DOC_MIME && importEdits.length > 0) {
      for (const edit of importEdits) {
        f.content = Buffer.from(edit.content, 'utf8')
        f.version += 1
        if (edit.omitted) {
          f.modifiedTime = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
          f.lastBy = edit.by
        } else newRevision(f, edit.by)
      }
      importEdits = []
    }
    if (f.mimeType === DOC_MIME && importReshape) {
      const kind = importReshape
      importReshape = null
      if (kind === 'extra-own') newRevision(f, by)
      else if (kind === 'merged' && f.history.length > 1) {
        const made = f.history.pop()!
        const before = f.history[f.history.length - 1]
        before.modifiedTime = made.modifiedTime
        f.headRevisionId = before.id
      } else if (kind === 'pruned') f.history = f.history.slice(-1)
    }
    if (!importTimeMove || f.mimeType !== DOC_MIME) return
    const { ms, revisionMs, fileTimeAs, afterMs } = importTimeMove
    importTimeMove = null
    const answered = Date.parse(f.modifiedTime)
    const move = () => {
      // `fileTimeAs`: Drive answers this as the file's time from now on (a malformed answer; nothing may edit it after).
      f.modifiedTime = typeof fileTimeAs === 'function' ? fileTimeAs(answered) : fileTimeAs ?? iso(answered + ms)
      f.version += 1
      const last = f.history[f.history.length - 1]
      if (revisionMs !== null && last) last.modifiedTime = iso(answered + revisionMs)
    }
    // `afterMs`: the move happens that long (real time) after the answer, seen by the first request from then on.
    if (afterMs > 0) pendingMoves.push({ dueAt: Date.now() + afterMs, move })
    else move()
  }
  /** Moves due by now (`moveTimeAfterNextImport({ afterMs })`), applied before any request is answered. */
  function applyDueMoves(): void {
    const t = Date.now()
    for (const m of pendingMoves.filter(x => x.dueAt <= t)) { pendingMoves.splice(pendingMoves.indexOf(m), 1); m.move() }
  }
  const driveFiles = new Map<string, LiveDriveFile>((seed.driveFiles ?? []).map(f => {
    const head = `rev-${randomToken(8)}`
    return [f.id, {
      ...f, content: Buffer.from(f.content, 'utf8'), parents: f.parents ?? [], appProperties: {}, createdBy: null, pickedFor: new Set<string>(),
      modifiedTime: iso(created), headRevisionId: head, version: 1, uploadedAs: null, kept: new Set<string>(),
      history: [{ id: head, modifiedTime: iso(created), by: f.owner }], comments: [], lastBy: f.owner,
    }]
  }))
  /** What Drive converts into a Google document on upload (the importable text types this fake knows). */
  const DOC_IMPORTS = new Set(['text/html', 'text/markdown', 'text/plain'])
  const DOC_MIME = 'application/vnd.google-apps.document'
  const uploadOrder: string[] = []
  const keepRefused = new Set<string>()

  /** The file as the bearer's token may see it (drive.file: picked for this client, or made by it), else 404. */
  function visibleDriveFile(a: AccessGrant, id: string): LiveDriveFile {
    const f = driveFiles.get(id)
    const email = a.email.toLowerCase()
    if (!f || !f.readers.some(r => r.toLowerCase() === email)) throw fileNotFound(id)
    const full = a.scopes.some(s => DRIVE_FULL.has(s))
    const narrow = a.scopes.includes(GOOGLE_SCOPES.driveFile) && (f.createdBy === a.clientId || f.pickedFor.has(`${a.clientId}|${email}`))
    if (!full && !narrow) throw fileNotFound(id)
    return f
  }

  const driveFileOut = (f: LiveDriveFile, viewer: string): Record<string, unknown> => ({
    kind: 'drive#file', id: f.id, name: f.name, mimeType: f.mimeType, trashed: false, parents: f.parents, modifiedTime: f.modifiedTime,
    lastModifyingUser: { kind: 'drive#user', me: f.lastBy.toLowerCase() === viewer.toLowerCase() },
    // Drive's file version (int64 as a string): every file has one, Google documents too.
    version: String(f.version),
    webViewLink: f.mimeType === DOC_MIME ? `https://docs.google.com/document/d/${f.id}/edit` : `https://drive.google.com/file/d/${f.id}/view`, appProperties: f.appProperties,
    ...(f.mimeType.startsWith('application/vnd.google-apps.') ? {} : { headRevisionId: f.headRevisionId, size: String(f.content.byteLength) }),
    capabilities: {
      canAddChildren: f.mimeType === 'application/vnd.google-apps.folder' && (f.writers ?? [f.owner]).some(w => w.toLowerCase() === viewer.toLowerCase()),
      canEdit: (f.writers ?? [f.owner]).some(w => w.toLowerCase() === viewer.toLowerCase()),
    },
  })

  /** Drive's `fields` selection: top-level names, `capabilities(...)` kept whole. */
  function selectFields(all: Record<string, unknown>, fields: string | undefined): Record<string, unknown> {
    if (fields === '*') return all
    const wanted = fields ? fields.split(/,(?![^(]*\))/).map(f => f.trim()).filter(Boolean) : ['kind', 'id', 'name', 'mimeType']
    const out: Record<string, unknown> = {}
    for (const f of wanted) {
      if (!/^[a-zA-Z]+(\([^)]*\))?$/.test(f)) throw apiError(400, `Invalid field selection ${f}`, 'invalidParameter', { location: 'fields', locationType: 'parameter' })
      const name = f.replace(/\(.*$/, '')
      if (name in all) out[name] = all[name]
    }
    return out
  }

  app.get('/drive/v3/files/:fileId/permissions', c => {
    const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
    const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
    return c.json({ kind: 'drive#permissionList', permissions: f.permissions.map((p, i) => ({ kind: 'drive#permission', id: `perm-${i}`, ...p })) })
  })

  app.get('/drive/v3/files', c => {
    const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
    if (searchFailures > 0) {
      searchFailures--
      throw apiError(403, 'The user does not have sufficient permissions.', 'insufficientPermissions')
    }
    const q = c.req.query('q') ?? ''
    const m = /^appProperties has \{ key='([A-Za-z0-9_-]+)' and value='([A-Za-z0-9_-]+)' \} and trashed = false$/.exec(q)
    if (!m) throw apiError(400, 'Invalid Value', 'invalid', { location: 'q', locationType: 'parameter' })
    const hits = [...driveFiles.values()].filter(f => f.appProperties[m[1]] === m[2]).filter(f => {
      try { visibleDriveFile(a, f.id); return true } catch { return false }
    })
    return c.json({ kind: 'drive#fileList', files: hits.map(f => selectFields(driveFileOut(f, a.email), 'id,headRevisionId,version,webViewLink')) })
  })

  /** A multipart/related upload: its JSON metadata and its media (with the media part's type). */
  async function multipartOf(c: Context): Promise<{ meta: Record<string, unknown>; media: Buffer; mediaType: string }> {
    if (c.req.query('uploadType') !== 'multipart') throw apiError(400, 'Invalid uploadType', 'badRequest')
    const type = c.req.header('content-type') ?? ''
    const boundary = /^multipart\/related;\s*boundary=([^;]+)$/i.exec(type)?.[1]
    if (!boundary) throw apiError(400, 'Bad content type', 'badContent')
    const raw = Buffer.from(await c.req.arrayBuffer())
    const parts: Array<{ headers: string; body: Buffer }> = []
    const sep = Buffer.from(`--${boundary}`)
    let at = raw.indexOf(sep)
    while (at >= 0) {
      const start = at + sep.byteLength
      if (raw.subarray(start, start + 2).toString() === '--') break
      const next = raw.indexOf(sep, start)
      if (next < 0) break
      const chunk = raw.subarray(start + 2, next - 2) // after CRLF, before CRLF
      const split = chunk.indexOf('\r\n\r\n')
      parts.push({ headers: chunk.subarray(0, split).toString('utf8'), body: chunk.subarray(split + 4) })
      at = next
    }
    if (parts.length !== 2) throw apiError(400, 'Multipart body must have 2 parts', 'badContent')
    const mediaType = /content-type:\s*([^;\r\n]+)/i.exec(parts[1].headers)?.[1]?.trim().toLowerCase() ?? ''
    return { meta: JSON.parse(parts[0].body.toString('utf8')) as Record<string, unknown>, media: Buffer.from(parts[1].body), mediaType }
  }

  app.post('/upload/drive/v3/files', async c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile, `${AUTH}drive`], 'drive.googleapis.com')
    const { meta: rawMeta, media, mediaType } = await multipartOf(c)
    const meta = rawMeta as { name?: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string> }
    const parent = meta.parents?.[0]
    if (!parent) throw apiError(400, 'A parent is required here', 'badRequest')
    const folder = visibleDriveFile(a, parent)
    if (!(driveFileOut(folder, a.email).capabilities as { canAddChildren: boolean }).canAddChildren) throw apiError(403, 'Insufficient permissions for the specified parent.', 'insufficientParentPermissions')
    // A Google document is made from an importable text upload (Drive converts it); anything else is refused.
    if (meta.mimeType === DOC_MIME && !DOC_IMPORTS.has(mediaType)) throw apiError(400, 'The requested conversion is not supported.', 'badRequest')
    const id = `fake-upload-${randomBytes(8).toString('hex')}`
    const head = `rev-${randomToken(8)}`
    const at = iso(now())
    driveFiles.set(id, {
      id, name: meta.name ?? 'Untitled', mimeType: meta.mimeType ?? 'application/octet-stream', owner: a.email, readers: [...folder.readers], content: media,
      permissions: [...folder.permissions], parents: [parent], appProperties: { ...(meta.appProperties ?? {}) }, createdBy: a.clientId, pickedFor: new Set(),
      modifiedTime: at, headRevisionId: head, version: 1, uploadedAs: meta.mimeType === DOC_MIME ? mediaType : null, kept: new Set<string>(),
      history: [{ id: head, modifiedTime: at, by: a.email }], comments: [], lastBy: a.email,
    })
    uploadOrder.push(id)
    const answer = selectFields(driveFileOut(driveFiles.get(id)!, a.email), c.req.query('fields'))
    settleImport(driveFiles.get(id)!, a.email)
    if (dropCount > 0) {
      dropCount--
      return dropAnswer(c)
    }
    return c.json(answer)
  })

  // files.update with media: a new revision of the same file (its id and link stay). drive.file: only a file this
  // client made or the account picked for it; the account must be able to edit it. Only content and appProperties.
  app.patch('/upload/drive/v3/files/:fileId', async c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile, `${AUTH}drive`], 'drive.googleapis.com')
    const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
    if (!(driveFileOut(f, a.email).capabilities as { canEdit: boolean }).canEdit) throw apiError(403, 'The user does not have sufficient permissions for this file.', 'insufficientFilePermissions')
    const { meta, media, mediaType } = await multipartOf(c)
    if (Object.keys(meta).some(k => k !== 'appProperties' && k !== 'name')) throw apiError(400, 'Only name and appProperties may change here', 'badRequest')
    if (f.mimeType === DOC_MIME ? !DOC_IMPORTS.has(mediaType) : mediaType !== f.mimeType) throw apiError(400, 'The requested conversion is not supported.', 'badRequest')
    f.content = media
    if (typeof meta.name === 'string') f.name = meta.name
    f.appProperties = { ...f.appProperties, ...((meta.appProperties ?? {}) as Record<string, string>) }
    f.version += 1
    newRevision(f, a.email)
    if (f.mimeType === DOC_MIME) f.uploadedAs = mediaType
    const answer = selectFields(driveFileOut(f, a.email), c.req.query('fields'))
    settleImport(f, a.email)
    if (dropCount > 0) {
      dropCount--
      return dropAnswer(c)
    }
    return c.json(answer)
  })

  // revisions.list: every revision, oldest first (one page here). drive.file: a file this client made or the account picked.
  // `lastModifyingUser` only when `fields` asks for it (as at Google); `me` is whether the bearer's account made it last.
  app.get('/drive/v3/files/:fileId/revisions', c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile, `${AUTH}drive`], 'drive.googleapis.com')
    const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
    const start = Number(c.req.query('pageToken') ?? '0')
    if (!Number.isInteger(start) || start < 0) throw apiError(400, 'Invalid Value', 'invalid', { location: 'pageToken', locationType: 'parameter' })
    if (revisionListFailures > 0) {
      if (revisionListFailAfter > 0) revisionListFailAfter--
      else {
        revisionListFailures--
        throw apiError(403, 'The user does not have sufficient permissions for this file.', 'insufficientFilePermissions')
      }
    }
    const withUser = (c.req.query('fields') ?? '').includes('lastModifyingUser')
    const end = revisionPageSize > 0 ? Math.min(f.history.length, start + revisionPageSize) : f.history.length
    const newestBefore = f.history[f.history.length - 1]
    const answer = {
      kind: 'drive#revisionList',
      ...(end < f.history.length ? { nextPageToken: String(end) } : {}),
      revisions: f.history.slice(start, end).map(r => ({
        kind: 'drive#revision', id: r.id, modifiedTime: r.modifiedTime,
        ...(withUser && !(newestAuthorHidden && r === f.history[f.history.length - 1]) ? { lastModifyingUser: { kind: 'drive#user', me: r.by.toLowerCase() === a.email.toLowerCase() } } : {}),
      })),
    }
    // `settleRevisionAfterNextLists`: the list was answered in full, then Drive's processing moves the newest revision's time.
    if (end >= f.history.length && revisionSettles.count > 0 && newestBefore) {
      revisionSettles.count--
      newestBefore.modifiedTime = iso(Date.parse(newestBefore.modifiedTime) + revisionSettles.ms)
    }
    return c.json(answer)
  })

  // comments.list: `fields` is required (as at Google); `startModifiedTime` keeps comments changed at or after it.
  app.get('/drive/v3/files/:fileId/comments', c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile, `${AUTH}drive`], 'drive.googleapis.com')
    const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
    if (!c.req.query('fields')) throw apiError(400, "The 'fields' parameter is required for this method.", 'required')
    const since = c.req.query('startModifiedTime')
    const list = f.comments.filter(x => !since || Date.parse(x.modifiedTime) >= Date.parse(since))
    return c.json({ kind: 'drive#commentList', comments: list.map(x => ({ kind: 'drive#comment', ...x })) })
  })

  // revisions.update { keepForever }: binary files only (Drive keeps a Google document's revisions itself); the account
  // must be able to edit the file; the revision must be one it has (here: its head).
  app.patch('/drive/v3/files/:fileId/revisions/:revisionId', async c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile, `${AUTH}drive`], 'drive.googleapis.com')
    const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
    if (!(driveFileOut(f, a.email).capabilities as { canEdit: boolean }).canEdit) throw apiError(403, 'The user does not have sufficient permissions for this file.', 'insufficientFilePermissions')
    if (f.mimeType.startsWith('application/vnd.google-apps.')) throw apiError(400, 'keepForever can only be set on revisions of files with binary content.', 'invalid')
    const rev = c.req.param('revisionId') ?? ''
    if (rev !== f.headRevisionId && !f.kept.has(rev)) throw apiError(404, `Revision not found: ${rev}.`, 'notFound')
    const body = await c.req.json().catch(() => ({})) as { keepForever?: unknown }
    if (body.keepForever === true && !keepRefused.has(f.id)) f.kept.add(rev)
    return c.json(selectFields({ kind: 'drive#revision', id: rev, keepForever: f.kept.has(rev) }, c.req.query('fields')))
  })

  // ---- the stand-in Google Picker (staging: the Picker page in the member's browser loads <origin>/js/api.js) ----

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' }
  app.options('/__picker/*', c => c.body(null, 204, cors))
  app.get('/__picker/files', c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile])
    const mode = c.req.query('mode')
    // Like DocsView.setFileIds: only those files (each still only when the account can read it).
    const only = (c.req.query('ids') ?? '').split(',').filter(Boolean)
    const email = a.email.toLowerCase()
    const list = [...driveFiles.values()]
      .filter(f => f.readers.some(r => r.toLowerCase() === email))
      .filter(f => only.length === 0 || only.includes(f.id))
      .filter(f => (mode === 'folder') === (f.mimeType === 'application/vnd.google-apps.folder'))
      .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
    return c.json({ files: list }, 200, cors)
  })
  app.post('/__picker/pick', async c => {
    const a = bearer(c, [GOOGLE_SCOPES.driveFile])
    const body = await c.req.json().catch(() => ({})) as { ids?: string[] }
    for (const id of body.ids ?? []) driveFiles.get(id)?.pickedFor.add(`${a.clientId}|${a.email.toLowerCase()}`)
    return c.json({ ok: true }, 200, cors)
  })
  app.get('/js/api.js', c => c.body(FAKE_PICKER_SCRIPT, 200, { 'content-type': 'text/javascript; charset=utf-8', ...cors }))

  app.get('/drive/v3/files/:fileId/export', c => {
    if (!docs.has(c.req.param('fileId') ?? '')) {
      const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
      const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
      const mimeType = c.req.query('mimeType')
      if (!f.mimeType.startsWith('application/vnd.google-apps.') || f.mimeType.endsWith('.folder')) throw apiError(403, 'Export only supports Docs Editors files.', 'fileNotExportable')
      if (mimeType !== 'text/plain' && mimeType !== 'text/csv') throw apiError(400, 'The requested conversion is not supported.', 'badRequest')
      const refused = exportRefused.get(f.id)
      if (refused) throw apiError(403, 'The user has not granted the app read access to the file.', refused)
      if (exportFailures > 0) {
        exportFailures--
        throw apiError(403, 'The user has not granted the app read access to the file.', 'appNotAuthorizedToFile')
      }
      if (editBeforeExport.length > 0 && f.mimeType === DOC_MIME) {
        for (const edit of editBeforeExport) {
          f.content = Buffer.from(edit.content, 'utf8')
          f.version += 1
          if (edit.omitted) {
            f.modifiedTime = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
            f.lastBy = edit.by
          } else newRevision(f, edit.by)
        }
        editBeforeExport = []
      }
      const shown = staleExport ?? f.content.toString('utf8')
      staleExport = null
      const text = '\uFEFF' + shown.replace(/\r?\n/g, '\r\n')
      if (Buffer.byteLength(text, 'utf8') > exportLimit) throw apiError(403, 'This file is too large to be exported.', 'exportSizeLimitExceeded')
      // Real Google (2026-11-12): a document's `version` moves without any edit — after an import, when it is opened or
      // read. The fake moves it on every read of its text, so nothing may treat `version` as "someone edited it".
      if (f.mimeType === DOC_MIME) f.version += 1
      return c.body(text, 200, { 'content-type': `${mimeType}; charset=UTF-8` })
    }
    const { d } = visibleDoc(c)
    const refusal = exportRefused.get(c.req.param('fileId') ?? '')
    if (refusal) throw apiError(403, 'The user has not granted the app read access to the file.', refusal)
    const mimeType = c.req.query('mimeType')
    if (!mimeType) throw apiError(400, 'Required parameter: mimeType', 'required', { location: 'mimeType', locationType: 'parameter' })
    if (mimeType !== 'text/plain') throw apiError(400, 'The requested conversion is not supported.', 'badRequest')
    // Docs' plain-text export starts with a byte-order mark and ends lines with CRLF.
    const text = '﻿' + d.text.replace(/\r?\n/g, '\r\n')
    if (Buffer.byteLength(text, 'utf8') > exportLimit) throw apiError(403, 'This file is too large to be exported.', 'exportSizeLimitExceeded')
    return c.body(text, 200, { 'content-type': 'text/plain; charset=UTF-8' })
  })

  app.get('/drive/v3/files/:fileId', c => {
    const sheet = spreadsheets.get(c.req.param('fileId') ?? '')
    if (sheet) {
      // A spreadsheet's metadata (the relay's owner lookup, B-H1): any Drive metadata scope, and the
      // account must be able to open it. In a shared drive Drive names no owner, only `driveId`.
      const a = bearer(c, [GOOGLE_SCOPES.driveMetadataReadonly, `${AUTH}drive.readonly`, `${AUTH}drive`], 'drive.googleapis.com')
      const email = a.email.toLowerCase()
      if (![sheet.owner, ...sheet.editors, ...sheet.readers].some(e => e.toLowerCase() === email)) throw fileNotFound(sheet.id)
      if (c.req.query('supportsAllDrives') !== 'true' && sheet.driveId) throw fileNotFound(sheet.id)
      return c.json(selectFields({
        kind: 'drive#file', id: sheet.id, name: sheet.title, mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(sheet.driveId ? { driveId: sheet.driveId } : { owners: [{ kind: 'drive#user', emailAddress: sheet.owner, me: sheet.owner.toLowerCase() === email }] }),
      }, c.req.query('fields')))
    }
    if (!docs.has(c.req.param('fileId') ?? '')) {
      const a = bearer(c, NEEDS.drive, 'drive.googleapis.com')
      const f = visibleDriveFile(a, c.req.param('fileId') ?? '')
      if (c.req.query('alt') === 'media') {
        if (f.mimeType.startsWith('application/vnd.google-apps.')) throw apiError(403, 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', 'fileNotDownloadable')
        return c.body(new Uint8Array(f.content), 200, { 'content-type': f.mimeType })
      }
      if (fileGetFailures > 0 && f.mimeType === DOC_MIME) {
        fileGetFailures--
        throw apiError(403, 'The user does not have sufficient permissions for this file.', 'insufficientFilePermissions')
      }
      const answer = selectFields(driveFileOut(f, a.email), c.req.query('fields'))
      // `settleFileAfterNextGets`: answered, then Drive's processing moves the file's time.
      if (fileSettles.count > 0 && f.mimeType === DOC_MIME) {
        fileSettles.count--
        f.modifiedTime = iso(Date.parse(f.modifiedTime) + fileSettles.ms)
      }
      return c.json(answer)
    }
    const { d } = visibleDoc(c)
    // headRevisionId is left out: Drive sets it only for files with binary content, not Google Docs.
    const all: Record<string, unknown> = {
      kind: 'drive#file', id: d.id, name: d.name, mimeType: 'application/vnd.google-apps.document',
      version: String(d.version), modifiedTime: d.modifiedTime, createdTime: d.modifiedTime,
      owners: [{ kind: 'drive#user', emailAddress: d.owner, me: false }],
      copyRequiresWriterPermission: copyBlocked.has(d.id),
      capabilities: { canDownload: !copyBlocked.has(d.id) },
    }
    const fields = c.req.query('fields')
    if (fields === '*') return c.json(all)
    const wanted = fields ? fields.split(',').map(f => f.trim()).filter(Boolean) : ['kind', 'id', 'name', 'mimeType']
    const out: Record<string, unknown> = {}
    for (const f of wanted) {
      if (!/^[a-zA-Z]+(\([^)]*\))?$/.test(f)) throw apiError(400, `Invalid field selection ${f}`, 'invalidParameter', { location: 'fields', locationType: 'parameter' })
      const name = f.replace(/\(.*$/, '')
      if (name in all) out[name] = all[name]
      else if (name !== 'headRevisionId') throw apiError(400, `Invalid field selection ${name}`, 'invalidParameter', { location: 'fields', locationType: 'parameter' })
    }
    return c.json(out)
  })

  // ---- Docs (documents.get): any Doc the account can open, whoever made it ----

  app.get('/v1/documents/:documentId', c => {
    const a = bearer(c, NEEDS.docs, 'docs.googleapis.com')
    const id = c.req.param('documentId') ?? ''
    const d = docs.get(id)
    if (!d || !d.readers.some(r => r.toLowerCase() === a.email.toLowerCase())) throw apiError(404, 'Requested entity was not found.', 'notFound')
    const refusal = docsRefused.get(id)
    if (refusal) throw apiError(403, 'The caller does not have permission', refusal)
    const content = d.text.split(/(?<=\n)/).map(line => ({ paragraph: { elements: [{ textRun: { content: line } }] } }))
    const body = { content }
    return c.json(c.req.query('includeTabsContent') === 'true'
      ? { documentId: id, title: d.name, tabs: [{ tabProperties: { title: 'タブ 1' }, documentTab: { body } }] }
      : { documentId: id, title: d.name, body })
  })

  // ---- Gmail ----

  app.post('/gmail/v1/users/:userId/messages/send', async c => {
    const a = bearer(c, NEEDS.gmailSend, 'gmail.googleapis.com')
    const userId = decodeURIComponent(c.req.param('userId') ?? '')
    if (userId !== 'me' && userId.toLowerCase() !== a.email.toLowerCase()) throw apiError(403, 'Delegation denied for ' + a.email, 'forbidden')
    const body = await c.req.json().catch(() => null) as { raw?: unknown; threadId?: unknown } | null
    if (!body || typeof body.raw !== 'string' || body.raw === '') throw apiError(400, '\'raw\' RFC822 payload message string or uploading message via /upload/* URL required', 'invalidArgument')
    const text = Buffer.from(body.raw, 'base64url').toString('utf8')
    const parsed = parseMessage(text)
    if (parsed.to.length + parsed.cc.length + parsed.bcc.length === 0) throw apiError(400, 'Recipient address required', 'invalidArgument')
    if (parsed.from && !addressesOf(parsed.from).some(f => f.toLowerCase() === a.email.toLowerCase())) {
      throw apiError(400, `Invalid From header: not the account ${a.email}`, 'invalidArgument')
    }
    const id = randomBytes(8).toString('hex')
    const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : id
    sent.push({ id, threadId, account: a.email, ...parsed, sentAt: iso(now()), via: 'raw', raw: text })
    if (dropCount > 0) {
      dropCount--
      return dropAnswer(c)
    }
    return c.json({ id, threadId, labelIds: ['SENT'] })
  })

  // messages.send's media upload (a message with attachments, up to 35 MB at Google).
  app.post('/upload/gmail/v1/users/:userId/messages/send', async c => {
    const a = bearer(c, NEEDS.gmailSend, 'gmail.googleapis.com')
    const userId = decodeURIComponent(c.req.param('userId') ?? '')
    if (userId !== 'me' && userId.toLowerCase() !== a.email.toLowerCase()) throw apiError(403, 'Delegation denied for ' + a.email, 'forbidden')
    if (c.req.query('uploadType') !== 'media') throw apiError(400, 'Invalid uploadType', 'badRequest')
    if ((c.req.header('content-type') ?? '').toLowerCase() !== 'message/rfc822') throw apiError(400, 'Media type not supported', 'badContent')
    const raw = Buffer.from(await c.req.arrayBuffer())
    if (raw.byteLength > 35 * 1024 * 1024) throw apiError(413, 'Request too large', 'uploadTooLarge')
    const text = raw.toString('utf8')
    const parsed = parseMessage(text)
    if (parsed.to.length + parsed.cc.length + parsed.bcc.length === 0) throw apiError(400, 'Recipient address required', 'invalidArgument')
    if (parsed.from && !addressesOf(parsed.from).some(f => f.toLowerCase() === a.email.toLowerCase())) {
      throw apiError(400, `Invalid From header: not the account ${a.email}`, 'invalidArgument')
    }
    const id = randomBytes(8).toString('hex')
    sent.push({ id, threadId: id, account: a.email, ...parsed, sentAt: iso(now()), via: 'upload', raw: text })
    if (dropCount > 0) {
      dropCount--
      return dropAnswer(c)
    }
    return c.json({ id, threadId: id, labelIds: ['SENT'] })
  })

  // Received mail (gmail.readonly): only the token's own mailbox; Gmail's message resource shapes.
  const mailboxOf = (c: Context, a: AccessGrant): string => {
    const userId = decodeURIComponent(c.req.param('userId') ?? '')
    if (userId !== 'me' && userId.toLowerCase() !== a.email.toLowerCase()) throw apiError(403, 'Delegation denied for ' + a.email, 'forbidden')
    return a.email.toLowerCase()
  }
  const b64urlText = (buf: Buffer) => buf.toString('base64url')

  app.get('/gmail/v1/users/:userId/messages', c => {
    const a = bearer(c, NEEDS.gmailRead, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    const q = c.req.query('q') ?? ''
    const after = /(?:^|\s)after:(\d+)(?:\s|$)/.exec(q)?.[1]
    const labels = c.req.queries('labelIds') ?? []
    const max = Math.min(Math.max(Number(c.req.query('maxResults') ?? '100') || 100, 1), 500)
    const start = Number(c.req.query('pageToken') ?? '0') || 0
    const found = mails
      .filter(m => m.account.toLowerCase() === box)
      .filter(m => after === undefined || Date.parse(m.receivedAt) >= Number(after) * 1000)
      .filter(m => labels.every(l => m.labelIds.includes(l)))
      .sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt))
    const page = found.slice(start, start + max)
    return c.json({
      ...(page.length > 0 ? { messages: page.map(m => ({ id: m.id, threadId: m.threadId })) } : {}),
      ...(start + max < found.length ? { nextPageToken: String(start + max) } : {}),
      resultSizeEstimate: found.length,
    })
  })

  app.get('/gmail/v1/users/:userId/messages/:id', c => {
    const a = bearer(c, NEEDS.gmailRead, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    const m = mails.find(x => x.id === c.req.param('id') && x.account.toLowerCase() === box)
    if (!m) throw apiError(404, 'Requested entity was not found.', 'notFound')
    const format = c.req.query('format') ?? 'full'
    const wanted = (c.req.queries('metadataHeaders') ?? []).map(h => h.toLowerCase())
    const allHeaders = Object.entries(m.headers).map(([name, value]) => ({ name, value }))
    const base = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: (m.text ?? '').slice(0, 100), internalDate: String(Date.parse(m.receivedAt)), sizeEstimate: 1000 }
    if (format === 'minimal') return c.json(base)
    if (format === 'metadata') {
      const headers = wanted.length === 0 ? allHeaders : allHeaders.filter(h => wanted.includes(h.name.toLowerCase()))
      return c.json({ ...base, payload: { mimeType: 'multipart/alternative', headers } })
    }
    const textBytes = m.textBytesBase64 ? Buffer.from(m.textBytesBase64, 'base64') : Buffer.from(m.text ?? '', 'utf8')
    const charset = /charset=([^;\s]+)/i.exec(m.headers['Content-Type'] ?? '')?.[1] ?? 'UTF-8'
    const parts = [
      ...(m.text !== undefined ? [{ partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }], body: { size: textBytes.length, data: b64urlText(textBytes) } }] : []),
      ...(m.html !== undefined ? [{ partId: '1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { size: Buffer.byteLength(m.html), data: b64urlText(Buffer.from(m.html, 'utf8')) } }] : []),
    ]
    return c.json({ ...base, payload: { partId: '', mimeType: 'multipart/alternative', filename: '', headers: allHeaders, body: { size: 0 }, parts } })
  })

  // Gmail's history (users.history.list): label removals and deletions, per mailbox, ids growing.
  let historySeq = 1000
  let historyKeptFrom = 0
  const history: Array<{ id: number; account: string; kind: 'labelRemoved' | 'labelAdded' | 'messageDeleted'; messageId: string; threadId: string; labelIds: string[] }> = []
  function changeLabels(account: string, threadId: string, add: string[], remove: string[], messageId?: string) {
    for (const m of mails.filter(x => x.threadId === threadId && x.account.toLowerCase() === account.toLowerCase() && (messageId === undefined || x.id === messageId))) {
      const removed = remove.filter(l => m.labelIds.includes(l))
      const added = add.filter(l => !m.labelIds.includes(l))
      m.labelIds = [...m.labelIds.filter(l => !removed.includes(l)), ...added]
      if (removed.length > 0) history.push({ id: ++historySeq, account: m.account.toLowerCase(), kind: 'labelRemoved', messageId: m.id, threadId, labelIds: removed })
      if (added.length > 0) history.push({ id: ++historySeq, account: m.account.toLowerCase(), kind: 'labelAdded', messageId: m.id, threadId, labelIds: added })
    }
  }
  function deleteThread(account: string, threadId: string) {
    for (let i = mails.length - 1; i >= 0; i--) {
      const m = mails[i]
      if (m.threadId !== threadId || m.account.toLowerCase() !== account.toLowerCase()) continue
      mails.splice(i, 1)
      history.push({ id: ++historySeq, account: account.toLowerCase(), kind: 'messageDeleted', messageId: m.id, threadId, labelIds: [] })
    }
  }

  app.get('/gmail/v1/users/:userId/profile', c => {
    const a = bearer(c, NEEDS.gmailRead, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    return c.json({ emailAddress: a.email, messagesTotal: mails.filter(m => m.account.toLowerCase() === box).length, threadsTotal: 0, historyId: String(historySeq) })
  })

  app.get('/gmail/v1/users/:userId/history', c => {
    const a = bearer(c, NEEDS.gmailRead, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    const start = Number(c.req.query('startHistoryId') ?? '')
    if (!Number.isInteger(start) || start <= 0) throw apiError(400, 'Invalid startHistoryId', 'invalidArgument')
    if (start < historyKeptFrom) throw apiError(404, 'Requested entity was not found.', 'notFound')
    const types = c.req.queries('historyTypes') ?? []
    const max = Math.min(Math.max(Number(c.req.query('maxResults') ?? '100') || 100, 1), 500)
    const from = Number(c.req.query('pageToken') ?? '0') || 0
    const found = history.filter(h => h.account === box && h.id > start && (types.length === 0 || types.includes(h.kind)))
    const page = found.slice(from, from + max)
    return c.json({
      ...(page.length > 0 ? {
        history: page.map(h => ({
          id: String(h.id),
          messages: [{ id: h.messageId, threadId: h.threadId }],
          ...(h.kind === 'labelRemoved' ? { labelsRemoved: [{ message: { id: h.messageId, threadId: h.threadId }, labelIds: h.labelIds }] } : {}),
          ...(h.kind === 'labelAdded' ? { labelsAdded: [{ message: { id: h.messageId, threadId: h.threadId }, labelIds: h.labelIds }] } : {}),
          ...(h.kind === 'messageDeleted' ? { messagesDeleted: [{ message: { id: h.messageId, threadId: h.threadId } }] } : {}),
        })),
      } : {}),
      ...(from + max < found.length ? { nextPageToken: String(from + max) } : {}),
      historyId: String(historySeq),
    })
  })

  // Labels of a conversation (gmail.modify): what ACB's archive and its ［元に戻す］ do.
  for (const kind of ['threads', 'messages'] as const) {
    app.post(`/gmail/v1/users/:userId/${kind}/:id/modify`, async c => {
      const a = bearer(c, NEEDS.gmailModify, 'gmail.googleapis.com')
      const box = mailboxOf(c, a)
      const id = c.req.param('id')
      const target = mails.find(m => m.account.toLowerCase() === box && (kind === 'threads' ? m.threadId === id : m.id === id))
      if (!target) throw apiError(404, 'Requested entity was not found.', 'notFound')
      const body = await c.req.json().catch(() => ({})) as { addLabelIds?: string[]; removeLabelIds?: string[] }
      changeLabels(box, target.threadId, body.addLabelIds ?? [], body.removeLabelIds ?? [], kind === 'messages' ? id : undefined)
      return c.json({ id, ...(kind === 'messages' ? { threadId: target.threadId, labelIds: target.labelIds } : {}) })
    })
  }
  app.post('/gmail/v1/users/:userId/threads/:id/trash', c => {
    const a = bearer(c, NEEDS.gmailModify, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    changeLabels(box, c.req.param('id'), ['TRASH'], ['INBOX'])
    return c.json({ id: c.req.param('id') })
  })

  // One conversation of the token's own mailbox, oldest first (users.threads.get, format full | minimal).
  app.get('/gmail/v1/users/:userId/threads/:id', async c => {
    const a = bearer(c, NEEDS.gmailRead, 'gmail.googleapis.com')
    const box = mailboxOf(c, a)
    const inThread = mails
      .filter(x => x.threadId === c.req.param('id') && x.account.toLowerCase() === box)
      .sort((x, y) => Date.parse(x.receivedAt) - Date.parse(y.receivedAt))
    if (inThread.length === 0) throw apiError(404, 'Requested entity was not found.', 'notFound')
    if (c.req.query('format') === 'minimal') {
      return c.json({ id: c.req.param('id'), historyId: String(historySeq), messages: inThread.map(m => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds })) })
    }
    const messages: unknown[] = []
    for (const m of inThread) {
      const res = await app.request(`/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { authorization: c.req.header('authorization') ?? '' } })
      messages.push(await res.json())
    }
    return c.json({ id: c.req.param('id'), historyId: '1', messages })
  })

  /** The send happened; the answer does not arrive. */
  function dropAnswer(c: Context): Promise<Response> {
    const env = c.env as { incoming?: { socket?: { destroy(): void } } } | undefined
    const socket = env?.incoming?.socket
    if (socket) {
      socket.destroy()
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return new Promise<Response>(resolveHeld => {
      const release = () => { held.delete(release); resolveHeld(new Response(null, { status: 504 })) }
      held.add(release)
    })
  }

  // ---- outside changes ----

  function changeEvent(id: string, change: EventChange) {
    const e = events.find(x => x.id === id)
    if (!e) throw new Error(`fake Google: no event ${id}`)
    if (change.removeAttendee) e.attendees = e.attendees.filter(x => x.email.toLowerCase() !== change.removeAttendee!.toLowerCase())
    if (change.addAttendee && !e.attendees.some(x => x.email.toLowerCase() === change.addAttendee!.toLowerCase())) e.attendees.push({ email: change.addAttendee, responseStatus: 'needsAction' })
    if (change.decline) for (const a of e.attendees) if (a.email.toLowerCase() === change.decline.toLowerCase()) a.responseStatus = 'declined'
    if (change.visibility !== undefined) e.visibility = change.visibility
    if (change.summary !== undefined) e.summary = change.summary
    e.sequence++
    e.updated = Math.max(now(), e.updated + 1)
  }

  function changeDoc(id: string, text?: string) {
    const d = docs.get(id)
    if (!d) throw new Error(`fake Google: no document ${id}`)
    d.text = text ?? `${d.text}・（追記）先方より、研修開始を2月に変更したいとの連絡あり\n`
    d.version++
    d.modifiedTime = iso(Math.max(now(), Date.parse(d.modifiedTime) + 1000))
  }

  function setArtifactState(conferenceId: string, kind: 'smartNotes' | 'transcripts', artifactId: string, state: ArtifactState) {
    const a = conferences.find(x => x.id === conferenceId)?.[kind].find(x => x.id === artifactId)
    if (!a) throw new Error(`fake Google: no ${kind} ${artifactId}`)
    a.state = state
  }

  // ---- Sheets v4 (the relay) ----
  type LiveSheet = { sheetId: number; title: string; rows: unknown[][] }
  type LiveSpreadsheet = Omit<SeedSpreadsheet, 'sheets'> & { sheets: LiveSheet[] }
  const spreadsheets = new Map<string, LiveSpreadsheet>((seed.spreadsheets ?? []).map(sp => [sp.id, {
    ...sp, editors: [...sp.editors], readers: [...sp.readers], sheets: sp.sheets.map(sh => ({ ...sh, rows: sh.rows.map(r => [...r]) })),
  }]))
  const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1
  const colName = (i: number): string => { let n = i + 1, out = ''; while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26) } return out }

  /** An A1 range (`'案件'!A1:C3`, `案件!A:C`, `A1`, `案件`) on a spreadsheet, or 400. */
  function a1(sp: LiveSpreadsheet, range: string): { sheet: LiveSheet; r1: number; c1: number; r2: number; c2: number } {
    const bang = range.lastIndexOf('!')
    let name: string | null = bang < 0 ? null : range.slice(0, bang)
    let cells = bang < 0 ? range : range.slice(bang + 1)
    if (bang < 0 && !/^[A-Z]*\d*(:[A-Z]*\d*)?$/.test(range)) { name = range; cells = '' }
    if (name && name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'")
    const sheet = name === null ? sp.sheets[0] : sp.sheets.find(sh => sh.title === name)
    if (!sheet) throw apiError(400, `Unable to parse range: ${range}`, 'badRequest')
    const m = /^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/.exec(cells)
    if (!m) throw apiError(400, `Unable to parse range: ${range}`, 'badRequest')
    const r1 = m[2] ? Number(m[2]) - 1 : 0
    const c1 = m[1] ? colIndex(m[1]) : 0
    const single = m[3] === undefined && m[4] === undefined && !!m[1] && !!m[2]
    const r2 = single ? r1 : m[4] ? Number(m[4]) - 1 : 1_000_000
    const c2 = single ? c1 : m[3] ? colIndex(m[3]) : 1_000
    return { sheet, r1, c1, r2, c2 }
  }
  const rangeName = (sheet: LiveSheet, r1: number, c1: number, r2: number, c2: number) =>
    `${sheet.title}!${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}`

  function readValues(sp: LiveSpreadsheet, range: string) {
    const { sheet, r1, c1, r2, c2 } = a1(sp, range)
    const rows = sheet.rows.slice(r1, r2 + 1).map(r => r.slice(c1, c2 + 1))
    while (rows.length && rows[rows.length - 1].every(v => v === '' || v === undefined)) rows.pop()
    const width = Math.max(0, ...rows.map(r => r.length))
    return { range: rangeName(sheet, r1, c1, r1 + Math.max(rows.length, 1) - 1, c1 + Math.max(width, 1) - 1), majorDimension: 'ROWS', ...(rows.length ? { values: rows } : {}) }
  }

  function writeValues(sp: LiveSpreadsheet, range: string, values: unknown) {
    if (!Array.isArray(values) || !values.every(Array.isArray)) throw apiError(400, 'Invalid values', 'badRequest')
    const { sheet, r1, c1 } = a1(sp, range)
    const rows = values as unknown[][]
    rows.forEach((row, i) => {
      const target = sheet.rows[r1 + i] ?? (sheet.rows[r1 + i] = [])
      for (let j = 0; j < c1; j++) if (target[j] === undefined) target[j] = ''
      row.forEach((v, j) => { target[c1 + j] = v })
    })
    for (let i = 0; i < sheet.rows.length; i++) if (!sheet.rows[i]) sheet.rows[i] = []
    const width = Math.max(1, ...rows.map(r => r.length))
    return { spreadsheetId: sp.id, updatedRange: rangeName(sheet, r1, c1, r1 + rows.length - 1, c1 + width - 1), updatedRows: rows.length, updatedColumns: width, updatedCells: rows.reduce((n, r) => n + r.length, 0) }
  }

  function clearValues(sp: LiveSpreadsheet, range: string) {
    const { sheet, r1, c1, r2, c2 } = a1(sp, range)
    for (let i = r1; i <= Math.min(r2, sheet.rows.length - 1); i++) for (let j = c1; j <= Math.min(c2, (sheet.rows[i]?.length ?? 0) - 1); j++) sheet.rows[i][j] = ''
    return { spreadsheetId: sp.id, clearedRange: rangeName(sheet, r1, c1, Math.min(r2, sheet.rows.length), Math.min(c2, 25)) }
  }

  const sheetsOf = (sp: LiveSpreadsheet) => sp.sheets.map((sh, index) => ({
    properties: { sheetId: sh.sheetId, title: sh.title, index, sheetType: 'GRID', gridProperties: { rowCount: Math.max(1000, sh.rows.length), columnCount: 26 } },
  }))

  app.all('/v4/spreadsheets/*', async c => {
    const write = c.req.method !== 'GET'
    const a = bearer(c, write ? NEEDS.sheetsWrite : NEEDS.sheetsRead, 'sheets.googleapis.com')
    const email = a.email.toLowerCase()
    const seg = c.req.path.split('/').map(decodeURIComponent)
    const [id, verb] = seg[3].split(':')
    const sp = spreadsheets.get(id)
    if (!sp) throw apiError(404, 'Requested entity was not found.', 'notFound')
    const isEditor = sp.owner.toLowerCase() === email || sp.editors.some(e => e.toLowerCase() === email)
    const isReader = isEditor || sp.readers.some(e => e.toLowerCase() === email)
    if (!isReader || (write && !isEditor)) throw apiError(403, 'The caller does not have permission', 'forbidden')
    const body = write ? await c.req.json().catch(() => ({})) as Record<string, unknown> : {}
    const valueInput = () => {
      const opt = c.req.query('valueInputOption') ?? body.valueInputOption
      if (opt !== 'RAW' && opt !== 'USER_ENTERED') throw apiError(400, "'valueInputOption' is required but not specified", 'badRequest')
    }
    if (seg.length === 4) {
      if (verb === undefined && c.req.method === 'GET') return c.json({ spreadsheetId: sp.id, properties: { title: sp.title, locale: 'ja_JP', timeZone: 'Asia/Tokyo' }, sheets: sheetsOf(sp) })
      if (verb === 'batchUpdate' && c.req.method === 'POST') {
        const requests = Array.isArray(body.requests) ? body.requests as Array<Record<string, Record<string, unknown>>> : []
        const replies: unknown[] = []
        for (const r of requests) {
          const [kind] = Object.keys(r)
          const v = r[kind] ?? {}
          if (kind === 'deleteSheet') {
            sp.sheets = sp.sheets.filter(sh => sh.sheetId !== v.sheetId)
            replies.push({})
          } else if (kind === 'addSheet') {
            const title = String((v.properties as { title?: unknown } | undefined)?.title ?? `Sheet${sp.sheets.length + 1}`)
            const sheetId = Math.max(0, ...sp.sheets.map(sh => sh.sheetId)) + 1
            sp.sheets.push({ sheetId, title, rows: [] })
            replies.push({ addSheet: { properties: { sheetId, title, index: sp.sheets.length - 1 } } })
          } else if (kind === 'insertDimension') {
            const range = v.range as { sheetId?: number; dimension?: string; startIndex?: number; endIndex?: number } | undefined
            const sheet = sp.sheets.find(sh => sh.sheetId === range?.sheetId)
            if (!sheet || range?.dimension !== 'ROWS') throw apiError(400, 'Invalid insertDimension', 'badRequest')
            sheet.rows.splice(range.startIndex ?? 0, 0, ...Array.from({ length: (range.endIndex ?? 0) - (range.startIndex ?? 0) }, () => [] as unknown[]))
            replies.push({})
          } else if (kind === 'deleteDimension') {
            const range = v.range as { sheetId?: number; startIndex?: number; endIndex?: number } | undefined
            const sheet = sp.sheets.find(sh => sh.sheetId === range?.sheetId)
            if (sheet) sheet.rows.splice(range?.startIndex ?? 0, (range?.endIndex ?? 0) - (range?.startIndex ?? 0))
            replies.push({})
          } else if (kind === 'updateSheetProperties') {
            // A smaller grid deletes what lies outside it (gspread's resize does this).
            const props = (v.properties ?? {}) as { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } }
            const sheet = sp.sheets.find(sh => sh.sheetId === props.sheetId)
            if (!sheet) throw apiError(400, 'No grid with id', 'badRequest')
            if (typeof props.title === 'string') sheet.title = props.title
            const g = props.gridProperties ?? {}
            if (typeof g.rowCount === 'number') sheet.rows = sheet.rows.slice(0, g.rowCount)
            if (typeof g.columnCount === 'number') sheet.rows = sheet.rows.map(r => r.slice(0, g.columnCount))
            replies.push({})
          } else if (kind === 'updateCells' || kind === 'repeatCell' || kind === 'mergeCells') {
            // Each can wipe values like a clear: updateCells with `fields: *` and no rows, an empty
            // cell repeated, a merge keeping only the top-left value.
            const range = v.range as { sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number } | undefined
            const sheet = sp.sheets.find(sh => sh.sheetId === range?.sheetId)
            if (!sheet) throw apiError(400, 'No grid with id', 'badRequest')
            const r1 = range?.startRowIndex ?? 0, r2 = range?.endRowIndex ?? sheet.rows.length
            const c1 = range?.startColumnIndex ?? 0, c2 = range?.endColumnIndex ?? 26
            const rowsIn = kind === 'updateCells' ? (v.rows as Array<{ values?: Array<{ userEnteredValue?: { stringValue?: string } }> }> | undefined) : undefined
            const repeated = kind === 'repeatCell' ? (v.cell as { userEnteredValue?: { stringValue?: string } } | undefined)?.userEnteredValue?.stringValue ?? '' : undefined
            for (let i = r1; i < Math.min(r2, sheet.rows.length); i++) {
              for (let j = c1; j < Math.min(c2, sheet.rows[i].length); j++) {
                if (kind === 'mergeCells') { if (i !== r1 || j !== c1) sheet.rows[i][j] = '' } else if (kind === 'repeatCell') sheet.rows[i][j] = repeated
                else sheet.rows[i][j] = rowsIn?.[i - r1]?.values?.[j - c1]?.userEnteredValue?.stringValue ?? ''
              }
            }
            replies.push({})
          } else if (kind === 'copyPaste') {
            const src = v.source as { sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }
            const dst = v.destination as typeof src
            const from = sp.sheets.find(sh => sh.sheetId === src?.sheetId)
            const to = sp.sheets.find(sh => sh.sheetId === dst?.sheetId)
            if (!from || !to) throw apiError(400, 'No grid with id', 'badRequest')
            const formulasOnly = v.pasteType === 'PASTE_FORMULA'
            for (let i = 0; i < (src.endRowIndex ?? 0) - (src.startRowIndex ?? 0); i++) {
              const row = to.rows[(dst.startRowIndex ?? 0) + i] ?? (to.rows[(dst.startRowIndex ?? 0) + i] = [])
              for (let j = 0; j < (src.endColumnIndex ?? 0) - (src.startColumnIndex ?? 0); j++) {
                const value = from.rows[(src.startRowIndex ?? 0) + i]?.[(src.startColumnIndex ?? 0) + j] ?? ''
                if (!formulasOnly || (typeof value === 'string' && value.startsWith('='))) row[(dst.startColumnIndex ?? 0) + j] = value
              }
            }
            replies.push({})
          } else if (typeof kind === 'string' && kind.length > 0) {
            replies.push({}) // formatting and the rest: accepted, nothing stored
          } else {
            throw apiError(400, 'Invalid requests', 'badRequest')
          }
        }
        return c.json({ spreadsheetId: sp.id, replies })
      }
      throw apiError(404, 'Not found', 'notFound')
    }
    if (seg.length === 5 && seg[4] === 'values:batchGet' && c.req.method === 'GET') {
      return c.json({ spreadsheetId: sp.id, valueRanges: c.req.queries('ranges')?.map(r => readValues(sp, r)) ?? [] })
    }
    if (seg.length === 5 && seg[4] === 'values:batchUpdate' && c.req.method === 'POST') {
      valueInput()
      const data = Array.isArray(body.data) ? body.data as Array<{ range: string; values: unknown }> : []
      const responses = data.map(d => writeValues(sp, d.range, d.values))
      return c.json({ spreadsheetId: sp.id, totalUpdatedRows: responses.reduce((n, r) => n + r.updatedRows, 0), totalUpdatedCells: responses.reduce((n, r) => n + r.updatedCells, 0), responses })
    }
    if (seg.length === 5 && seg[4] === 'values:batchClear' && c.req.method === 'POST') {
      const ranges = Array.isArray(body.ranges) ? body.ranges as string[] : []
      return c.json({ spreadsheetId: sp.id, clearedRanges: ranges.map(r => clearValues(sp, r).clearedRange) })
    }
    if (seg.length === 6 && seg[4] === 'values') {
      const tail = seg[5]
      if (c.req.method === 'GET') return c.json(readValues(sp, tail))
      if (c.req.method === 'PUT') { valueInput(); return c.json(writeValues(sp, tail, body.values)) }
      if (c.req.method === 'POST' && tail.endsWith(':append')) {
        valueInput()
        const range = tail.slice(0, -':append'.length)
        const { sheet } = a1(sp, range)
        let last = sheet.rows.length - 1
        while (last >= 0 && (sheet.rows[last] ?? []).every(v => v === '' || v === undefined)) last--
        const at = `'${sheet.title.replace(/'/g, "''")}'!A${last + 2}`
        const updates = writeValues(sp, at, body.values)
        return c.json({ spreadsheetId: sp.id, tableRange: rangeName(sheet, 0, 0, Math.max(last, 0), 4), updates })
      }
      if (c.req.method === 'POST' && tail.endsWith(':clear')) return c.json(clearValues(sp, tail.slice(0, -':clear'.length)))
    }
    throw apiError(404, 'Not found', 'notFound')
  })

  function revokeAllFor(email: string) {
    for (const r of refreshTokens.values()) if (r.email.toLowerCase() === email.toLowerCase()) revokeRefresh(r.token)
    for (const t of accessTokens.values()) if (t.email.toLowerCase() === email.toLowerCase()) t.live = false
  }

  function signIn(choice: SignIn) { signInChoice = choice }

  if (options.controlRoutes) {
    const ok = (c: Context, fn: () => void) => {
      try { fn() } catch (err) { return c.json({ error: (err as Error).message }, 400) }
      return c.json({ ok: true })
    }
    app.post('/__fake/sign-in', async c => {
      const body = await c.req.json().catch(() => ({})) as { email?: string; deny?: boolean; withholdScopes?: string[] }
      return ok(c, () => signIn(body.deny ? { deny: true } : { email: body.email ?? '', withholdScopes: body.withholdScopes }))
    })
    app.post('/__fake/faults', async c => {
      const body = await c.req.json().catch(() => ({})) as { delayMs?: number; failNext?: number; failStatus?: number; dropAnswerAfterSend?: number; reset?: boolean }
      if (body.reset) faults.reset()
      if (typeof body.delayMs === 'number') faults.delayMs = body.delayMs
      if (typeof body.failNext === 'number') faults.failNext(body.failNext, body.failStatus)
      if (typeof body.dropAnswerAfterSend === 'number') faults.dropAnswerAfterSend(body.dropAnswerAfterSend)
      return c.json({ ok: true })
    })
    app.post('/__fake/revoke-all', async c => {
      const body = await c.req.json().catch(() => ({})) as { email?: string }
      return ok(c, () => revokeAllFor(body.email ?? ''))
    })
    app.post('/__fake/events/:id', async c => {
      const body = await c.req.json().catch(() => ({})) as { removeAttendee?: string; summary?: string }
      return ok(c, () => changeEvent(c.req.param('id'), body))
    })
    app.post('/__fake/docs/:id', async c => {
      const body = await c.req.json().catch(() => ({})) as { text?: string }
      return ok(c, () => changeDoc(c.req.param('id'), body.text))
    })
    app.post('/__fake/conferences/:id/:kind/:artifactId', async c => {
      const body = await c.req.json().catch(() => ({})) as { state?: ArtifactState }
      const kind = c.req.param('kind')
      if (kind !== 'smartNotes' && kind !== 'transcripts') return c.json({ error: 'kind is smartNotes or transcripts' }, 400)
      return ok(c, () => setArtifactState(c.req.param('id'), kind, c.req.param('artifactId'), body.state ?? 'FILE_GENERATED'))
    })
    app.get('/__fake/gmail/sent', c => c.json({ messages: sent }))
  }

  return {
    app,
    addClient(input) {
      const client: FakeClient = {
        clientId: input.clientId ?? `${randomBytes(6).toString('hex')}-fake.apps.googleusercontent.com`,
        clientSecret: input.clientSecret ?? `${FAKE_GOOGLE_SECRET_PREFIX}${randomToken(18)}`,
        redirectUris: [...input.redirectUris],
        ...(input.internalDomain ? { internalDomain: input.internalDomain } : {}),
      }
      if (!client.clientSecret.startsWith(FAKE_GOOGLE_SECRET_PREFIX)) throw new Error(`fake Google client secrets start with ${FAKE_GOOGLE_SECRET_PREFIX}`)
      clients.set(client.clientId, client)
      return client
    },
    signIn,
    deliver(mail) { mails.push({ ...mail, headers: { ...mail.headers }, labelIds: [...mail.labelIds] }) },
    archiveInGmail(account, threadId) { changeLabels(account, threadId, [], ['INBOX']) },
    deleteInGmail(account, threadId) { deleteThread(account, threadId) },
    archiveMessageInGmail(account, messageId) {
      const m = mails.find(x => x.id === messageId && x.account.toLowerCase() === account.toLowerCase())
      if (m) changeLabels(account, m.threadId, [], ['INBOX'], messageId)
    },
    threadLabels(account, threadId) {
      return mails.filter(m => m.threadId === threadId && m.account.toLowerCase() === account.toLowerCase())
        .sort((x, y) => Date.parse(x.receivedAt) - Date.parse(y.receivedAt)).map(m => [...m.labelIds])
    },
    expireHistory() { historyKeptFrom = historySeq + 1 },
    revokeAllFor,
    changeEvent,
    changeDoc,
    setArtifactState,
    sent,
    doc(id) {
      const d = docs.get(id)
      return d ? { text: d.text, version: d.version, modifiedTime: d.modifiedTime } : null
    },
    refreshTokenCount(clientId, email) {
      return [...refreshTokens.values()].filter(r => r.live && r.clientId === clientId && r.email.toLowerCase() === email.toLowerCase()).length
    },
    faults,
    requests,
    close() { for (const release of [...held]) release() },
    pick(clientId, email, ids) {
      for (const id of ids) {
        const f = driveFiles.get(id)
        if (!f) throw new Error(`fake Google: no Drive file ${id}`)
        f.pickedFor.add(`${clientId}|${email.toLowerCase()}`)
      }
    },
    driveFile(id) {
      const f = driveFiles.get(id)
      return f ? {
        name: f.name, mimeType: f.mimeType, parents: [...f.parents], content: f.content, appProperties: { ...f.appProperties }, createdBy: f.createdBy,
        version: f.version, headRevisionId: f.headRevisionId, uploadedAs: f.uploadedAs, keptRevisions: [...f.kept],
        modifiedTime: f.modifiedTime, revisions: f.history.map(r => ({ ...r })),
      } : null
    },
    refuseKeepForever(id) { keepRefused.add(id) },
    editDriveFile(id, content, by = SOMEONE_ELSE) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.content = Buffer.from(content, 'utf8')
      f.version += 1
      newRevision(f, by)
    },
    editDriveFileMerged(id, content) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.content = Buffer.from(content, 'utf8')
      f.version += 1
      f.modifiedTime = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
      const last = f.history[f.history.length - 1]
      if (last) { last.modifiedTime = f.modifiedTime; f.lastBy = last.by }
    },
    formatDriveFileMerged(id) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.version += 1
      f.modifiedTime = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
      const last = f.history[f.history.length - 1]
      if (last) { last.modifiedTime = f.modifiedTime; f.lastBy = last.by }
    },
    formatDriveFile(id, by = SOMEONE_ELSE) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.version += 1
      newRevision(f, by)
    },
    commentOnDriveFile(id) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      const at = iso(Math.max(now(), Date.parse(f.modifiedTime) + 1000))
      f.comments.push({ id: `comment-${randomToken(6)}`, createdTime: at, modifiedTime: at })
      f.version += 1
    },
    openDriveFile(id) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      // Viewing moves the version only: modifiedTime is the last change by anyone (Drive's viewedByMeTime is separate).
      f.version += 3
    },
    shareDriveFile(id, permission) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.permissions = [...f.permissions, permission]
    },
    moveDriveFile(id, folderId) {
      const f = driveFiles.get(id)
      if (!f) throw new Error(`fake Google: no Drive file ${id}`)
      f.parents = [folderId]
    },
    spreadsheet(id) {
      const sp = spreadsheets.get(id)
      return sp ? { title: sp.title, sheets: sp.sheets.map(sh => ({ sheetId: sh.sheetId, title: sh.title, rows: sh.rows.map(r => [...r]) })) } : null
    },
    uploads() {
      return uploadOrder.map(id => driveFiles.get(id)!).map(f => ({ id: f.id, name: f.name, parents: [...f.parents], mimeType: f.mimeType }))
    },
  }
}

/**
 * A stand-in for Google Picker (`gapi.load('picker')`, `google.picker.*`), for
 * staging only. The server's Picker page loads it in the member's own browser
 * (the page holding the one-time pick ticket, google-drive.md), as it would
 * Google's: it lists what `/__picker/files` returns for the token, and on a
 * click marks the choice as picked (`/__picker/pick`) and calls back like
 * Google Picker (`{ action: 'picked', docs: [{ id }] }`). `DocsView.setFileIds`
 * narrows the list to those files, as Google's does.
 */
const FAKE_PICKER_SCRIPT = `(function () {
  var origin = (document.currentScript && new URL(document.currentScript.src).origin) || ''
  function DocsView(viewId) { this.viewId = viewId; this.fileIds = ''; this.label = '' }
  DocsView.prototype.setFileIds = function (ids) { this.fileIds = String(ids); return this }
  DocsView.prototype.setLabel = function (label) { this.label = String(label); return this }
  ;['setIncludeFolders', 'setSelectFolderEnabled', 'setMimeTypes', 'setEnableDrives', 'setParent', 'setOwnedByMe'].forEach(function (m) { DocsView.prototype[m] = function () { return this } })
  function PickerBuilder() { this.o = { views: [] } }
  // The first view added is the tab the Picker opens on: the stand-in shows that one (and names every tab, in order).
  PickerBuilder.prototype.addView = function (v) { if (!this.o.view) this.o.view = v; this.o.views.push(v); return this }
  PickerBuilder.prototype.setOAuthToken = function (t) { this.o.token = t; return this }
  PickerBuilder.prototype.setCallback = function (f) { this.o.cb = f; return this }
  ;['setDeveloperKey', 'setAppId', 'setOrigin', 'setLocale', 'setTitle', 'enableFeature', 'setMaxItems'].forEach(function (m) { PickerBuilder.prototype[m] = function () { return this } })
  PickerBuilder.prototype.build = function () {
    var o = this.o
    return { setVisible: function () {
      var mode = o.view.viewId === 'folders' ? 'folder' : 'files'
      var auth = { authorization: 'Bearer ' + o.token }
      fetch(origin + '/__picker/files?mode=' + mode + (o.view.fileIds ? '&ids=' + encodeURIComponent(o.view.fileIds) : ''), { headers: auth }).then(function (r) { return r.json() }).then(function (j) {
        var box = document.createElement('div')
        box.id = 'fake-picker'
        box.setAttribute('data-tabs', o.views.map(function (v) { return v.label }).join(','))
        ;(j.files || []).forEach(function (f) {
          var b = document.createElement('button')
          b.textContent = f.name
          b.setAttribute('data-id', f.id)
          b.onclick = function () {
            fetch(origin + '/__picker/pick', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify({ ids: [f.id] }) })
              .then(function () { o.cb({ action: 'picked', docs: [{ id: f.id, name: f.name, mimeType: f.mimeType }] }) })
          }
          box.appendChild(b)
        })
        var cancel = document.createElement('button')
        cancel.textContent = 'キャンセル'
        cancel.onclick = function () { o.cb({ action: 'cancel' }) }
        box.appendChild(cancel)
        document.body.appendChild(box)
      })
    } }
  }
  window.google = window.google || {}
  window.google.picker = { DocsView: DocsView, PickerBuilder: PickerBuilder, ViewId: { DOCS: 'all', FOLDERS: 'folders' }, Action: { PICKED: 'picked', CANCEL: 'cancel' }, Feature: { MULTISELECT_ENABLED: 'multiselect' } }
  window.gapi = { load: function (_name, opts) { setTimeout(function () { (opts.callback || opts)() }, 0) } }
})()`

// ---- RFC 2822 (what the server's mail builder produces; enough to read it back) ----

/** `=?UTF-8?B?…?=` / `=?UTF-8?Q?…?=` encoded words (RFC 2047). */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, _cs: string, enc: string, text: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
}

function decodeQuotedPrintable(s: string): string {
  const bytes = s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
  return Buffer.from(bytes, 'latin1').toString('utf8')
}

/** The bare addresses of a header (`"名前" <a@b>, c@d`). */
export function addressesOf(header: string): string[] {
  return header.split(',').map(s => s.trim()).filter(Boolean).map(s => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim())
}

function splitHeadersBody(text: string): { headers: Record<string, string>; body: string } {
  const sep = /\r?\n\r?\n/.exec(text)
  const head = sep ? text.slice(0, sep.index) : text
  const body = sep ? text.slice(sep.index + sep[0].length) : ''
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { headers, body }
}

function decodeBody(headers: Record<string, string>, body: string): string {
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

/** An RFC 2231 parameter (`name*0*=UTF-8''…; name*1*=…`, or `name*=…`, or a plain `name="…"`) of a header value. */
export function headerParameter(value: string, name: string): string | null {
  const pieces = new Map<number, string>()
  let charset = 'utf-8'
  for (const m of value.matchAll(new RegExp(`;\\s*${name}\\*(\\d+)?\\*?=([^;]*)`, 'gi'))) {
    let v = m[2].trim()
    const n = m[1] === undefined ? 0 : Number(m[1])
    if (n === 0 && /^[^']*'[^']*'/.test(v)) { charset = v.slice(0, v.indexOf("'")).toLowerCase(); v = v.slice(v.indexOf("'", v.indexOf("'") + 1) + 1) }
    pieces.set(n, v)
  }
  if (pieces.size > 0) {
    const joined = [...pieces.keys()].sort((x, y) => x - y).map(k => pieces.get(k)).join('')
    const bytes = Buffer.from(joined.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
    return charset === 'utf-8' ? bytes.toString('utf8') : bytes.toString('latin1')
  }
  const plain = new RegExp(`;\\s*${name}="?([^";]*)"?`, 'i').exec(value)
  return plain ? decodeWords(plain[1]) : null
}

function parseMessage(text: string): Omit<SentMessage, 'id' | 'threadId' | 'account' | 'sentAt' | 'via' | 'raw'> {
  const { headers, body } = splitHeadersBody(text)
  let plain = decodeBody(headers, body)
  const attachments: SentMessage['attachments'] = []
  const boundary = /multipart\/[^;]+;.*boundary="?([^";]+)"?/i.exec(headers['content-type'] ?? '')?.[1]
  if (boundary) {
    // The first text/plain part; every part with Content-Disposition: attachment is a file.
    const parts = body.split(`--${boundary}`).slice(1).filter(p => !p.startsWith('--')).map(p => splitHeadersBody(p.replace(/^\r?\n/, '')))
    const part = parts.find(p => (p.headers['content-type'] ?? 'text/plain').toLowerCase().startsWith('text/plain'))
    plain = part ? decodeBody(part.headers, part.body) : ''
    for (const p of parts) {
      const disposition = p.headers['content-disposition'] ?? ''
      if (!/^attachment\b/i.test(disposition)) continue
      const bytes = (p.headers['content-transfer-encoding'] ?? '').toLowerCase() === 'base64' ? Buffer.from(p.body.replace(/\s+/g, ''), 'base64') : Buffer.from(p.body, 'latin1')
      attachments.push({ filename: headerParameter(disposition, 'filename'), contentType: (p.headers['content-type'] ?? '').split(';')[0].trim(), disposition, bytes })
    }
  }
  const list = (name: string) => (headers[name] ? addressesOf(decodeWords(headers[name])) : [])
  return {
    from: headers.from ? decodeWords(headers.from) : null,
    to: list('to'),
    cc: list('cc'),
    bcc: list('bcc'),
    subject: decodeWords(headers.subject ?? ''),
    body: plain.replace(/\r\n/g, '\n'),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, decodeWords(v)])),
    attachments,
  }
}

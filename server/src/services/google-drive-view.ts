/**
 * Streaming a picked Drive video to the member's own player (google-drive.md "Streaming a picked video"; the model of
 * its authorization and lifecycle: model/drive-view/). Part of the Google connector's module.
 *
 * One request = one answer of at most `chunkBytes` (a shorter 206 is valid): the player asks range by range, so every
 * range is authorized again. In order, nothing sent to Google before the last:
 *   1. the view pick (`googleDrive.useViewPick`: operator stop, company Google and its Drive switch, the member's grant
 *      with `drive.file` and Drive on, a live view pick of this file by this member under the account the grant has
 *      now; renews it) — its refusal is answered as is;
 *   2. the Range header's form (one `bytes=a-b` or `bytes=a-`; anything else 416 before anything is counted);
 *   3. the caps, in one synchronous stretch (requests per minute, answers streaming at once, the member's and the
 *      company's bytes today): over one → 429, nothing counted for the stream, nothing asked of Google;
 *   4. the session's metadata (type and size, read once per viewing session, not per range);
 *   5. the bytes reserved before the call (the member's and the company's day, so concurrent answers can never pass the
 *      caps), the unsent part given back when the answer ends;
 *   6. `googleClient.streamMedia` under the grant step 1 saw (a re-consent meanwhile sends nothing).
 * An answer ends exactly once (finished, the viewer gone, an error): its stream slot is released and its unsent bytes
 * given back then. A viewing session (member × file, until `sessionIdleMs` without a request) files one AI-action-log
 * line when it ends, with the bytes served; nothing per range. No file id or name is logged or recorded.
 */
import { GOOGLE_SCOPE } from '../../shared/core/google'
import { DRIVE_VIEW_MIMES } from '../../shared/core/google-drive'
import type { Clock } from '../ports/clock'
import type { Member } from './access'
import type { GoogleClient } from './google-client'
import type { DriveViewUse } from './google-drive'
import { ok, refuse, type Outcome, type Refusal } from './outcome'

/** The limits, read per use (lib/config.ts `driveViewLimits`, which documents each). */
export interface DriveViewLimits {
  chunkBytes: number
  memberDayBytes: number
  companyDayBytes: number
  memberStreams: number
  memberPerMinute: number
  sessionIdleMs: number
}

export interface DriveViewDeps {
  views: { useViewPick(member: Member, fileId: unknown): Promise<Outcome<DriveViewUse>> }
  google: Pick<GoogleClient, 'request' | 'streamMedia'>
  clock: Clock
  /** Read per use (lib/config.ts `driveViewLimits`). */
  limits(): DriveViewLimits
  /** The caps' day of a moment (the key broker's). */
  dayOf(ms: number): string
  /** Bytes served today, in the company and by the member; `add` with a negative number gives bytes back. */
  usage: {
    used(companyId: string, userId: string, day: string): { company: number; member: number }
    add(companyId: string, userId: string, day: string, bytes: number, requests: number): void
  }
  /** One line per viewing session, when it ends (never a file id or name). */
  record(companyId: string, userId: string, e: { bytes: number; answers: number; failed: number; lastStatus: number | null; durationMs: number }): void
}

/** What the route answers. */
export type DriveViewAnswer =
  | { kind: 'refused'; refusal: Refusal }
  /** 416: `size` known → `Content-Range: bytes *\/<size>`. */
  | { kind: 'unsatisfiable'; size: number | null; refusal: Refusal }
  | { kind: 'stream'; status: 200 | 206; headers: Record<string, string>; body: ReadableStream<Uint8Array> }

type ParsedRange = { kind: 'none' } | { kind: 'range'; start: number; end: number | null } | { kind: 'bad' }

/** The Range header: absent, one `bytes=a-b` / `bytes=a-`, or anything else (several ranges, a suffix, another unit). */
export function parseViewRange(header: string | null | undefined): ParsedRange {
  if (header === null || header === undefined) return { kind: 'none' }
  const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header.trim())
  if (!m) return { kind: 'bad' }
  const start = Number(m[1])
  const end = m[2] === '' ? null : Number(m[2])
  if (end !== null && end < start) return { kind: 'bad' }
  return { kind: 'range', start, end }
}

const RANGE_UNSUPPORTED = '動画の読み方（Range）が対応していない形です。アプリを新しくしてから、もう一度再生してください。'
const RANGE_NEEDED = 'この動画は大きいため、少しずつ読み込む再生のしかたでだけ再生できます。アプリを新しくしてから、もう一度再生してください。'
const RANGE_OUTSIDE = '動画の終わりより先を読もうとしました。もう一度再生してください。'
const TOO_FAST = '動画の読み込みが短い時間に多すぎます。少し待ってから、もう一度再生してください。'
const TOO_MANY = '動画を同時に読み込みすぎています。ほかの動画を止めてから、もう一度再生してください。'
const MEMBER_DAY = '今日あなたが再生できる動画の量の上限に達しました。明日になるとまた再生できます。'
const COMPANY_DAY = '今日この会社で再生できる動画の量の上限に達しました。明日になるとまた再生できます（上限は管理者に相談してください）。'
const NOT_VIDEO = 'Google Drive で、この動画が動画として開けなくなっています（消されたか、種類が変わりました）。資料の作成者に確かめてください。'
const NO_ACCESS = 'Google Drive でこの動画を開けませんでした（消されたか、見られる人が変わった可能性があります）。'
const UPSTREAM = 'Google Drive から動画を受け取れませんでした。少し待ってから、もう一度再生してください。'
const STOPPED = 'この会社では、いま Google につなげません（止められているか、まだ設定されていません）。'
const NO_CONSENT = 'Google Drive を使う許可が変わりました。アプリの「設定」→「Google」で許可を確かめてから、もう一度再生してください。'
const FEATURE_OFF = '「Drive で選んだものを読む・置く」をオフにしています。アプリの「設定」→「Google」の「Drive で選んだものを読む・置く」で［オンにする］を押してください。'

/** Google's answer to the metadata: type (from ACB's list) and size, or why the video cannot be played. */
interface SessionMeta { contentType: string; size: number }

interface Session {
  companyId: string
  userId: string
  openedAtMs: number
  lastAtMs: number
  bytes: number
  answers: number
  failed: number
  lastStatus: number | null
  /** Read once per session (shared by answers asked at the same time); dropped after a refusal so the next asks again. */
  meta: Promise<Outcome<SessionMeta>> | null
}

const MAX_SESSIONS = 10_000

export function createDriveViewService(deps: DriveViewDeps) {
  const { clock } = deps
  /** company|user|file → the viewing session. */
  const sessions = new Map<string, Session>()
  /** company|user → request times in the last minute. */
  const recent = new Map<string, number[]>()
  /** company|user → answers being streamed now. */
  const open = new Map<string, number>()

  const memberKey = (m: Member) => `${m.companyId}|${m.userId}`

  function closeSession(key: string, s: Session): void {
    sessions.delete(key)
    try {
      deps.record(s.companyId, s.userId, { bytes: s.bytes, answers: s.answers, failed: s.failed, lastStatus: s.lastStatus, durationMs: Math.min(Math.max(0, s.lastAtMs - s.openedAtMs), 7 * 24 * 60 * 60 * 1000) })
    } catch {
      console.warn('[google-drive] a viewing session could not be recorded')
    }
  }

  /** Ends every session idle for `sessionIdleMs` (one company, or all). */
  function sweepSessions(companyId: string | null): void {
    const idle = deps.limits().sessionIdleMs
    const now = clock.nowMs()
    for (const [key, s] of [...sessions]) {
      if ((companyId === null || s.companyId === companyId) && now - s.lastAtMs >= idle) closeSession(key, s)
    }
  }

  function sessionFor(member: Member, fileId: string): Session {
    const key = `${memberKey(member)}|${fileId}`
    const now = clock.nowMs()
    const found = sessions.get(key)
    if (found && now - found.lastAtMs < deps.limits().sessionIdleMs) return found
    if (found) closeSession(key, found)
    if (sessions.size >= MAX_SESSIONS) {
      const [oldestKey, oldest] = [...sessions].reduce((a, b) => (b[1].lastAtMs < a[1].lastAtMs ? b : a))
      closeSession(oldestKey, oldest)
    }
    const s: Session = { companyId: member.companyId, userId: member.userId, openedAtMs: now, lastAtMs: now, bytes: 0, answers: 0, failed: 0, lastStatus: null, meta: null }
    sessions.set(key, s)
    return s
  }

  /** A refusal of the Google client as the viewer's answer (a fixed sentence, never Google's text or the file's name). */
  function googleRefusal(r: { kind: string; reason: string; status?: number }): Refusal {
    if (r.kind === 'not-sent') {
      switch (r.reason) {
        case 'feature-off': return refuse('conflict', FEATURE_OFF, { code: 'GOOGLE_FEATURE_OFF', feature: 'drive' })
        case 'no-grant': case 'grant-revoked': case 'grant-stopped': case 'scope-not-granted': case 'token-refused': case 'grant-changed':
          return refuse('conflict', NO_CONSENT, { code: 'GOOGLE_CONSENT_NEEDED', needsGoogleConsent: 'drive' })
        case 'operator-stopped': case 'not-configured': case 'off': case 'vault-off': case 'not-member': case 'practice-real-secret':
          return refuse('forbidden', STOPPED, { code: 'GOOGLE_STOPPED' })
        default: return refuse('unavailable', UPSTREAM, { code: 'DRIVE_VIEW_UPSTREAM' })
      }
    }
    if (r.kind === 'refused' && (r.status === 403 || r.status === 404)) return refuse('forbidden', NO_ACCESS, { code: 'DRIVE_VIEW_NO_ACCESS' })
    return refuse('unavailable', UPSTREAM, { code: 'DRIVE_VIEW_UPSTREAM' })
  }

  async function readMeta(member: Member, fileId: string): Promise<Outcome<SessionMeta>> {
    const r = await deps.google.request(member.companyId, member.userId, {
      api: 'drive', method: 'GET', path: `/drive/v3/files/${fileId}`,
      query: { fields: 'id,mimeType,size,trashed', supportsAllDrives: 'true' },
      scope: GOOGLE_SCOPE.driveFile, operation: 'drive.view.meta',
      // The session's one line is the record (this client would add one per call).
      recordedByCaller: true,
    })
    if (!r.ok) return googleRefusal(r)
    const j = (r.json && typeof r.json === 'object' ? r.json : {}) as Record<string, unknown>
    if (j.id !== fileId || j.trashed === true) return refuse('forbidden', NO_ACCESS, { code: 'DRIVE_VIEW_NO_ACCESS' })
    // ACB's own fixed list decides the type sent to the viewer: Google's string is only matched against it, never sent.
    const contentType = DRIVE_VIEW_MIMES.find(m => m === j.mimeType)
    if (!contentType) return refuse('forbidden', NOT_VIDEO, { code: 'DRIVE_VIEW_NOT_VIDEO' })
    const size = typeof j.size === 'string' && /^\d{1,15}$/.test(j.size) ? Number(j.size) : NaN
    if (!Number.isSafeInteger(size)) return refuse('unavailable', UPSTREAM, { code: 'DRIVE_VIEW_UPSTREAM' })
    return ok({ contentType, size })
  }

  return {
    /**
     * GET …/me/google/drive/view/:fileId (session only): one range of the member's picked video. `signal` is the
     * viewer's request: when it is aborted the call to Google is aborted too.
     */
    async open(member: Member, fileId: unknown, rangeHeader: string | null | undefined, signal: AbortSignal): Promise<DriveViewAnswer> {
      const refused = (refusal: Refusal): DriveViewAnswer => ({ kind: 'refused', refusal })
      // 1. The view pick (and every switch it checks); renewed by this use.
      const use = await deps.views.useViewPick(member, fileId)
      if (!use.ok) return refused(use)
      const id = use.value.fileId
      // 2. The Range header's form (nothing counted yet).
      const range = parseViewRange(rangeHeader)
      if (range.kind === 'bad') return { kind: 'unsatisfiable', size: null, refusal: refuse('bad-request', RANGE_UNSUPPORTED, { code: 'DRIVE_VIEW_RANGE_UNSUPPORTED' }) }

      // 3. The caps, in one synchronous stretch with taking the stream slot (no await from here to the slot).
      sweepSessions(null)
      const limits = deps.limits()
      const nowMs = clock.nowMs()
      const mk = memberKey(member)
      const times = (recent.get(mk) ?? []).filter(t => nowMs - t < 60_000)
      if (times.length >= limits.memberPerMinute) {
        recent.set(mk, times)
        return refused(refuse('rate-limited', TOO_FAST, { code: 'DRIVE_VIEW_TOO_FAST', retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (nowMs - times[0])) / 1000)) }))
      }
      times.push(nowMs)
      recent.set(mk, times)
      if ((open.get(mk) ?? 0) >= limits.memberStreams) return refused(refuse('rate-limited', TOO_MANY, { code: 'DRIVE_VIEW_TOO_MANY_STREAMS', retryAfterSeconds: 5 }))
      const day = deps.dayOf(nowMs)
      const before = deps.usage.used(member.companyId, member.userId, day)
      if (before.member >= limits.memberDayBytes) return refused(refuse('rate-limited', MEMBER_DAY, { code: 'DRIVE_VIEW_MEMBER_DAY', retryAfterSeconds: 3600 }))
      if (before.company >= limits.companyDayBytes) return refused(refuse('rate-limited', COMPANY_DAY, { code: 'DRIVE_VIEW_COMPANY_DAY', retryAfterSeconds: 3600 }))
      open.set(mk, (open.get(mk) ?? 0) + 1)

      // From here the slot is held: every way out releases it exactly once (`release`), also on an exception.
      let released = false
      const release = () => {
        if (released) return
        released = true
        const n = (open.get(mk) ?? 1) - 1
        if (n <= 0) open.delete(mk)
        else open.set(mk, n)
      }
      const session = sessionFor(member, id)
      session.lastAtMs = nowMs
      let reserved = 0
      const giveBack = (bytes: number) => { if (bytes > 0) deps.usage.add(member.companyId, member.userId, day, -bytes, 0) }
      try {
        // 4. Type and size, once per session.
        if (!session.meta) session.meta = readMeta(member, id)
        const meta = await session.meta
        if (!meta.ok) {
          session.meta = null
          session.failed++
          release()
          return refused(meta)
        }
        const { contentType, size } = meta.value

        // 5. Which bytes: at most `chunkBytes`, within the file.
        let start: number
        let end: number
        let status: 200 | 206
        if (range.kind === 'none') {
          if (size > limits.chunkBytes) {
            release()
            return { kind: 'unsatisfiable', size, refusal: refuse('bad-request', RANGE_NEEDED, { code: 'DRIVE_VIEW_RANGE_NEEDED' }) }
          }
          start = 0
          end = size - 1
          status = 200
        } else {
          if (range.start >= size) {
            release()
            return { kind: 'unsatisfiable', size, refusal: refuse('bad-request', RANGE_OUTSIDE, { code: 'DRIVE_VIEW_RANGE_OUTSIDE' }) }
          }
          start = range.start
          end = Math.min(range.end ?? size - 1, size - 1, start + limits.chunkBytes - 1)
          status = 206
        }
        if (size === 0) {
          release()
          session.answers++
          session.lastStatus = 200
          return { kind: 'stream', status: 200, headers: viewHeaders(contentType, 0, null), body: new ReadableStream({ start(c) { c.close() } }) }
        }
        // The bytes reserved now (read again: other answers may have reserved since step 3), so the day's caps hold
        // even for answers streaming at the same time; a range is shortened to what is left (a shorter 206 is valid).
        const now = deps.usage.used(member.companyId, member.userId, day)
        const left = Math.min(limits.memberDayBytes - now.member, limits.companyDayBytes - now.company)
        if (left <= 0 || (status === 200 && end - start + 1 > left)) {
          release()
          const memberOut = limits.memberDayBytes - now.member <= limits.companyDayBytes - now.company
          return refused(refuse('rate-limited', memberOut ? MEMBER_DAY : COMPANY_DAY, { code: memberOut ? 'DRIVE_VIEW_MEMBER_DAY' : 'DRIVE_VIEW_COMPANY_DAY', retryAfterSeconds: 3600 }))
        }
        end = Math.min(end, start + left - 1)
        const length = end - start + 1
        deps.usage.add(member.companyId, member.userId, day, length, 1)
        reserved = length

        // 6. The bytes from Google, under the grant step 1 saw.
        const media = await deps.google.streamMedia(member.companyId, member.userId, { fileId: id, start, end, grantId: use.value.grantId, signal, operation: 'drive.view.media' })
        if (!media.ok) {
          giveBack(reserved)
          reserved = 0
          session.failed++
          session.lastStatus = media.status ?? null
          if (media.kind === 'refused') session.meta = null
          release()
          return refused(googleRefusal(media))
        }
        // Google must answer exactly what was asked (a 200 only when the whole file was asked).
        const wholeFile = start === 0 && end === size - 1
        const rangeOk = media.status === 206 ? media.contentRange === `bytes ${start}-${end}/${size}` : wholeFile
        if (!rangeOk || (media.contentLength !== null && media.contentLength !== length)) {
          media.abort()
          giveBack(reserved)
          reserved = 0
          session.meta = null
          session.failed++
          session.lastStatus = media.status
          release()
          return refused(refuse('unavailable', UPSTREAM, { code: 'DRIVE_VIEW_UPSTREAM' }))
        }

        // The answer: exactly `length` bytes at most, passed on as they arrive; it ends once.
        let delivered = 0
        let ended = false
        const finish = (okEnd: boolean) => {
          if (ended) return
          ended = true
          media.abort()
          giveBack(reserved - delivered)
          reserved = 0
          session.bytes += delivered
          session.answers++
          if (!okEnd) session.failed++
          session.lastStatus = status
          session.lastAtMs = clock.nowMs()
          release()
        }
        signal.addEventListener('abort', () => finish(false), { once: true })
        const iterator = media.body[Symbol.asyncIterator]()
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next()
              if (ended) return
              if (next.done) {
                finish(delivered === length)
                controller.close()
                return
              }
              const room = length - delivered
              const part = next.value.byteLength > room ? next.value.subarray(0, room) : next.value
              delivered += part.byteLength
              controller.enqueue(part)
              if (delivered >= length) {
                finish(true)
                controller.close()
              }
            } catch {
              finish(false)
              try { controller.error(new Error('the video stream ended')) } catch { /* already closed */ }
            }
          },
          cancel() {
            // The viewer left (the connection closed): Google's call is aborted with it.
            finish(false)
          },
        })
        return { kind: 'stream', status, headers: viewHeaders(contentType, length, status === 206 ? `bytes ${start}-${end}/${size}` : null), body }
      } catch (error) {
        giveBack(reserved)
        session.meta = null
        release()
        throw error
      }
    },

    /** The server clock's pass (google-drive.md): every viewing session of the company idle long enough files its line. */
    sweep(companyId: string): void {
      sweepSessions(companyId)
    },

    /** For tests: how many answers are streaming for the member now. */
    openStreams(companyId: string, userId: string): number {
      return open.get(`${companyId}|${userId}`) ?? 0
    },
  }
}

function viewHeaders(contentType: string, length: number, contentRange: string | null): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    ...(contentRange ? { 'Content-Range': contentRange } : {}),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  }
}

export type DriveViewService = ReturnType<typeof createDriveViewService>

/**
 * Streaming a picked Drive video to the member's own player (google-drive.md "Streaming a picked video"; the model of
 * its authorization and lifecycle: model/drive-view/). Part of the Google connector's module.
 *
 * One request = one answer of at most `chunkBytes` (a shorter 206 is valid): the player asks range by range, so every
 * range is authorized again. In order, nothing sent to Google before the last:
 *   1. the member's requests per minute (memory only: a flood writes nothing, not even the pick's renewal);
 *   2. the view pick (`googleDrive.useViewPick`: operator stop, company Google and its Drive switch, the member's grant
 *      with `drive.file` and Drive on, a live view pick of this file by this member under the account the grant has
 *      now; renews it) — its refusal is answered as is;
 *   3. the Range header's form (one `bytes=a-b` or `bytes=a-`; anything else 416 before anything is counted);
 *   4. the caps, in one synchronous stretch with taking the stream slot (answers streaming at once, the member's and the
 *      company's bytes today): over one → 429, nothing asked of Google; every cap refusal is counted (`refused`);
 *   5. the session's metadata (type and size, read once per viewing session and grant, not per range);
 *   6. the bytes reserved before the call, the day's counts read again after the await (so concurrent answers can never
 *      pass the caps together), the unsent part given back when the answer ends;
 *   7. `googleClient.streamMedia` under the grant step 2 saw (a re-consent meanwhile sends nothing).
 * An answer ends exactly once (finished, the viewer gone, Google failing, its own deadline): its stream slot is released
 * and its unsent bytes given back then — the deadline does not wait for the viewer to read. A viewing session (member ×
 * file, until `sessionIdleMs` without a request) files one AI-action-log line when it ends, with the bytes served;
 * nothing per range. No file id or name is logged or recorded.
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
  answerMs: number
}

export interface DriveViewDeps {
  views: { useViewPick(member: Member, fileId: unknown): Promise<Outcome<DriveViewUse>> }
  google: Pick<GoogleClient, 'request' | 'streamMedia'>
  clock: Clock
  /** Read per use (lib/config.ts `driveViewLimits`). */
  limits(): DriveViewLimits
  /** The caps' day of a moment (the key broker's). */
  dayOf(ms: number): string
  /**
   * Bytes served today, in the company and by the member; `add` with a negative number gives bytes back. `refused` counts
   * a request a cap refused (how many only).
   */
  usage: {
    used(companyId: string, userId: string, day: string): { company: number; member: number }
    add(companyId: string, userId: string, day: string, bytes: number, requests: number): void
    refused(companyId: string, userId: string, day: string): void
  }
  /**
   * One line per viewing session, when it ends (never a file id or name). `failed`: answers Google or the deadline
   * ended; `viewerLeft`: answers the viewer ended first (a seek, the player closed) — normal, not a failure.
   */
  record(companyId: string, userId: string, e: { bytes: number; answers: number; failed: number; viewerLeft: number; lastStatus: number | null; durationMs: number }): void
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
  viewerLeft: number
  lastStatus: number | null
  /** Answers of this session still streaming: a session is never ended (nor its line filed) while one is. */
  inFlight: number
  /**
   * Read once per session and grant (shared by answers asked at the same time); read again for another grant (a
   * re-consent, maybe another Google account) and after a refusal.
   */
  meta: { grantId: string; value: Promise<Outcome<SessionMeta>> } | null
}

const MAX_SESSIONS = 10_000
const MINUTE_MS = 60_000

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
      deps.record(s.companyId, s.userId, {
        bytes: s.bytes, answers: s.answers, failed: s.failed, viewerLeft: s.viewerLeft, lastStatus: s.lastStatus,
        durationMs: Math.min(Math.max(0, s.lastAtMs - s.openedAtMs), 7 * 24 * 60 * 60 * 1000),
      })
    } catch {
      console.warn('[google-drive] a viewing session could not be recorded')
    }
  }

  /** Ends every session of the company idle for `sessionIdleMs` with no answer streaming, and forgets old minutes. */
  function sweepCompany(companyId: string): void {
    const idle = deps.limits().sessionIdleMs
    const now = clock.nowMs()
    for (const [key, s] of [...sessions]) {
      if (s.companyId === companyId && s.inFlight === 0 && now - s.lastAtMs >= idle) closeSession(key, s)
    }
    for (const [key, times] of [...recent]) {
      if (key.startsWith(`${companyId}|`) && times.every(t => now - t >= MINUTE_MS)) recent.delete(key)
    }
  }

  function sessionFor(member: Member, fileId: string): Session {
    const key = `${memberKey(member)}|${fileId}`
    const now = clock.nowMs()
    const found = sessions.get(key)
    // A session with an answer still streaming goes on (its bytes are never lost to a new one).
    if (found && (found.inFlight > 0 || now - found.lastAtMs < deps.limits().sessionIdleMs)) return found
    if (found) closeSession(key, found)
    if (sessions.size >= MAX_SESSIONS) {
      // The oldest session with nothing streaming ends first; if every one streams, the bound is passed for a while.
      let oldest: [string, Session] | null = null
      for (const entry of sessions) if (entry[1].inFlight === 0 && (!oldest || entry[1].lastAtMs < oldest[1].lastAtMs)) oldest = entry
      if (oldest) closeSession(oldest[0], oldest[1])
    }
    const s: Session = { companyId: member.companyId, userId: member.userId, openedAtMs: now, lastAtMs: now, bytes: 0, answers: 0, failed: 0, viewerLeft: 0, lastStatus: null, inFlight: 0, meta: null }
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
      const mk = memberKey(member)
      const capRefused = (refusal: Refusal): DriveViewAnswer => {
        deps.usage.refused(member.companyId, member.userId, deps.dayOf(clock.nowMs()))
        return refused(refusal)
      }

      // 1. The member's requests per minute: memory only, before anything is read or written.
      const limits0 = deps.limits()
      const t0 = clock.nowMs()
      const times = (recent.get(mk) ?? []).filter(t => t0 - t < MINUTE_MS)
      if (times.length >= limits0.memberPerMinute) {
        recent.set(mk, times)
        return capRefused(refuse('rate-limited', TOO_FAST, { code: 'DRIVE_VIEW_TOO_FAST', retryAfterSeconds: Math.max(1, Math.ceil((MINUTE_MS - (t0 - times[0])) / 1000)) }))
      }
      times.push(t0)
      recent.set(mk, times)

      // 2. The view pick (and every switch it checks); renewed by this use.
      const use = await deps.views.useViewPick(member, fileId)
      if (!use.ok) return refused(use)
      const id = use.value.fileId
      // 3. The Range header's form (nothing counted yet).
      const range = parseViewRange(rangeHeader)
      if (range.kind === 'bad') return { kind: 'unsatisfiable', size: null, refusal: refuse('bad-request', RANGE_UNSUPPORTED, { code: 'DRIVE_VIEW_RANGE_UNSUPPORTED' }) }

      // 4. The caps, in one synchronous stretch with taking the slot (no await from here to the slot).
      sweepCompany(member.companyId)
      const limits = deps.limits()
      const nowMs = clock.nowMs()
      if ((open.get(mk) ?? 0) >= limits.memberStreams) return capRefused(refuse('rate-limited', TOO_MANY, { code: 'DRIVE_VIEW_TOO_MANY_STREAMS', retryAfterSeconds: 5 }))
      const day = deps.dayOf(nowMs)
      const before = deps.usage.used(member.companyId, member.userId, day)
      if (before.member >= limits.memberDayBytes) return capRefused(refuse('rate-limited', MEMBER_DAY, { code: 'DRIVE_VIEW_MEMBER_DAY', retryAfterSeconds: 3600 }))
      if (before.company >= limits.companyDayBytes) return capRefused(refuse('rate-limited', COMPANY_DAY, { code: 'DRIVE_VIEW_COMPANY_DAY', retryAfterSeconds: 3600 }))
      open.set(mk, (open.get(mk) ?? 0) + 1)
      const session = sessionFor(member, id)
      session.lastAtMs = nowMs
      session.inFlight++

      // From here the slot is held: every way out ends it exactly once (`end`), also on an exception.
      let ended = false
      let reserved = 0
      let delivered = 0
      const end = (how: 'refused' | 'ok' | 'viewer' | 'failed') => {
        if (ended) return
        ended = true
        if (reserved - delivered > 0) deps.usage.add(member.companyId, member.userId, day, -(reserved - delivered), 0)
        reserved = delivered
        session.bytes += delivered
        if (how !== 'refused') session.answers++
        if (how === 'failed') session.failed++
        if (how === 'viewer') session.viewerLeft++
        session.inFlight--
        session.lastAtMs = clock.nowMs()
        const n = (open.get(mk) ?? 1) - 1
        if (n <= 0) open.delete(mk)
        else open.set(mk, n)
      }
      try {
        // 5. Type and size, once per session and grant.
        if (!session.meta || session.meta.grantId !== use.value.grantId) session.meta = { grantId: use.value.grantId, value: readMeta(member, id) }
        const metaPromise = session.meta
        const meta = await metaPromise.value
        if (!meta.ok) {
          if (session.meta === metaPromise) session.meta = null
          session.failed++
          end('refused')
          return refused(meta)
        }
        const { contentType, size } = meta.value

        // 6. Which bytes: at most `chunkBytes`, within the file.
        let start: number
        let last: number
        let status: 200 | 206
        if (range.kind === 'none') {
          if (size > limits.chunkBytes) {
            end('refused')
            return { kind: 'unsatisfiable', size, refusal: refuse('bad-request', RANGE_NEEDED, { code: 'DRIVE_VIEW_RANGE_NEEDED' }) }
          }
          start = 0
          last = size - 1
          status = 200
        } else {
          if (range.start >= size) {
            end('refused')
            return { kind: 'unsatisfiable', size, refusal: refuse('bad-request', RANGE_OUTSIDE, { code: 'DRIVE_VIEW_RANGE_OUTSIDE' }) }
          }
          start = range.start
          last = Math.min(range.end ?? size - 1, size - 1, start + limits.chunkBytes - 1)
          status = 206
        }
        if (size === 0) {
          end('ok')
          session.lastStatus = 200
          return { kind: 'stream', status: 200, headers: viewHeaders(contentType, 0, null), body: new ReadableStream({ start(c) { c.close() } }) }
        }
        // The bytes reserved now, the day's counts read again (other answers may have reserved while the metadata was
        // awaited), so the caps hold even for answers streaming at the same time; a range is cut to what is left.
        const now = deps.usage.used(member.companyId, member.userId, day)
        const left = Math.min(limits.memberDayBytes - now.member, limits.companyDayBytes - now.company)
        if (left <= 0 || (status === 200 && last - start + 1 > left)) {
          end('refused')
          const memberOut = limits.memberDayBytes - now.member <= limits.companyDayBytes - now.company
          return capRefused(refuse('rate-limited', memberOut ? MEMBER_DAY : COMPANY_DAY, { code: memberOut ? 'DRIVE_VIEW_MEMBER_DAY' : 'DRIVE_VIEW_COMPANY_DAY', retryAfterSeconds: 3600 }))
        }
        last = Math.min(last, start + left - 1)
        const length = last - start + 1
        deps.usage.add(member.companyId, member.userId, day, length, 1)
        reserved = length

        // 7. The bytes from Google, under the grant step 2 saw.
        const media = await deps.google.streamMedia(member.companyId, member.userId, { fileId: id, start, end: last, grantId: use.value.grantId, signal, operation: 'drive.view.media' })
        if (!media.ok) {
          session.lastStatus = media.status ?? null
          if (media.kind === 'refused') session.meta = null
          end(media.reason === 'aborted' ? 'viewer' : 'failed')
          return refused(googleRefusal(media))
        }
        // Google must answer exactly what was asked (a 200 only when the whole file was asked).
        const wholeFile = start === 0 && last === size - 1
        const rangeOk = media.status === 206 ? media.contentRange === `bytes ${start}-${last}/${size}` : wholeFile
        if (!rangeOk || (media.contentLength !== null && media.contentLength !== length)) {
          media.abort()
          session.meta = null
          session.lastStatus = media.status
          end('failed')
          return refused(refuse('unavailable', UPSTREAM, { code: 'DRIVE_VIEW_UPSTREAM' }))
        }
        session.lastStatus = status

        // The answer: exactly `length` bytes, passed on as they arrive. It ends once: the last byte, the viewer gone,
        // Google failing or ending short, or its own deadline — which does not wait for the viewer to read.
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
        const fail = (how: 'viewer' | 'failed') => {
          if (ended) return
          clearTimeout(deadline)
          media.abort()
          end(how)
          if (how === 'failed') {
            // An answer cut short must not look complete: the stream errors, so the connection is destroyed (the
            // viewer sees fewer bytes than Content-Length, never a clean end).
            try { controllerRef?.error(new Error('the video answer ended early')) } catch { /* already closed */ }
          }
        }
        const deadline = setTimeout(() => fail('failed'), limits.answerMs)
        deadline.unref?.()
        signal.addEventListener('abort', () => fail('viewer'), { once: true })
        const iterator = media.body[Symbol.asyncIterator]()
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controllerRef = controller },
          async pull(controller) {
            try {
              const next = await iterator.next()
              if (ended) return
              if (next.done) {
                // Google ended before the promised length (a chunked answer cut short): an error, never a clean end.
                if (delivered < length) fail('failed')
                else { clearTimeout(deadline); media.abort(); end('ok'); controller.close() }
                return
              }
              const room = length - delivered
              const part = next.value.byteLength > room ? next.value.subarray(0, room) : next.value
              delivered += part.byteLength
              controller.enqueue(part)
              if (delivered >= length) {
                clearTimeout(deadline)
                media.abort()
                end('ok')
                controller.close()
              }
            } catch {
              fail('failed')
            }
          },
          cancel() {
            // The viewer left (the connection closed): Google's call is aborted with it.
            fail('viewer')
          },
        })
        return { kind: 'stream', status, headers: viewHeaders(contentType, length, status === 206 ? `bytes ${start}-${last}/${size}` : null), body }
      } catch (error) {
        session.meta = null
        end('failed')
        throw error
      }
    },

    /**
     * The server clock's pass (google-drive.md): every viewing session of the company idle long enough (and with no
     * answer streaming) files its line; old per-minute counts are forgotten.
     */
    sweep(companyId: string): void {
      sweepCompany(companyId)
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

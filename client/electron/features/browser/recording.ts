// 「ブラウザ操作」 の記録 in the app (agent-browser.md "Recording"): the member presses 「記録する」 on a site in Settings, does
// the work once in the site's window, stops, looks through the lines (deleting what they do not want) and sends it to the
// company. No Electron: the window comes in as the controller's `recordWindow` (the shell's debugger owner observes; this
// module never attaches or detaches anything), the server as `BrowserRecordingsHttp`.
//
// - One recording per member and company, in main's memory only (never on disk); sign-out, the window closing, the
//   connection lost or a start that fails discard it. Nothing is sent until the person presses ［送る］.
// - What it holds is the core's kept form from the first observation on (client/shared/browser-recorder.ts): each value
//   becomes a symbol through a keyed hash whose key is made fresh for this recording (`newDigest`), so symbols of two
//   recordings have nothing to do with each other and no value is held.
// - Starting needs what the server will ask when it is sent: the site in the member's current policy (the controller) and
//   this PC allowed to use 「ブラウザ操作」 (`mayRecord`: an enabled registration, or the owner's opt-in) — the server
//   decides again on ［送る］. A recording and the AI's operation never run together: the window's debugger owner refuses
//   to start one while the other holds it (browser-window.ts).
// - This PC's key goes only on the send (`X-ACB-Browser-Device`, the server's gate), never on the other calls.
import { createHmac, randomBytes } from 'node:crypto'
import { BROWSER_DEVICE_HEADER } from '../../../../shared/core/browser-device'
import { browserRecordingLine, browserRecordingWithout, type BrowserRecordingContent } from '../../../../shared/core/browser-recording'
import {
  createBrowserRecorder,
  type BrowserRecorder, type BrowserRecordingResult, type BrowserRecordingView, type BrowserRecordSurface,
} from '../../../shared/browser-recorder'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import type { BrowserActionResult } from '../../../shared/browser-operation'

/** Main's sentences for the member (the screen's own words are `BROWSER_RECORDING_APP_WORDS`). */
export const BROWSER_RECORDING_MAIN_WORDS = {
  sent: '記録を送りました。管理者に「記録を送りました」と伝えてください。',
  discarded: '記録を捨てました。',
  closed: 'サイトの窓を閉じたので、記録を捨てました。',
  lost: 'サイトの窓とのつながりが切れたので、記録を捨てました。',
  cannotStart: '記録を始められませんでした。AI がこの窓を使っているときは記録できません。もう一度お試しください。',
  empty: '記録する行がなかったので、記録を捨てました。',
  noPc: '記録するには、この PC を使えるようにしてもらう必要があります（下の「この PC」）。',
  notAllowed: 'このサイトは、いまは記録できません。会社の設定が変わった可能性があります。',
  busy: 'ほかのサイトを記録中です。先にそちらを止めてください。',
  sendFailed: '送れませんでした。時間をおいて、もう一度［送る］を押してください。',
  refused: (reason: string) => `送れませんでした（${reason}）。`,
  notMainWindow: 'この画面からは操作できません。',
}
const W = BROWSER_RECORDING_MAIN_WORDS

/** The server's answer to a send. */
export type BrowserRecordingSendAnswer = { kind: 'ok' } | { kind: 'refused'; message: string | null } | { kind: 'no-answer' }

export interface BrowserRecordingsHttpDeps {
  baseUrl: () => string
  cookies: () => string[]
  /** This PC's key header value (device.ts), or null when this PC has none. */
  deviceKey: () => string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

/** `POST /browser-recordings { domain, content }` with the member's session and this PC's key header. */
export function createBrowserRecordingsHttp(deps: BrowserRecordingsHttpDeps) {
  const doFetch = deps.fetch ?? fetch
  return {
    async send(companyId: string, body: { domain: string; content: BrowserRecordingContent }): Promise<BrowserRecordingSendAnswer> {
      const base = deps.baseUrl().replace(/\/+$/, '')
      const cookies = deps.cookies()
      if (!base || cookies.length === 0 || !BROWSER_COMPANY_ID_RE.test(companyId)) return { kind: 'no-answer' }
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Cookie: cookies.join('; ') }
      const key = deps.deviceKey()
      if (key) headers[BROWSER_DEVICE_HEADER] = key
      try {
        const res = await doFetch(`${base}/api/companies/${companyId}/browser-recordings`, {
          method: 'POST', redirect: 'error', cache: 'no-store', headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        })
        const json = await res.json().catch(() => null) as Record<string, unknown> | null
        if (res.status >= 200 && res.status < 300) return { kind: 'ok' }
        // The server's sentence is plain Japanese for the member; anything else is not shown.
        if (res.status >= 400 && res.status < 500) return { kind: 'refused', message: typeof json?.error === 'string' && json.error.length <= 200 ? json.error : null }
        return { kind: 'no-answer' }
      } catch {
        return { kind: 'no-answer' }
      }
    },
  }
}
export type BrowserRecordingsHttp = ReturnType<typeof createBrowserRecordingsHttp>

export interface BrowserRecordingsDeps {
  /** The member's windows (the controller): open a site of the current policy, and its window as a recording observes it. */
  windows: {
    open(companyId: string, host: string): BrowserActionResult
    recordWindow(companyId: string, host: string): BrowserRecordSurface | null
  }
  userId: () => string | null
  /** This PC may use 「ブラウザ操作」 (an enabled registration, or the owner's opt-in): main composes the switch. */
  mayRecord: () => boolean
  api: Pick<BrowserRecordingsHttp, 'send'>
  /** A keyed hash with a fresh random key (one per recording). */
  newDigest?: () => (value: string) => string
  now?: () => number
  /** The member's recording in this company changed by itself (the window closed): the screen asks again. */
  changed: (companyId: string) => void
}

interface Session {
  userId: string
  companyId: string
  host: string
  phase: 'starting' | 'recording' | 'review'
  recorder: BrowserRecorder
  surface: BrowserRecordSurface | null
  content: BrowserRecordingContent | null
  message: string | null
  sending: boolean
}

/** HMAC-SHA256 under 32 random bytes made now: only this recording's symbols come from it. */
export function newRecordingDigest(): (value: string) => string {
  const key = randomBytes(32)
  return value => createHmac('sha256', key).update(value, 'utf8').digest('base64url')
}

export function createBrowserRecordings(deps: BrowserRecordingsDeps) {
  const now = deps.now ?? Date.now
  const newDigest = deps.newDigest ?? newRecordingDigest
  const sessions = new Map<string, Session>()
  /** A message for the member's next look (a recording discarded by itself). */
  const notes = new Map<string, string>()
  const keyOf = (userId: string, companyId: string) => `${userId}\0${companyId}`
  const current = (companyId: string): Session | null => {
    const user = deps.userId()
    return user ? sessions.get(keyOf(user, companyId)) ?? null : null
  }
  const discard = (s: Session, note: string | null) => {
    if (sessions.get(keyOf(s.userId, s.companyId)) === s) sessions.delete(keyOf(s.userId, s.companyId))
    if (note) notes.set(keyOf(s.userId, s.companyId), note)
    void s.surface?.stop().catch(() => {})
  }

  function view(companyId: string): BrowserRecordingView {
    const user = deps.userId()
    const s = current(companyId)
    if (!s || !user) {
      const message = user ? notes.get(keyOf(user, companyId)) ?? null : null
      return { state: 'none', message }
    }
    if (s.phase !== 'review' || !s.content) return { state: 'recording', host: s.host, lines: s.recorder.lines(), full: s.recorder.full() }
    return {
      state: 'review', host: s.host, full: s.recorder.full(), message: s.message,
      lines: s.content.steps.map(step => ({ id: step.id, ...browserRecordingLine(step) })),
    }
  }
  const answer = (companyId: string): BrowserRecordingResult => ({ ok: true, view: view(companyId) })

  return {
    view,

    /** 「記録する」: open (or bring up) the site's window and observe it; anything that fails discards the recording. */
    async start(companyId: string, host: string): Promise<BrowserRecordingResult> {
      const user = deps.userId()
      if (!user) return { ok: false, message: W.notAllowed }
      if (current(companyId)) return { ok: false, message: W.busy }
      if (!deps.mayRecord()) return { ok: false, message: W.noPc }
      const opened = deps.windows.open(companyId, host)
      if (!opened.ok) return { ok: false, message: opened.message }
      const surface = deps.windows.recordWindow(companyId, host)
      if (!surface) return { ok: false, message: W.notAllowed }
      notes.delete(keyOf(user, companyId))
      const s: Session = {
        userId: user, companyId, host, phase: 'starting', surface, content: null, message: null, sending: false,
        recorder: createBrowserRecorder({ domain: host, digest: newDigest(), now }),
      }
      sessions.set(keyOf(user, companyId), s)
      let ok = false
      try {
        ok = await surface.start({
          observe: o => { if (s.phase === 'recording' || s.phase === 'starting') s.recorder.observe(o) },
          ended: reason => {
            // The window closed or the connection was lost while recording: nothing is kept.
            if (s.phase === 'review') return
            discard(s, reason === 'closed' ? W.closed : W.lost)
            deps.changed(companyId)
          },
        })
      } catch { ok = false }
      if (sessions.get(keyOf(user, companyId)) !== s) {
        // Discarded (or signed out) while it was starting: let the window go, or it stays held with nobody listening.
        await surface.stop().catch(() => {})
        return { ok: false, message: notes.get(keyOf(user, companyId)) ?? W.cannotStart }
      }
      if (!ok || deps.userId() !== user) {
        discard(s, null)
        return { ok: false, message: W.cannotStart }
      }
      s.phase = 'recording'
      return answer(companyId)
    },

    /** 「記録を止める」: nothing more is observed; the lines wait for the person to check them. */
    async stop(companyId: string): Promise<BrowserRecordingResult> {
      const s = current(companyId)
      // Stopped before it began observing: nothing was recorded — discarded (the start lets the window go).
      if (s?.phase === 'starting') { discard(s, W.empty); return answer(companyId) }
      if (!s || s.phase !== 'recording') return answer(companyId)
      s.phase = 'review'
      await s.surface?.stop().catch(() => {})
      s.surface = null
      const content = s.recorder.content()
      if (content.steps.length === 0) {
        discard(s, W.empty)
        return answer(companyId)
      }
      s.content = content
      return answer(companyId)
    },

    /** ［消す］ on one line before sending (what points at it is cleared). */
    removeLine(companyId: string, id: number): BrowserRecordingResult {
      const s = current(companyId)
      if (!s || s.phase !== 'review' || !s.content || s.sending || !Number.isSafeInteger(id)) return answer(companyId)
      s.content = browserRecordingWithout(s.content, [id])
      if (s.content.steps.length === 0) discard(s, W.discarded)
      return answer(companyId)
    },

    /** ［送る］: the server checks everything again; kept for another try when it did not answer. */
    async send(companyId: string): Promise<BrowserRecordingResult> {
      const s = current(companyId)
      if (!s || s.phase !== 'review' || !s.content || s.sending) return answer(companyId)
      s.sending = true
      s.message = null
      let result: BrowserRecordingSendAnswer
      try { result = await deps.api.send(companyId, { domain: s.host, content: s.content }) } finally { s.sending = false }
      if (current(companyId) !== s) return answer(companyId)
      if (result.kind === 'ok') {
        discard(s, W.sent)
        return answer(companyId)
      }
      s.message = result.kind === 'refused' && result.message ? W.refused(result.message) : W.sendFailed
      return answer(companyId)
    },

    /** ［捨てる］: at any point; nothing is sent. */
    async discard(companyId: string): Promise<BrowserRecordingResult> {
      const s = current(companyId)
      if (s) discard(s, W.discarded)
      return answer(companyId)
    },

    /** Sign-out: every recording is discarded (in memory only). */
    clear() {
      for (const s of [...sessions.values()]) discard(s, null)
      notes.clear()
    },
  }
}
export type BrowserRecordings = ReturnType<typeof createBrowserRecordings>

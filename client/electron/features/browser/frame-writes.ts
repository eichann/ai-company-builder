// A write run's page writes, one at a time (redesign step ⑤b; agent-browser.md "Writes within frames, in the app"; design
// memo §3 I3 / I4 / I7 and its 「止まったら・2回動いたら・同時に動いたら」, §6-2; the model's app actions in
// model/browser-plan/FramesLife.tla). The window holds each write its page makes (`HeldPageWrite`); this decides it:
//
//   read it (a file or an unreadable body → refused) → match a frame with the core's rule (none → refused, never asked)
//   → the window's write session is prepared → the server's permit (once, with the request's shape only) → the last check,
//   synchronously right before the request leaves (the permit's 5 s on both clocks, the run still going) → sent once →
//   the report (done / not_sent / unknown / refused: a 4xx that proves it was not taken, the run goes on) → the page gets
//   the site's answer (without Set-Cookie) or a failure.
//
// **One at a time**: a second write the page makes waits until the first's result is recorded (a promise chain), so two
// writes never travel to a site together and the server never sees a permit while one is in flight. **Never again**: a
// write that left without an answer is `unknown`, the run sends nothing more (`locked`), and nothing here resends — the
// page's own retry is a new hold that needs a new unit. A write held when the run stops or the window goes is failed,
// never sent. No Electron; the HTTP client and the clocks are injected.
import {
  pickFrame, readHeldWrite, sentFields, workWriteLogStep, workWriteLine,
  type HeldPageWrite, type HeldPageWriteAnswer, type WorkFrame,
} from '../../../shared/browser-frame-writes'
import type { BrowserRunWriteOutcome, BrowserRunWriteStep } from '../../../../shared/core/browser-run-log'
import { browserWriteAnswerKind } from '../../../../shared/core/browser-frame-match'
import type { BrowserFramePermit, BrowserFramePermitRequest } from '../../../../shared/types/browser-frames'
import type { BrowserLinesAnswer } from './lines-api'

/** The server's frames routes as one write uses them (the member's session; the permit and a sure report carry this PC's key). */
export interface FrameWritesApi {
  framePermit(companyId: string, runId: string, body: { frame: number; request: BrowserFramePermitRequest }): Promise<BrowserLinesAnswer>
  frameReport(companyId: string, runId: string, body: { write: number; result: 'done' | 'not_sent' | 'unknown' | 'refused'; reason?: string }): Promise<BrowserLinesAnswer>
}

/** One held write as the card and the operator learn of it (main's memory only). */
export interface FrameWriteRecord {
  /** The frame's method and pattern (never the path the page sent: it may name an object). */
  line: string
  outcome: BrowserRunWriteOutcome
  /** The site's status when it answered (a non-success status makes the write `unknown`). */
  status: number | null
  /** What it sent (for the after-read card's machine check; never a login, CSRF or session field) and its path. */
  sent: Record<string, string> | null
  path: string | null
  /** The site's answer as text, when it answered with success (what `{created}` is read from). */
  answerText: string | null
  /** The server's write (its permit) and when it was permitted, when one was given (the card's answer about a write in doubt). */
  write?: number | null
  permittedAt?: string | null
}

export interface FrameWriterDeps {
  companyId: string
  runId: string
  host: string
  /** The run's frames (the server's view at the start / approval); `left` is counted down here as permits are given. */
  frames: WorkFrame[]
  api: FrameWritesApi
  /** The run still going: not stopped, not cut, the window open, the same context. Asked at every step and in the last check. */
  going(): boolean
  /** How many operator steps were logged so far (where a write step sits in the run log). */
  stepsSoFar(): number
  /** An after-read address to read before the first write that fits it (its "before"), awaited before the permit. */
  readBefore?(heldPath: string): Promise<void>
  now?: () => number
  monoMs?: () => number
}

const PERMIT_MAX_MS = 5000
const REPORT_TRIES = 3
const isPermit = (v: unknown): v is BrowserFramePermit => {
  const p = v as Record<string, unknown> | null
  return !!p && Number.isSafeInteger(p.write) && (p.write as number) > 0 && Number.isSafeInteger(p.frame) && typeof p.validMs === 'number' && Number.isFinite(p.validMs)
}
/** The permit refusals that mean the run is over (nothing more can be permitted in it). */
const RUN_OVER = new Set(['BROWSER_RUN_ENDED', 'BROWSER_RUN_AFTER_UNKNOWN', 'BROWSER_RUN_NOT_APPROVED', 'BROWSER_FRAME_RUN_NOT_FOUND', 'BROWSER_NOT_ALLOWED', 'BROWSER_AI_STOPPED', 'BROWSER_TYPE_NOT_GRANTED', 'BROWSER_SKILL_CHANGED', 'BROWSER_DEVICE_ELSEWHERE'])

export function createFrameWriter(deps: FrameWriterDeps) {
  const now = deps.now ?? Date.now
  const monoMs = deps.monoMs ?? (() => performance.now())
  const records: FrameWriteRecord[] = []
  const log: BrowserRunWriteStep[] = []
  let chain: Promise<unknown> = Promise.resolve()
  let closed = false
  /** A write may have been sent without an answer (or its result could not be recorded): nothing more in this run. */
  let locked = false
  /** The server said the run is over (ended, refused by the gate). */
  let over = false
  /**
   * The window's DevTools connection went while a write was held (independent review of #856): Chromium may have let the
   * page's original go out on its own, so a held write is never sent and is told `unknown`, never `not_sent`.
   */
  let originalMayHaveGone = false

  /** One held write from the moment it is held until its outcome is kept (once: `abandon` may keep it first). */
  /** `write` / `permittedAt`: its permit once given, so a write given up as unknown can still be answered about on the card. */
  interface Held { method: string; path: string; line: string; frame: number | null; recorded: boolean; write: number | null; permittedAt: string | null }
  const pending = new Set<Held>()

  const keepRecord = (h: Held, r: FrameWriteRecord, outcome: BrowserRunWriteOutcome) => {
    pending.delete(h)
    if (h.recorded) return
    h.recorded = true
    records.push(r)
    if (log.length < 60) log.push(workWriteLogStep({ after: deps.stepsSoFar(), frame: h.frame, method: h.method, path: h.path, host: deps.host, outcome }))
  }

  /** The report, sent at most 3 times with the same body; true once the server recorded it. */
  async function report(write: number, result: 'done' | 'not_sent' | 'unknown' | 'refused', reason?: string): Promise<boolean> {
    for (let i = 0; i < REPORT_TRIES; i++) {
      const a = await deps.api.frameReport(deps.companyId, deps.runId, { write, result, ...(reason ? { reason } : {}) }).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
      if (a.kind === 'ok') return true
      if (a.kind === 'refused') return false
    }
    return false
  }

  async function decide(held: HeldPageWrite, h: Held): Promise<HeldPageWriteAnswer> {
    const fail: HeldPageWriteAnswer = { kind: 'fail' }
    const keep = (r: FrameWriteRecord, outcome: BrowserRunWriteOutcome) => keepRecord(h, r, outcome)
    const shapeOf = readHeldWrite({ method: held.method, url: held.url, host: deps.host, contentType: held.contentType, body: held.body })
    // Stopped, locked, over, abandoned: nothing is sent (the page sees a failure).
    if (closed || locked || over || !deps.going()) {
      keep({ line: h.line, outcome: originalMayHaveGone ? 'unknown' : 'not-sent', status: null, sent: null, path: null, answerText: null }, originalMayHaveGone ? 'unknown' : 'not-sent')
      return fail
    }
    // A file, an unreadable body, another host, `_method` twice: refused, never asked for.
    if (!shapeOf.ok) {
      keep({ line: h.line, outcome: 'refused', status: null, sent: null, path: null, answerText: null }, 'refused')
      return fail
    }
    const shape = shapeOf.shape
    h.method = shape.method
    h.path = shape.path
    // Outside every frame (an autosave, another target, a frame used up): refused, never asked for.
    const picked = pickFrame(deps.frames, shape)
    if ('mismatch' in picked) {
      keep({ line: workWriteLine(shape.method, null), outcome: 'refused', status: null, sent: null, path: null, answerText: null }, 'refused')
      return fail
    }
    const { frame, request } = picked
    const line = workWriteLine(frame.method, frame.path)
    h.line = line
    h.frame = frame.frame
    if (deps.readBefore) await deps.readBefore(shape.path).catch(() => {})
    let permit: BrowserFramePermit | null = null
    let askedMono = 0
    let askedWall = 0
    const outcome = await held.send({
      // The permit, after the write session is prepared (its seconds never eat into the permit's 5).
      ready: async () => {
        if (closed || locked || over || !deps.going()) return false
        askedMono = monoMs()
        askedWall = now()
        const a = await deps.api.framePermit(deps.companyId, deps.runId, { frame: frame.frame, request }).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
        if (a.kind === 'refused' && a.code && RUN_OVER.has(a.code)) over = true
        if (a.kind !== 'ok' || !isPermit(a.value) || a.value.frame !== frame.frame) return false
        permit = a.value
        h.write = a.value.write
        h.permittedAt = typeof a.value.permittedAt === 'string' ? a.value.permittedAt : null
        // The unit is the server's now (never given back, also when this write is not sent).
        frame.left = Math.max(0, frame.left - 1)
        return true
      },
      // The last check, synchronously right before the request leaves: the permit still fresh on both clocks, the run going.
      beforeSend: () => {
        if (!permit || closed || locked || over || !deps.going()) return false
        const valid = Math.min(permit.validMs, PERMIT_MAX_MS)
        const mono = monoMs() - askedMono
        const wall = now() - askedWall
        return mono >= 0 && mono < valid && wall >= 0 && wall < valid
      },
    })
    const permitted = permit as BrowserFramePermit | null
    if (!outcome.sent) {
      // Never left: told `not_sent` when a unit was taken (no permit: nothing to tell) — unless the page's original may
      // have gone out on its own (the window's DevTools connection went): then `unknown`.
      if (originalMayHaveGone) {
        locked = true
        if (permitted) await report(permitted.write, 'unknown', 'context-changed')
        keep({ line, outcome: 'unknown', status: null, sent: sentFields(shape), path: shape.path, answerText: null, write: permitted?.write ?? null, permittedAt: permitted?.permittedAt ?? null }, 'unknown')
        return fail
      }
      if (permitted && !(await report(permitted.write, 'not_sent', 'permit-late'))) locked = true
      keep({ line, outcome: 'not-sent', status: null, sent: null, path: null, answerText: null }, 'not-sent')
      return fail
    }
    const write = (permitted as BrowserFramePermit | null)?.write ?? 0
    const ids = { write: permitted ? write : null, permittedAt: (permitted as BrowserFramePermit | null)?.permittedAt ?? null }
    const answer = outcome.answer
    if (!answer) {
      // It may have reached the site: unknown, the run sends nothing more, and it is never sent again.
      locked = true
      await report(write, 'unknown', 'no-answer')
      keep({ line, outcome: 'unknown', status: null, sent: sentFields(shape), path: shape.path, answerText: null, ...ids }, 'unknown')
      return fail
    }
    // The core's one rule (browserWriteAnswerKind): 2xx / 3xx done; a 4xx that proves it was not taken → refused (the run
    // goes on: the page shows its error and a corrected try is a new write, its own permit and unit; nothing is resent
    // here); anything else → unknown, locked (the safe side).
    const kind = browserWriteAnswerKind(answer.status)
    if (kind === 'unknown') locked = true
    const recorded = await report(write, kind, kind === 'unknown' ? 'other-state' : undefined)
    // A result the server did not record: nothing more is sent in this run (the server's time-out makes it unknown).
    if (!recorded) locked = true
    // A refusal the server did not record is kept as unknown (an older server does not know `refused`: its run log would
    // refuse `site-refused` whole; independent review of #859) — the run is locked above anyway.
    const kept: BrowserRunWriteOutcome = kind === 'refused' ? (recorded ? 'site-refused' : 'unknown') : kind
    keep({
      line, outcome: kept, status: kind === 'done' ? null : answer.status, sent: sentFields(shape), path: shape.path,
      answerText: kind === 'done' ? answer.body : null, ...ids,
    }, kept)
    // The page gets the site's answer (its Set-Cookie never: the window drops it too), so its flow goes on.
    return { kind: 'fulfill', status: answer.status, headers: (answer.headers ?? []).filter(([k]) => !/^set-cookie2?$/i.test(k)), body: answer.bytes ?? new TextEncoder().encode(answer.body) }
  }

  return {
    /** The window's hold: queued behind the write before it (its result recorded first). */
    hold(held: HeldPageWrite): Promise<HeldPageWriteAnswer> {
      let path = '/'
      try { path = new URL(held.url).pathname } catch { /* kept as / */ }
      const h: Held = { method: held.method.toUpperCase(), path, line: workWriteLine(held.method.toUpperCase(), null), frame: null, recorded: false, write: null, permittedAt: null }
      pending.add(h)
      const next = chain.then(() => decide(held, h), () => decide(held, h))
      chain = next.catch(() => undefined)
      return next.catch((): HeldPageWriteAnswer => {
        keepRecord(h, { line: h.line, outcome: 'unknown', status: null, sent: null, path: null, answerText: null, write: h.write, permittedAt: h.permittedAt }, 'unknown')
        locked = true
        return { kind: 'fail' }
      })
    },
    /** The run is over: every write held from now on (and every one still queued) fails; one on its way finishes. */
    close() { closed = true },
    /**
     * Given up on the writes still held (independent review of #856): the wait for the one on its way ran out, or the
     * window's DevTools connection went while one was held (`detached`: the page's original may have gone out on its own).
     * Every write held and not yet kept is kept as `unknown` now (the card, the AI's words and the run log say so), the run
     * is locked and closed — nothing more is sent; a held one not sent yet never will be.
     */
    abandon(why: 'timeout' | 'detached') {
      if (why === 'detached' && pending.size > 0) originalMayHaveGone = true
      closed = true
      if (pending.size > 0) locked = true
      for (const h of [...pending]) keepRecord(h, { line: h.line, outcome: 'unknown', status: null, sent: null, path: null, answerText: null, write: h.write, permittedAt: h.permittedAt }, 'unknown')
    },
    /** Until the write on its way (if any) is recorded. */
    idle: () => chain.then(() => undefined),
    locked: () => locked,
    records: () => records.slice(),
    log: () => log.slice(),
    /** A frame's remaining units (for the operator's material). */
    frames: () => deps.frames.map(f => ({ ...f })),
  }
}

export type FrameWriter = ReturnType<typeof createFrameWriter>

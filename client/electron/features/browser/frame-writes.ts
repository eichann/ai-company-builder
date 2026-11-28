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
// **What this run made** (agent-browser.md "Writes only to what this run made"): a done write of a frame that a later
// frame's `{made:<n>}` refers to reports the id the site's answer named (`createdIdOf`: `id` / `data.id`), and once the
// server recorded it, it is kept here too, so a later write is matched against it before any permit is asked (the server
// asks the same rule against its own record). No id read → nothing kept: a later `{made}` write is refused.
//
// **The run's promise** (agent-browser.md "The run's promise"): with one, a held write is checked with the core's rule
// before any permit (the server asks the same): a bound field with another value → refused, never sent, never asked; a field,
// target or value not in it yet → the person is asked once on the card while the page's request waits, and only their
// 「書いてよい」 (added on the server) lets it go on. The permit carries the write's check (digests, never a value).
//
// **Sent is not done** (agent-browser.md "Sent is not done"): a refused write (the site's error) is read again at its own
// address before it is reported; only an answer identical to the one read before it says "not saved" (`checked`).
//
// **One at a time**: a second write the page makes waits until the first's result is recorded (a promise chain), so two
// writes never travel to a site together and the server never sees a permit while one is in flight. **Never again**: a
// write that left without an answer is `unknown`, the run sends nothing more (`locked`), and nothing here resends — the
// page's own retry is a new hold that needs a new unit. A write held when the run stops or the window goes is failed,
// never sent. No Electron; the HTTP client and the clocks are injected.
import {
  BROWSER_WORK_CARD_WORDS as CW, createdIdOf, pickFrame, promiseCheckOf, readHeldWrite, sentBodyWhole, sentFields, workRefusedWriteLine, workWriteLogStep, workWriteLine,
  type HeldPageWrite, type HeldPageWriteAnswer, type HeldWriteShape, type WorkFrame, type WorkWriteSeen, type WorkWriteWhy,
} from '../../../shared/browser-frame-writes'
import { browserPathSegments, browserPromiseVerdict, type BrowserPermitCheck, type BrowserPromiseState, type BrowserRunPromiseAddition } from '../../../../shared/core/browser-run-promise'
import { browserMadeFrom } from '../../../../shared/core/browser-skill'
import type { BrowserRunWriteOutcome, BrowserRunWriteStep } from '../../../../shared/core/browser-run-log'
import { browserWriteAnswerKind } from '../../../../shared/core/browser-frame-match'
import type { BrowserFramePermit, BrowserFramePermitRequest } from '../../../../shared/types/browser-frames'
import type { BrowserLinesAnswer } from './lines-api'

/** The server's frames routes as one write uses them (the member's session; the permit and a sure report carry this PC's key). */
export interface FrameWritesApi {
  framePermit(companyId: string, runId: string, body: { frame: number; request: BrowserFramePermitRequest; check?: BrowserPermitCheck }): Promise<BrowserLinesAnswer>
  frameReport(companyId: string, runId: string, body: { write: number; result: 'done' | 'not_sent' | 'unknown' | 'refused'; reason?: string; created?: string; checked?: 'unchanged' }): Promise<BrowserLinesAnswer>
}

/** What the card asks before a write outside the run's promise is sent: its line and each item in plain words (the person's card only). */
export interface PromiseAsk { frame: number; line: string; items: string[]; addition: BrowserRunPromiseAddition }

/**
 * The run's promise as the writer uses it (the work wiring holds it): the promise in force, the run's keyed digest, and the
 * card's question — true only once the person said 「書いてよい」 and the server took exactly that addition (the state then
 * holds it).
 */
export interface WriterPromise {
  state(): BrowserPromiseState
  digest(value: string): string
  /** `allowed` once the server took the person's 「書いてよい」; `denied` (書かない, the card's time, the run's stop); `failed` (the server did not take it). */
  ask(q: PromiseAsk): Promise<'allowed' | 'denied' | 'failed'>
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
  /** `sent` is the whole of what the write said (`sentBodyWhole`): only then may the write ledger's read-back speak for it. */
  sentWhole?: boolean
  path: string | null
  /** The site's answer as text, when it answered with success (what `{created}` is read from). */
  answerText: string | null
  /** The server's write (its permit) and when it was permitted, when one was given (the card's answer about a write in doubt). */
  write?: number | null
  permittedAt?: string | null
  /** The frame it fitted (null: none), after which operator action it was held, and why it was not sent (fixed words). */
  frame: number | null
  afterAction: number
  why: WorkWriteWhy | null
  /** A refused write read again and found unchanged, or not (agent-browser.md "Sent is not done"). */
  refusal?: 'unchanged' | 'unconfirmed'
  /** What the run promised for its bound fields, as the write sent them (the card's read-back compares with it). */
  promised?: Record<string, string> | null
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
  /** How many actions the operator took so far (its history's numbering: which action a write followed). Default 0. */
  actionsSoFar?(): number
  /** An after-read address to read before the first write that fits it (its "before"), awaited before the permit. */
  readBefore?(heldPath: string): Promise<void>
  /**
   * A refused write's own address read again (agent-browser.md "Sent is not done"): `unchanged` only when it was read right
   * before the write and reads exactly so now; null otherwise (not read before, unreadable, changed).
   */
  readAgain?(heldPath: string, sent: Readonly<Record<string, string>> | null): Promise<'unchanged' | null>
  /** The run's promise (absent or null: none — an older server; nothing is checked and only the old reports are sent). */
  promise?: () => WriterPromise | null
  now?: () => number
  monoMs?: () => number
}

const PERMIT_MAX_MS = 5000
/** Whether the held write itself carried this value (any body field's value, a segment of its path or a word of its query). */
const sentCarries = (shape: HeldWriteShape, value: string): boolean =>
  shape.path.split('/').includes(value) || (shape.query !== null && shape.query.split(/[&=]/).includes(value))
  || [...shape.fields.values()].some(values => values.includes(value))
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
  /** `abandon` ran: what was held is kept as unknown and the run is over (the end of the run need not wait again). */
  let gaveUp = false
  /** What this run made, by the frame that made it: only ids the server recorded (the same answers its permits read). */
  const made = new Map<number, Set<string>>()
  /** Frames a later frame's `{made:<n>}` refers to: only their done writes report what they made. */
  const makers = new Set(deps.frames.map(f => browserMadeFrom(f.path)).filter((n): n is number => n !== null))

  /** Every id this run's done writes made, as the server recorded it (the promise's "a target this run made"). */
  const madeAll = new Set<string>()
  /** Held writes waiting for the person's answer on the card (no permit asked yet). */
  let asking = 0
  /** When the last question on the card was answered (`performance.now()`; 0: none yet): the send after it starts its own wait. */
  let askEnded = 0

  /** One held write from the moment it is held until its outcome is kept (once: `abandon` may keep it first). */
  /** `write` / `permittedAt`: its permit once given, so a write given up as unknown can still be answered about on the card. */
  interface Held { method: string; path: string; line: string; frame: number | null; recorded: boolean; write: number | null; permittedAt: string | null; afterAction: number; asking: boolean }
  type Kept = Omit<FrameWriteRecord, 'frame' | 'afterAction' | 'why'> & { why?: WorkWriteWhy }
  const pending = new Set<Held>()
  /** Every write held in this run (a write that came and went between two looks still counts). */
  let heldSoFar = 0

  const keepRecord = (h: Held, r: Kept, outcome: BrowserRunWriteOutcome) => {
    pending.delete(h)
    if (h.recorded) return
    h.recorded = true
    records.push({ ...r, frame: h.frame, afterAction: h.afterAction, why: r.why ?? null })
    if (log.length < 60) log.push(workWriteLogStep({ after: deps.stepsSoFar(), frame: h.frame, method: h.method, path: h.path, host: deps.host, outcome }))
  }

  /** The report, sent at most 3 times with the same body; true once the server recorded it. */
  async function report(write: number, result: 'done' | 'not_sent' | 'unknown' | 'refused', reason?: string, created?: string, checked?: 'unchanged'): Promise<boolean> {
    for (let i = 0; i < REPORT_TRIES; i++) {
      const a = await deps.api.frameReport(deps.companyId, deps.runId, { write, result, ...(reason ? { reason } : {}), ...(created !== undefined ? { created } : {}), ...(checked ? { checked } : {}) }).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
      if (a.kind === 'ok') return true
      if (a.kind === 'refused') return false
    }
    return false
  }

  async function decide(held: HeldPageWrite, h: Held): Promise<HeldPageWriteAnswer> {
    const fail: HeldPageWriteAnswer = { kind: 'fail' }
    const keep = (r: Kept, outcome: BrowserRunWriteOutcome) => keepRecord(h, r, outcome)
    const shapeOf = readHeldWrite({ method: held.method, url: held.url, host: deps.host, contentType: held.contentType, body: held.body })
    // Stopped, locked, over, abandoned: nothing is sent (the page sees a failure).
    if (closed || locked || over || !deps.going()) {
      keep({ line: h.line, outcome: originalMayHaveGone ? 'unknown' : 'not-sent', status: null, sent: null, path: null, answerText: null, why: 'run-over' }, originalMayHaveGone ? 'unknown' : 'not-sent')
      return fail
    }
    // A file, an unreadable body, another host, `_method` twice: refused, never asked for.
    if (!shapeOf.ok) {
      const why: WorkWriteWhy = shapeOf.problem === 'host' ? 'other-host' : shapeOf.problem === 'file' ? 'file' : 'unreadable'
      keep({ line: h.line, outcome: 'refused', status: null, sent: null, path: null, answerText: null, why }, 'refused')
      return fail
    }
    const shape = shapeOf.shape
    h.method = shape.method
    h.path = shape.path
    // Outside every frame (an autosave, another target, a frame used up): refused, never asked for.
    const picked = pickFrame(deps.frames, shape, made)
    if ('mismatch' in picked) {
      const why: WorkWriteWhy = picked.mismatch === 'used-up' ? 'used-up' : picked.mismatch === 'made' ? 'not-made-here' : 'outside-frames'
      keep({ line: workRefusedWriteLine(shape.method, held.url, deps.host), outcome: 'refused', status: null, sent: null, path: null, answerText: null, why }, 'refused')
      return fail
    }
    const { frame, request } = picked
    const line = workWriteLine(frame.method, frame.path, frame.query)
    h.line = line
    h.frame = frame.frame
    // The run's promise: the core's rule before any permit (the server asks the same with the check this write carries).
    const promise = deps.promise?.() ?? null
    let check: BrowserPermitCheck | undefined
    if (promise) {
      const c = promiseCheckOf(frame, shape, promise.digest)
      if (!c) {
        keep({ line, outcome: 'refused', status: null, sent: null, path: null, answerText: null, why: 'unreadable' }, 'refused')
        return fail
      }
      const verdictNow = () => browserPromiseVerdict({ frameIdx: frame.frame, frame, path: shape.path, check: c, promise: promise.state(), made: madeAll })
      let verdict = verdictNow()
      if (verdict.kind === 'broken') {
        keep({ line, outcome: 'refused', status: null, sent: null, path: null, answerText: null, why: 'outside-promise' }, 'refused')
        return fail
      }
      if (verdict.kind === 'ask') {
        // Asked once on the card while the page's request waits (no permit yet); only the person's 「書いてよい」 goes on.
        const segments = browserPathSegments(shape.path)
        const items = [
          // The person's card only: names and values of the page's own write (never the consultation AI, a log or the server).
          ...verdict.fields.map(CW.askField),
          ...verdict.targets.map(i => CW.askTarget(segments[i] ?? '')),
          ...verdict.values.map(f => CW.askValue(f, (shape.fields.get(f) ?? []).join('、'))),
        ]
        const addition: BrowserRunPromiseAddition = {
          frame: frame.frame, fields: verdict.fields, targets: verdict.targets.map(i => c.segments[i] as string),
          binds: verdict.values.map(f => ({ field: f, digest: c.fields[f] })),
        }
        h.asking = true
        asking++
        const answer = await promise.ask({ frame: frame.frame, line, items, addition }).catch(() => 'failed' as const)
        const allowed = answer === 'allowed'
        asking--
        askEnded = performance.now()
        h.asking = false
        if (closed || locked || over || !deps.going()) {
          keep({ line, outcome: 'not-sent', status: null, sent: null, path: null, answerText: null, why: 'run-over' }, 'not-sent')
          return fail
        }
        verdict = allowed ? verdictNow() : verdict
        if (!allowed || verdict.kind !== 'kept') {
          // The person's 「書かない」 is said so; a 「書いてよい」 the server did not take is no permit (never "the person said no").
          keep({ line, outcome: 'refused', status: null, sent: null, path: null, answerText: null, why: answer === 'failed' ? 'no-permit' : 'not-allowed' }, 'refused')
          return fail
        }
      }
      check = c
    }
    // What the run promised for this frame's bound fields, as this write carries them (the card's read-back compares with it).
    const promised = promise && frame.bind ? Object.fromEntries(Object.keys(frame.bind).map(k => [k, (shape.fields.get(k) ?? [''])[0]])) : null
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
        const a = await deps.api.framePermit(deps.companyId, deps.runId, { frame: frame.frame, request, ...(check ? { check } : {}) }).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
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
        keep({ line, outcome: 'unknown', status: null, sent: sentFields(shape), sentWhole: sentBodyWhole(shape), path: shape.path, answerText: null, write: permitted?.write ?? null, permittedAt: permitted?.permittedAt ?? null }, 'unknown')
        return fail
      }
      if (permitted && !(await report(permitted.write, 'not_sent', 'permit-late'))) locked = true
      keep({ line, outcome: 'not-sent', status: null, sent: null, path: null, answerText: null, why: permitted ? 'stopped-before-send' : 'no-permit' }, 'not-sent')
      return fail
    }
    const write = (permitted as BrowserFramePermit | null)?.write ?? 0
    const ids = { write: permitted ? write : null, permittedAt: (permitted as BrowserFramePermit | null)?.permittedAt ?? null }
    const answer = outcome.answer
    if (!answer) {
      // It may have reached the site: unknown, the run sends nothing more, and it is never sent again.
      locked = true
      await report(write, 'unknown', 'no-answer')
      keep({ line, outcome: 'unknown', status: null, sent: sentFields(shape), sentWhole: sentBodyWhole(shape), path: shape.path, answerText: null, ...ids }, 'unknown')
      return fail
    }
    // The core's one rule (browserWriteAnswerKind): 2xx / 3xx done; a 4xx that proves it was not taken → refused (the run
    // goes on: the page shows its error and a corrected try is a new write, its own permit and unit; nothing is resent
    // here); anything else → unknown, locked (the safe side).
    const kind = browserWriteAnswerKind(answer.status)
    if (kind === 'unknown') locked = true
    // What it made, when a later frame may write only to that (a done write of such a frame; none read → none kept) — and,
    // with the run's promise (a server that keeps ids of every frame), what any done write made: a target this run made. An
    // id the request itself carried (a body value or a path segment: an upsert, an id the caller chose) is not one the site
    // minted for this run — never reported (independent review).
    const named = kind === 'done' && (makers.has(frame.frame) || promise) ? createdIdOf(answer.body) : null
    const createdNow = named !== null && !sentCarries(shape, named) ? named : undefined
    // The site's error proves nothing was saved only when the write's own address, read right before it, reads the same now.
    const refusal = kind === 'refused'
      ? ((await deps.readAgain?.(shape.path, sentBodyWhole(shape) ? sentFields(shape) : null).catch(() => null)) === 'unchanged' ? 'unchanged' as const : 'unconfirmed' as const)
      : undefined
    const recorded = await report(write, kind, kind === 'unknown' ? 'other-state' : undefined, createdNow, refusal === 'unchanged' && promise ? 'unchanged' : undefined)
    // A result the server did not record: nothing more is sent in this run (the server's time-out makes it unknown).
    if (!recorded) locked = true
    else if (createdNow !== undefined) {
      madeAll.add(createdNow)
      if (makers.has(frame.frame)) made.set(frame.frame, (made.get(frame.frame) ?? new Set()).add(createdNow))
    }
    // A refusal the server did not record is kept as unknown (an older server does not know `refused`: its run log would
    // refuse `site-refused` whole; independent review of #859) — the run is locked above anyway.
    const kept: BrowserRunWriteOutcome = kind === 'refused' ? (recorded ? 'site-refused' : 'unknown') : kind
    keep({
      line, outcome: kept, status: kind === 'done' ? null : answer.status, sent: sentFields(shape), sentWhole: sentBodyWhole(shape), path: shape.path,
      answerText: kind === 'done' ? answer.body : null, ...ids, ...(kept === 'site-refused' && refusal ? { refusal } : {}), ...(promised ? { promised } : {}),
    }, kept)
    // The page gets the site's answer (its Set-Cookie never: the window drops it too), so its flow goes on.
    return { kind: 'fulfill', status: answer.status, headers: (answer.headers ?? []).filter(([k]) => !/^set-cookie2?$/i.test(k)), body: answer.bytes ?? new TextEncoder().encode(answer.body) }
  }

  return {
    /** The window's hold: queued behind the write before it (its result recorded first). */
    hold(held: HeldPageWrite): Promise<HeldPageWriteAnswer> {
      let path = '/'
      try { path = new URL(held.url).pathname } catch { /* kept as / */ }
      const h: Held = { method: held.method.toUpperCase(), path, line: workWriteLine(held.method.toUpperCase(), null), frame: null, recorded: false, write: null, permittedAt: null, afterAction: deps.actionsSoFar?.() ?? 0, asking: false }
      pending.add(h)
      heldSoFar++
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
      gaveUp = true
      if (pending.size > 0) locked = true
      // A write still waiting for the person's answer on the card has asked for no permit: it was never sent (unless the
      // page's original may have gone out on its own).
      for (const h of [...pending]) {
        if (h.asking && !originalMayHaveGone) keepRecord(h, { line: h.line, outcome: 'not-sent', status: null, sent: null, path: null, answerText: null, why: 'run-over' }, 'not-sent')
        else keepRecord(h, { line: h.line, outcome: 'unknown', status: null, sent: null, path: null, answerText: null, write: h.write, permittedAt: h.permittedAt }, 'unknown')
      }
    },
    /**
     * Until every write held so far is decided — also one the page makes while this waits (it joins the chain, so the
     * wait goes on until the chain stops growing).
     */
    idle: async (): Promise<void> => {
      for (;;) {
        const c = chain
        await c
        if (c === chain) return
      }
    },
    /** Writes held and not yet kept (on their way, or queued behind one): the operator is told they are being sent. */
    sending: () => pending.size,
    /** Held writes waiting for the person's answer on the card (the wait for them is the card's, not the 45 s of a send). */
    asking: () => asking,
    /** When the last question on the card was answered (0: none): what comes after it is not counted from before it. */
    askEnded: () => askEnded,
    /** How many writes were held in this run so far (activity, also of one already decided). */
    heldCount: () => heldSoFar,
    /**
     * Every write held so far as the operator is told of it: the kept ones in order, then the ones being sent — the frame
     * (once matched), the action it followed, the outcome or `sending`, a refusal's fixed reason. No value, path or text.
     */
    seen: (): WorkWriteSeen[] => [
      ...records.map(r => ({ state: r.outcome, frame: r.frame, afterAction: r.afterAction, why: r.why })),
      ...[...pending].map(h => ({ state: 'sending' as const, frame: h.frame, afterAction: h.afterAction, why: null })),
    ],
    gaveUp: () => gaveUp,
    locked: () => locked,
    records: () => records.slice(),
    log: () => log.slice(),
    /** A frame's remaining units (for the operator's material). */
    frames: () => deps.frames.map(f => ({ ...f })),
  }
}

export type FrameWriter = ReturnType<typeof createFrameWriter>

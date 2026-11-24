// The write runner of an opened line (「開けた1行」の書き込み, generalization PR 5c; agent-browser.md "Writing on the new
// path"; the state table "Executions with several writes" and model/browser-plan/StepsLife.tla — each step below names the
// model action it copies). Runs ONE plan of writes the member approved with ［任せる］, in their open window of the site.
// No Electron, no site: the window comes in as `BrowserRunSurface` + `BrowserPreviewSurface`, the server as
// `BrowserLineWritesApi` (the session; the execution's secret), the reads as the read runner (read-line-runner.ts), the
// site's code as its reviewed writers (`BrowserLineWriter`, handed in by main.ts from the site's map folder).
//
// One run:
//   approve (the hash the person saw) → claim (once per plan, ever: the execution, its secret — memory only — and the
//   fixed content) → the fixed content must hash to the approved hash and hold exactly the line, the values, the account
//   and the host the card showed → this PC's record `claimed` → the setting, the stop, the window, the plan's hour → the
//   line's reads again (strict, between the account markers, under the plan's account): every read the same as the card
//   showed, and the writes make a plan (`browserWritesPlanProblem`) → the window in `ai` mode with the write gate → for
//   each write k in order:
//     the writer builds the one request (held to its mechanics: the method, the exact path, a form's keys and the plan's
//     values) → the gate is armed with exactly that request → record `permit-asked` → the write session prepared, then
//     write k's permit (≤ 5 s, asked once; a write on what an earlier write created must be bound by the server to the id
//     this run used, `createdTarget`) → the last check synchronously right before the request leaves (both clocks under
//     the permit, the same context, not stopped, the window clean) → the request (never resent) → a create's new id from
//     the answer (a candidate) → the line's reads and every object created so far read again (between the markers) and
//     judged against the prediction of writes 1..k (`judgeBrowserWrites`): exactly as predicted = write k `done`
//     (reported with its created id); anything else once the request left = `unknown` (never done, never resent, and no
//     later write is ever asked) → the next write only after the server kept `done`.
// Every stop before write k's permit is asked gives the rest back (`cancel`: claimed → void; running with nothing open →
// partial); a stop after the permit was asked and before the request left is `not_sent` (provably: the window's write
// says so only when the request was never ended); once the request left — an answer, a refusal of the site, no answer,
// an error — it is never `not_sent` and never sent again; the person answers 済んでいた／されていなかった on the card.
import { createHash } from 'node:crypto'
import type { BrowserMap, BrowserThingReader, BrowserThingResult } from '../../../../shared/core/browser-map'
import type { BrowserOpenedLine, BrowserOpenedStatus } from '../../../../shared/core/browser-opened'
import { BROWSER_PLAN_TIMES, BROWSER_REPORT_REASONS } from '../../../../shared/core/browser-plans'
import type { BrowserReadFacts, BrowserSuppliedValue } from '../../../../shared/core/browser-read-line'
import {
  browserWritesPlanProblem, judgeBrowserWrites, type BrowserCreatedRead, type BrowserLineWrite, type BrowserState,
} from '../../../../shared/core/browser-write-line'
import { canonicalJson } from '../../../../shared/core/fixed-content'
import { BROWSER_ID_VALUE_RE } from '../../../../shared/core/plugin-browser-declaration'
import type { BrowserLineRef } from '../../../../shared/types/browser-lines'
import {
  BROWSER_CREATED_ID_RE, createLineWriteGate, lineWriteMechanicsProblem, lineWriteRequestProblem, writerKey,
  type BrowserLineWriteRequest, type BrowserLineWriters, type BrowserWriteCardState,
} from '../../../shared/browser-line-writes'
import type { BrowserPreviewSurface, BrowserRunReason, BrowserRunSurface, BrowserWriteOutcome } from '../../../shared/browser-runner'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'
import type { BrowserLinesAnswer, BrowserLineWritesApi } from './lines-api'
import type { BrowserAccountMarker, BrowserReadRunInput, BrowserReadRunResult, BrowserThingAddress } from './read-line-runner'
import type { BrowserRunRecords } from './runner'

/** The member's open window of the site as a write run uses it. */
export interface BrowserWriteRunWindow {
  run: BrowserRunSurface
  preview: BrowserPreviewSurface
}

/** An approved line that writes, as this build bundles it, with its site's code (main.ts hands it in). */
export interface BrowserWriteRunSite {
  host: string
  /** The opened list's row of exactly this line and map (the server's gate matches all six). */
  ref: BrowserLineRef
  line: BrowserOpenedLine
  lineStatus: BrowserOpenedStatus
  map: BrowserMap
  readers: Readonly<Record<string, BrowserThingReader>>
  addresses: Readonly<Record<string, BrowserThingAddress>>
  account: BrowserAccountMarker
  writers: BrowserLineWriters
}

/** What the card showed the person and the server fixed: the values (as sent), the account and every read's state. */
export interface BrowserWritePrepared {
  values: Readonly<Record<string, BrowserSuppliedValue>>
  account: string
  before: Readonly<Record<string, BrowserState>>
}

export interface BrowserWriteRunInput {
  companyId: string
  planId: string
  /** The fixed content's hash the person saw on the card. */
  contentHash: string
  site: BrowserWriteRunSite
  prepared: BrowserWritePrepared
}

export interface BrowserWriteRunnerDeps {
  /** The switch (this PC's opt-in; default: the build's, off): off = refused at once, nothing asked, read or sent. */
  aiSwitch?: BrowserAiSwitch
  api: BrowserLineWritesApi
  /** The read runner's `run` (read-line-runner.ts), through the member's window's page-less read session. */
  read(input: BrowserReadRunInput): Promise<BrowserReadRunResult>
  /** The emergency stop for the company's AI (`browserAiStopped`). */
  stopped(companyId: string): boolean
  /** The member's current valid policy lets the site be written now (on, listed, level 「入力・保存まで」). */
  allowed(companyId: string, host: string): boolean
  window(companyId: string, host: string): BrowserWriteRunWindow | null
  /** Captures the context now (sign-in, company, setting generation, the switch); the answer says whether it still holds. */
  context(): () => boolean
  records: BrowserRunRecords
  now(): number
  monoMs?(): number
  log?: Pick<Console, 'warn'>
  /** The windows a run holds now, shared with the old path's runner (one window, one run at a time on both paths). */
  busyWindows?: Set<string>
}

/** Why a run ended where it did (fixed words; the card's and the record's, never a value). */
export const BROWSER_WRITE_RUN_REASONS = [
  'off', 'input', 'already-running', 'already-ran', 'not-approved', 'not-supported', 'approve-refused', 'claim-refused', 'claim-unanswered',
  'fixed-mismatch', 'records-unavailable', 'expired', 'stopped', 'policy', 'no-window', 'busy', 'context-changed', 'window-not-ready',
  'window-closed', 'foreign-frames', 'read-failed', 'before-changed', 'plan', 'csrf-missing', 'permit-refused', 'permit-unanswered',
  'permit-late', 'created-target', 'error', 'no-answer', 'created-unidentified', 'reread-failed', 'other-state', 'report-lost',
] as const
export type BrowserWriteRunReason = typeof BROWSER_WRITE_RUN_REASONS[number]

export type BrowserWriteRunResult = {
  /**
   * `refused`: nothing claimed. `stopped`: given back (or the permit refused) with nothing open — what was done before is
   * done (`states`). `failed` / `partial`: write k provably not sent, after 0 / some writes done. `unknown`: write k may
   * have reached the site; nothing after it is sent. `succeeded`: every write done as predicted.
   */
  outcome: 'refused' | 'stopped' | 'failed' | 'partial' | 'unknown' | 'succeeded'
  reason: BrowserWriteRunReason | null
  code?: string
  executionId?: string
  /** Each write's state as this run knows it (the card's four lists). */
  states: BrowserWriteCardState[]
  /** What each create made (by its `as`), identified for sure — shown on the member's card only. */
  created: Record<string, string>
}

/** A report is sent at most this many times, the same body each time. */
const REPORT_TRIES = 3
const SERVER_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const PLAN_ID_RE = /^bl_[0-9a-f]{32}$/
const EXEC_ID_RE = /^bw_[0-9a-f]{32}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const SECRET_RE = /^[A-Za-z0-9_-]{32,200}$/
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const same = (a: unknown, b: unknown): boolean => { try { return canonicalJson(a) === canonicalJson(b) } catch { return false } }

/** This run's word → the record's (the step record keeps the old runner's words only). */
const RECORD_WORDS: Partial<Record<BrowserWriteRunReason, BrowserRunReason>> = {
  'created-target': 'fixed-mismatch', 'created-unidentified': 'target-after', 'report-lost': 'no-answer', 'not-approved': 'plan',
}
/** This run's word → the report's (one list with the server). */
const REPORT_WORDS: Partial<Record<BrowserWriteRunReason, string>> = {
  'window-closed': 'context-changed', policy: 'context-changed', expired: 'context-changed', 'foreign-frames': 'context-changed',
  'created-target': 'fixed-mismatch', 'created-unidentified': 'target-after', 'records-unavailable': 'context-changed',
}

/** The claim's answer: the execution, its secret, the fixed content — or null when any is off. */
function parseClaim(v: unknown): { executionId: string; secret: string; content: string; contentHash: string } | null {
  if (!isMap(v) || typeof v.executionId !== 'string' || !EXEC_ID_RE.test(v.executionId) || typeof v.secret !== 'string' || !SECRET_RE.test(v.secret)) return null
  const f = v.fixed
  if (!isMap(f) || typeof f.content !== 'string' || typeof f.contentHash !== 'string' || !HASH_RE.test(f.contentHash)) return null
  return { executionId: v.executionId, secret: v.secret, content: f.content, contentHash: f.contentHash }
}

/** A write's permit: its index, the time it is valid for, and the id it is bound to (a write on what an earlier one made). */
function parsePermit(v: unknown, index: number): { validMs: number; createdTarget: string | null } | null {
  if (!isMap(v) || v.index !== index || typeof v.validMs !== 'number' || !Number.isFinite(v.validMs) || v.validMs <= 0) return null
  if (v.createdTarget !== null && (typeof v.createdTarget !== 'string' || !BROWSER_CREATED_ID_RE.test(v.createdTarget))) return null
  return { validMs: v.validMs, createdTarget: v.createdTarget as string | null }
}

export function createBrowserWriteRunner(deps: BrowserWriteRunnerDeps) {
  const log = deps.log ?? console
  const mono = deps.monoMs ?? (() => performance.now())
  const busyWindows = deps.busyWindows ?? new Set<string>()
  const runningPlans = new Set<string>()

  async function run(input: BrowserWriteRunInput): Promise<BrowserWriteRunResult> {
    const writesOf = (): readonly BrowserLineWrite[] => (isMap(input) && isMap(input.site) && Array.isArray(input.site.line?.writes) ? input.site.line.writes as BrowserLineWrite[] : [])
    const states: BrowserWriteCardState[] = writesOf().map(() => 'pending')
    const created: Record<string, string> = {}
    const result = (outcome: BrowserWriteRunResult['outcome'], reason: BrowserWriteRunReason | null, extra: { code?: string | null; executionId?: string } = {}): BrowserWriteRunResult =>
      ({ outcome, reason, states: [...states], created: { ...created }, ...(extra.code && SERVER_CODE_RE.test(extra.code) ? { code: extra.code } : {}), ...(extra.executionId ? { executionId: extra.executionId } : {}) })
    const refused = (reason: BrowserWriteRunReason, code?: string | null) => result('refused', reason, { code })
    // The switch first: off = nothing asked, read or sent.
    if (!(deps.aiSwitch ?? buildAiSwitch)()) return refused('off')
    if (!isMap(input) || typeof input.companyId !== 'string' || input.companyId.length === 0 || input.companyId.length > 200
      || typeof input.planId !== 'string' || !PLAN_ID_RE.test(input.planId) || typeof input.contentHash !== 'string' || !HASH_RE.test(input.contentHash)
      || !isMap(input.site) || !isMap(input.prepared) || typeof input.prepared.account !== 'string' || !BROWSER_ID_VALUE_RE.test(input.prepared.account)) return refused('input')
    const { companyId, planId, contentHash, site, prepared } = input
    const writes = writesOf()
    if (site.lineStatus !== 'approved') return refused('not-approved')
    if (writes.length === 0) return refused('input')
    // Every write has its site's reviewed writer, of a mechanics the core accepts (none: this build never writes it).
    for (const w of writes) {
      const r = site.line.read.reads.find(x => x.name === w.read)
      const writer = r ? site.writers[writerKey(r.thing, w.verb)] : undefined
      if (!r || !writer || lineWriteMechanicsProblem(writer.mechanics) || (w.verb === 'create_from' && typeof writer.createdId !== 'function')) return refused('not-supported')
      if ((w.verb === 'add_child') !== (writer.mechanics.encoding === 'form')) return refused('not-supported')
    }
    if (runningPlans.has(planId)) return refused('already-running')
    // This PC never runs a plan it has any record of (also one cut off by a crash); unreadable = refused.
    if (deps.records.has(planId)) return refused('already-ran')
    runningPlans.add(planId)
    try {
      return await claimed()
    } finally {
      runningPlans.delete(planId)
    }

    async function claimed(): Promise<BrowserWriteRunResult> {
      const current = deps.context()
      const approved = await ask(() => deps.api.approve(companyId, planId, contentHash))
      if (approved.kind === 'refused') return refused('approve-refused', approved.code)
      if (!current()) return refused('context-changed')
      // StepsLife.tla Claim: once per plan, ever. A lost answer: the plan is used up (void 2 minutes after the claim).
      const claimAnswer = await ask(() => deps.api.claim(companyId, planId))
      if (claimAnswer.kind === 'no-answer') return refused('claim-unanswered')
      if (claimAnswer.kind === 'refused') return refused('claim-refused', claimAnswer.code)

      let step = 0
      const record = (state: 'claimed' | 'permit-asked' | 'succeeded' | 'failed' | 'unknown', reason?: BrowserWriteRunReason) => {
        const word = reason ? RECORD_WORDS[reason] ?? reason : undefined
        deps.records.put({ planId, operation: site.line.name, step, state, ...(word ? { reason: word as BrowserRunReason } : {}), at: deps.now() })
      }
      const execution = parseClaim(claimAnswer.value)
      // StepsLife.tla AppStopsBetween: every stop before a permit is asked gives the rest back (claimed → void; running with
      // nothing open → partial). A lost cancel: the claim limit / the run's limit settle it.
      const giveBack = async (reason: BrowserWriteRunReason): Promise<BrowserWriteRunResult> => {
        try { record('failed', reason) } catch { /* nothing was sent either way */ }
        await ask(() => deps.api.cancel(companyId, planId))
        return result('stopped', reason, { executionId: execution?.executionId })
      }
      if (!execution) return giveBack('fixed-mismatch')
      // What the server fixed is what the person approved, and exactly what the card showed.
      let content: Record<string, unknown> | null = null
      try { content = JSON.parse(execution.content) as Record<string, unknown> } catch { content = null }
      if (execution.contentHash !== contentHash || sha256(execution.content) !== contentHash || !isMap(content) || canonicalJson(content) !== execution.content
        || content.shape !== 2 || content.company !== companyId || !same(content.line, site.ref) || content.host !== site.host || content.site !== site.line.read.site
        || content.account !== prepared.account || !same(content.values, prepared.values) || !Array.isArray(content.writes) || content.writes.length !== writes.length
        || typeof content.expiresAt !== 'string') return giveBack('fixed-mismatch')
      const expiresAt = Date.parse(content.expiresAt)
      const account = prepared.account
      try { record('claimed') } catch { return giveBack('records-unavailable') }

      const why = (): BrowserWriteRunReason | null => {
        if (!(deps.aiSwitch ?? buildAiSwitch)()) return 'context-changed'
        if (!current()) return 'context-changed'
        if (deps.stopped(companyId)) return 'stopped'
        if (!deps.allowed(companyId, site.host)) return 'policy'
        if (!(deps.now() < expiresAt)) return 'expired'
        return null
      }
      const early = why()
      if (early) return giveBack(early)
      const win = deps.window(companyId, site.host)
      if (!win || win.run.closed() || win.preview.closed()) return giveBack('no-window')
      const surface = win.run
      // A frame the page's write gate does not see stops the run at every check, the last one included.
      const abort = (): BrowserWriteRunReason | null => why() ?? (surface.closed() || deps.window(companyId, site.host)?.run !== surface ? 'window-closed' : surface.pageClean() ? null : 'foreign-frames')
      const windowKey = `${companyId}\0${site.host}`
      if (busyWindows.has(windowKey)) return giveBack('busy')
      busyWindows.add(windowKey)
      let inAi = false
      const values = prepared.values
      const plain = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]))
      const readLine = (objects?: Record<string, { thing: string; id: string }>) => deps.read({
        companyId, host: site.host, line: site.line, lineStatus: site.lineStatus, map: site.map, readers: site.readers, addresses: site.addresses,
        account: site.account, values, expectedAccount: account, ...(objects ? { objects } : {}),
      })
      try {
        // The line's reads again (I2): read whole, under the plan's account, exactly what the card showed.
        const reread = await readLine()
        let reason = abort()
        if (reason) return giveBack(reason)
        if (reread.status !== 'judged' || !reread.ok) return giveBack('read-failed')
        const before = reread.facts
        for (const r of site.line.read.reads) {
          const got = before.reads[r.name]
          if (!got || got.status !== 'read' || !own(prepared.before, r.name) || !same(got.state, prepared.before[r.name])) return giveBack('before-changed')
        }
        if (browserWritesPlanProblem(site.line.read, writes, site.map, before, account) !== null) return giveBack('plan')

        const gate = createLineWriteGate({ host: site.host, stopped: () => abort() !== null })
        inAi = true
        if (!(await surface.enterAi(gate.hooks))) return giveBack(abort() ?? 'window-not-ready')
        reason = abort()
        if (reason) return giveBack(reason)

        const createdReads: Record<string, BrowserCreatedRead> = {}
        for (let k = 1; k <= writes.length; k++) {
          step = k
          const w = writes[k - 1]
          const r = site.line.read.reads.find(x => x.name === w.read)!
          const writer = site.writers[writerKey(r.thing, w.verb)]
          // StepsLife.tla AppStopsBetween before asking write k's permit.
          reason = abort()
          if (reason) return giveBack(reason)
          // The one request, from the plan's values, what was read and what this run created (never the AI's word).
          let ids: { id: string; parent: string | null; value: string } | undefined
          let bound: string | null = null
          const readSite = async (address: string) => {
            if (abort()) return null
            try { const a = await win.preview.read(address); return abort() ? null : a } catch { return null }
          }
          let built: Awaited<ReturnType<typeof writer.build>>
          if (w.verb === 'add_child') {
            const id = 'value' in r.id ? plain[r.id.value] : undefined
            const parent = r.parent && 'value' in r.parent ? plain[r.parent.value] : null
            const value = plain[w.value]
            if (typeof id !== 'string' || typeof value !== 'string' || (r.parent && typeof parent !== 'string')) return giveBack('plan')
            ids = { id, parent: parent ?? null, value }
            built = await safeBuild(() => writer.build({ ids, read: readSite }))
          } else {
            const set: Record<string, string> = {}
            for (const [f, src] of Object.entries(w.set)) {
              if ('created' in src) {
                if (!own(created, src.created)) return giveBack('plan')
                set[f] = bound = created[src.created]
              } else set[f] = plain[src.value]
            }
            const original = before.reads[w.read]
            if (!original || original.status !== 'read') return giveBack('plan')
            built = await safeBuild(() => writer.build({ original: original.state, set, read: readSite }))
          }
          reason = abort()
          if (reason) return giveBack(reason)
          if ('problem' in built) return giveBack(built.problem === 'csrf-missing' ? 'csrf-missing' : built.problem === 'read-failed' ? 'read-failed' : 'plan')
          const request: BrowserLineWriteRequest = built.request
          if (lineWriteRequestProblem(writer.mechanics, request, ids) !== null) return giveBack('plan')

          // The permit's window, counted from just before it is asked, on both clocks.
          const at: { phase: 'before-permit' | 'permit-asked' | 'sent'; notSent: BrowserWriteRunReason | null; permitRefused: string | null | false } = { phase: 'before-permit', notSent: null, permitRefused: false }
          let permitMs: number = BROWSER_PLAN_TIMES.permit
          let t0m = 0
          let t0w = 0
          gate.arm(request)
          let outcome: BrowserWriteOutcome
          try {
            outcome = await surface.write({ method: request.method, path: request.path, contentType: request.contentType, body: request.body }, {
              // StepsLife.tla AppAsksPermit: the write session is prepared; now write k's permit (once, no retry).
              async ready() {
                const why2 = abort()
                if (why2) { at.notSent = why2; return false }
                // From here the write may leave: a crash leaves this record and the plan never runs here again.
                try { record('permit-asked') } catch { at.notSent = 'records-unavailable'; return false }
                t0m = mono()
                t0w = deps.now()
                at.phase = 'permit-asked'
                const answer = await askWithin(signal => deps.api.permit(companyId, execution!.executionId, execution!.secret, k, signal), BROWSER_PLAN_TIMES.permit)
                if (answer.kind === 'refused') { at.permitRefused = answer.code; return false }
                const permit = answer.kind === 'ok' ? parsePermit(answer.value, k) : null
                // StepsLife.tla AppPermitUnanswered: no usable answer within 5 s → never sent.
                if (!permit) { at.notSent = 'permit-unanswered'; return false }
                // A write on what an earlier write made goes only to the id the server recorded (the permit binds it).
                if (permit.createdTarget !== bound) { at.notSent = 'created-target'; return false }
                permitMs = Math.min(permit.validMs, BROWSER_PLAN_TIMES.permit)
                return true
              },
              // StepsLife.tla AppSends / AppStopsBeforeSend: synchronous, right before the request leaves.
              beforeSend() {
                const sinceMono = mono() - t0m
                const sinceWall = deps.now() - t0w
                if (!(sinceMono >= 0 && sinceMono < permitMs && sinceWall >= 0 && sinceWall < permitMs)) { at.notSent = 'permit-late'; return false }
                const why3 = abort()
                if (why3) { at.notSent = why3; return false }
                at.phase = 'sent'
                return true
              },
            })
          } catch {
            outcome = at.phase === 'before-permit' ? { sent: false, stage: 'prepare' } : { sent: true, answer: null }
          } finally {
            gate.disarm()
          }
          // The last check said go: the request may have been ended, so never "not sent" then.
          if (!outcome.sent && at.phase === 'sent') outcome = { sent: true, answer: null }
          if (!outcome.sent) {
            if (at.phase === 'before-permit') return giveBack(at.notSent ?? abort() ?? 'window-closed')
            // StepsLife.tla ServerRefusesPermit: the server settled it (void / partial); nothing to report.
            if (at.permitRefused !== false) {
              try { record('failed', 'permit-refused') } catch { /* nothing was sent either way */ }
              return result('stopped', 'permit-refused', { code: at.permitRefused, executionId: execution.executionId })
            }
            // StepsLife.tla AppPermitUnanswered / AppStopsBeforeSend: the request never left → not_sent.
            states[k - 1] = 'not_sent'
            return settle(k, 'not_sent', at.notSent ?? 'error')
          }
          states[k - 1] = 'permitted'
          // StepsLife.tla AppRereadAfterFails: no answer, an error, a disconnect: it may have arrived.
          if (!outcome.answer) return settle(k, 'unknown', 'no-answer')
          // A create's new id: the site's answer names a candidate; main identifies it (C3) below.
          let madeId: string | null = null
          if (w.verb === 'create_from') {
            let candidate: string | null = null
            try { candidate = writer.createdId!(outcome.answer) } catch { candidate = null }
            if (typeof candidate !== 'string' || !BROWSER_CREATED_ID_RE.test(candidate) || !BROWSER_ID_VALUE_RE.test(candidate)) return settle(k, 'unknown', 'created-unidentified')
            madeId = candidate
          }
          // StepsLife.tla AppReadsAfter: the line's reads and every created object again, between the markers, judged against
          // the prediction of writes 1..k under the plan's account. Only exactly the prediction is done.
          const objects: Record<string, { thing: string; id: string }> = {}
          for (const [j, pw] of writes.slice(0, k).entries()) {
            if (pw.verb !== 'create_from') continue
            const id = j === k - 1 ? madeId : created[pw.as]
            const pr = site.line.read.reads.find(x => x.name === pw.read)!
            if (typeof id !== 'string') return settle(k, 'unknown', 'created-unidentified')
            objects[pw.as] = { thing: pr.thing, id }
          }
          const after = await readLine(objects)
          if (after.status !== 'judged') return settle(k, 'unknown', 'reread-failed')
          for (const [as, o] of Object.entries(objects)) createdReads[as] = { id: o.id, read: after.objects[as] as BrowserThingResult }
          const judged = judgeBrowserWrites(site.line.read, writes.slice(0, k), site.map, before as BrowserReadFacts, after.facts, account, createdReads)
          if (judged.status !== 'as_predicted') return settle(k, 'unknown', judged.status === 'unreadable' ? 'reread-failed' : 'other-state')
          if (w.verb === 'create_from' && madeId) created[w.as] = madeId
          states[k - 1] = 'done'
          try { record('succeeded') } catch { log.warn('[browser] a write\'s result could not be kept') }
          // The next write only once the server kept this one done (StepsLife.tla ServerPermits needs write k−1 done).
          const kept = await report(execution.secret, { index: k, result: 'done', ...(madeId ? { createdId: madeId } : {}) })
          if (!kept) {
            // The server never kept "done": it settles write k as unknown by its time-out and the person confirms it.
            states[k - 1] = 'unknown'
            return result('unknown', 'report-lost', { executionId: execution.executionId })
          }
        }
        return result('succeeded', null, { executionId: execution.executionId })
      } catch (error) {
        log.warn(`[browser] a write run ended unexpectedly (${error instanceof Error ? error.name : 'unknown'})`)
        // Write `step` may have left once its permit was asked; before any permit nothing can have.
        const s = states[step - 1]
        if (step === 0 || s === 'pending' || s === 'done') return giveBack('error')
        return settle(step, 'unknown', 'no-answer')
      } finally {
        if (inAi) { try { await surface.leaveAi() } catch { /* the window is gone */ } }
        busyWindows.delete(windowKey)
      }

      /** Keeps write k's result on this PC and reports it (the secret alone; ≤ 3 tries, the same body). Nothing more is sent. */
      async function settle(k: number, how: 'not_sent' | 'unknown', reason: BrowserWriteRunReason): Promise<BrowserWriteRunResult> {
        states[k - 1] = how
        try { record(how === 'not_sent' ? 'failed' : 'unknown', reason) } catch { log.warn('[browser] a write\'s result could not be kept') }
        const word = REPORT_WORDS[reason] ?? reason
        await report(execution!.secret, { index: k, result: how, ...((BROWSER_REPORT_REASONS as readonly string[]).includes(word) ? { reason: word } : {}) })
        const outcome = how === 'unknown' ? 'unknown' : k === 1 ? 'failed' : 'partial'
        return result(outcome, reason, { executionId: execution!.executionId })
      }
    }
  }

  /** One report, ≤ 3 tries with the same body while unanswered; true when the server kept it (applied or the same). */
  async function report(secret: string, body: Parameters<BrowserLineWritesApi['report']>[1]): Promise<boolean> {
    for (let i = 0; i < REPORT_TRIES; i++) {
      const answer = await ask(() => deps.api.report(secret, body))
      if (answer.kind === 'ok') return isMap(answer.value) && (answer.value.outcome === 'applied' || answer.value.outcome === 'same')
      if (answer.kind === 'refused') return false
    }
    log.warn('[browser] a write\'s report did not reach the server; it settles there by its time-out')
    return false
  }

  return { run }
}

export type BrowserWriteRunner = ReturnType<typeof createBrowserWriteRunner>

async function safeBuild<T>(build: () => Promise<T>): Promise<T | { problem: 'plan' }> {
  try { return await build() } catch { return { problem: 'plan' } }
}

async function ask(call: () => Promise<BrowserLinesAnswer>): Promise<BrowserLinesAnswer> {
  try { return await call() } catch { return { kind: 'no-answer' } }
}

/** One server call given at most `ms`: then it is aborted and counts as no answer, whatever arrives later. */
async function askWithin(call: (signal: AbortSignal) => Promise<BrowserLinesAnswer>, ms: number): Promise<BrowserLinesAnswer> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<BrowserLinesAnswer>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ kind: 'no-answer' }) }, ms) })
  try {
    return await Promise.race([ask(() => call(controller.signal)), late])
  } finally {
    clearTimeout(timer)
  }
}

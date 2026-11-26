// A write task on a registered domain, wired (redesign step ⑤b; agent-browser.md "Writes within frames, in the app";
// design memo §6-1, §6-2, §6-3, D1). The consultation AI asks (`browser_work`: a registered domain, the task in words, a
// company Skill's name or none, the headings it wants back) and gets fixed words when it is over:
//
//   [a Skill] the server's frames run from the approved declaration (`POST /browser-frame-runs { skill }`)
//   → the preview, read only, unless the Skill version is pre-approved and its text unchanged (the operator answers the
//     plan for the card: what, who else, the key values read; ad hoc also the frames in the declaration's grammar)
//   → [ad hoc] the frames run from that plan (`{ plan }`)
//   → the plan card and ［任せる］ (the server's one-time approval value, held here, sent only by the card's press)
//   → the work: the operator presses on, each page write held by the window and sent once (frame-writes.ts)
//   → the after-read (the Skill's `after_read` addresses read again; `{created}` from the answers) → the result card.
//
// One lock per company × domain on the server joins the frames run and the operator's runs (each run names its frames run).
// The page's text, the plan's words, the values read and the site's answers go to the member's card only (kept here in
// memory, per signed-in member); the consultation AI gets `workWordsForAi`. No Electron.
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_BROWSE_LIMITS as BL, browseLogStep, type BrowserBrowseAction, type BrowserBrowseHistoryEntry, type BrowserBrowseStop, type BrowserBrowseSurface, type BrowserPageSnapshot } from '../../../shared/browser-browse'
import {
  BROWSER_WORK_CARD_WORDS as CW, BROWSER_WORK_LIMITS as L, BROWSER_WORK_WORDS as W, afterReadTarget, beforeReadAddress, createdIdOf, parseWorkAnswer,
  topFields, workFrameOf, workMaterial, workPlanSentences, workResultCard, workWordsForAi,
  type AfterReadResult, type WorkAnswer, type WorkEnd, type WorkFrame, type WorkPlanValue,
} from '../../../shared/browser-frame-writes'
import { browserNeverReadFits } from '../../../../shared/core/browser-frame-match'
import { isValidSkillName } from '../../../../shared/core/names'
import { BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, type BrowserRunEndReason, type BrowserRunLogStep, type BrowserRunOutcome, type BrowserRunWriteStep } from '../../../../shared/core/browser-run-log'
import { browserRunBudget, type BrowserRunBudget } from '../../../../shared/core/browser-run-budget'
import type { BrowserFrameRunStart, BrowserFrameView } from '../../../../shared/types/browser-frames'
import type { BrowserPreviewSurface } from '../../../shared/browser-runner'
import type { BrowserWriteGetResult, BrowserWriteResultView, BrowserWriteView } from '../../../shared/browser-line-writes'
import type { BrowserAiSwitch } from './ai-switch'
import type { BrowserContext } from './context'
import { createFrameWriter, type FrameWriteRecord, type FrameWriter } from './frame-writes'
import type { BrowserFramesApi, BrowserLinesAnswer, BrowserRunsApi } from './lines-api'
import type { PreviewOperator, PreviewOperatorCli } from './preview'

export interface BrowserWorkDeps {
  aiSwitch: BrowserAiSwitch
  userId: () => string | null
  context: BrowserContext
  stopped(companyId: string): boolean
  /** The member's open window of the domain as the operator acts on it (controller `browseWindow`), or null. */
  window(companyId: string, host: string): BrowserBrowseSurface | null
  /** The same window's page-less read session (controller `previewWindow`): the after-reads, GET of exactly an address. */
  reader(companyId: string, host: string): BrowserPreviewSurface | null
  registered(companyId: string, host: string): boolean
  api: BrowserRunsApi & BrowserFramesApi
  operator(): PreviewOperator | null
  cliPath(): string
  parentEnv(): Readonly<Record<string, string | undefined>>
  /** A company Skill's steps (its SKILL.md and site notes) from the member's company folder; null when there is none. */
  skillSteps?(companyRoot: string, skill: string): Promise<string | null>
  busyWindows?: Set<string>
  now?: () => number
  monoMs?: () => number
  /** How long the run waits for a write on its way before giving it up as unknown (default 45 s; tests shorten it). */
  idleMaxMs?: number
}

export interface BrowserWorkInput {
  companyId: string
  conversationId: string | null
  companyRoot: string | null
  site: string
  task: string
  skill: string | null
  items: readonly string[]
  signal: AbortSignal
  /** Puts the card's reference (the frames run's id) into the reply. */
  onCard(runId: string): void
}

const STOP_CHECK_MS = 500
const KEPT_CARDS = 100
const IDLE_MAX_MS = 45_000
/** A permit's 5 s and the 30 s after it (the server's window before a write in doubt can be answered about). */
const CONFIRM_AFTER_MS = 35_000

interface Entry {
  userId: string
  companyId: string
  runId: string
  host: string
  phase: BrowserWriteView['phase']
  values: WorkPlanValue[]
  sentences: string[]
  planHash: string | null
  /** The server's one-time approval value: never in a view, a tool's answer or a log. */
  approvalToken: string | null
  card: BrowserWriteView['card']
  readAt: string | null
  message: string | null
  result: BrowserWriteResultView | null
  /** The card's press or ［やめる］, waited for by the run (set while the card is up). */
  decide: ((d: 'approved' | 'cancelled') => void) | null
  /** The write in doubt the person may answer about (the server's write and from when), or null. */
  inDoubt: { write: number; from: string | null; line: string } | null
  /** The consultation the card was made in: the windows that may press it are the ones that show it. */
  conversationId: string | null
  /** A press on its way (［任せる］ or the answer): a second one from another window waits for it, never asks again. */
  pressing: Promise<unknown> | null
}

/** A server refusal → the consultation AI's fixed words. */
function refusedWords(a: Exclude<BrowserLinesAnswer, { kind: 'ok' }>): string {
  if (a.kind === 'no-answer') return W.offline
  const code = a.code ?? ''
  if (code === 'BROWSER_RUN_BUSY') return W.busy
  if (code === 'BROWSER_RUN_TOO_LATE') return W.tooLate
  if (code === 'BROWSER_NOT_ALLOWED') return W.notAllowed
  if (code === 'BROWSER_TYPE_NOT_GRANTED') return W.notGranted
  if (code === 'BROWSER_AI_STOPPED') return W.stopped
  if (code.startsWith('BROWSER_DEVICE_')) return W.pc
  if (code.startsWith('BROWSER_SKILL_')) return W.skill
  return W.failed
}

const frameStartOf = (v: unknown): BrowserFrameRunStart | null => {
  const r = v as BrowserFrameRunStart | null
  return r && typeof r.runId === 'string' && /^bf_[0-9a-f]{32}$/.test(r.runId) && Array.isArray(r.frames) && typeof r.planHash === 'string' ? r : null
}
const workFrames = (frames: readonly BrowserFrameView[]): WorkFrame[] => frames.map(workFrameOf)

export function wireBrowserWork(deps: BrowserWorkDeps) {
  const now = deps.now ?? Date.now
  const busyWindows = deps.busyWindows ?? new Set<string>()
  const entries = new Map<string, Entry>()
  const key = (userId: string, companyId: string, runId: string) => `${userId}|${companyId}|${runId}`
  const keep = (e: Entry) => {
    const k = key(e.userId, e.companyId, e.runId)
    entries.delete(k)
    entries.set(k, e)
    while (entries.size > KEPT_CARDS) entries.delete(entries.keys().next().value as string)
  }

  function viewOf(e: Entry): BrowserWriteView {
    // A write in doubt: ［済んでいた］［されていなかった］ from its time (the server decides at the press).
    const result = e.result && e.inDoubt
      ? { ...e.result, confirm: { from: e.inDoubt.from, canNow: e.inDoubt.from === null || now() >= Date.parse(e.inDoubt.from) } }
      : e.result
    return {
      title: CW.title, siteLabel: e.host, phase: e.phase, values: e.values.map((v, i) => ({ name: `v${i + 1}`, label: v.label, value: v.value, needsConfirm: false, confirmed: false })),
      sentences: [...e.sentences], card: e.card, readAt: e.readAt, contentHash: e.phase === 'ready' ? e.planHash : null, message: e.message,
      result, ...(e.phase === 'ready' ? { cancellable: true } : {}),
    }
  }

  /**
   * One operator loop in the member's window (the preview, read only; or the work, writes held): before every step the
   * server's continue, the page as the operator sees it, its answer parsed strictly, the action done. Ends at a `plan`
   * (preview), `done` (work) or `stop` answer, or with a reason.
   */
  async function operate(o: {
    phase: 'preview' | 'work'
    companyId: string
    browseRunId: string
    host: string
    win: BrowserBrowseSurface
    operator: PreviewOperator
    cli: PreviewOperatorCli
    parentEnv: Readonly<Record<string, string | undefined>>
    task: string
    items: readonly string[]
    steps: string | null
    adhoc: boolean
    frames: () => WorkFrame[] | null
    writes: () => FrameWriteRecord[]
    locked: () => boolean
    cut: AbortController
    /** The run's budget as the server chose it, and when the app stops operating (its start + `operateMs`). */
    budget: Readonly<BrowserRunBudget>
    deadline: number
    current: () => boolean
    log: BrowserRunLogStep[]
  }): Promise<{ kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }> } | { kind: 'end'; reason: BrowserRunEndReason; end: WorkEnd }> {
    const history: BrowserBrowseHistoryEntry[] = []
    let notes = ''
    const interrupted = { kind: 'stopped' as const, why: 'interrupted' as const }
    for (let round = 1; round <= o.budget.steps; round++) {
      // A write that may have been sent without an answer: nothing more in this run.
      if (o.locked()) return { kind: 'end', reason: 'write-unknown', end: { kind: 'unknown' } }
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: interrupted }
      if (!o.win.pageClean()) return { kind: 'end', reason: 'other-frames', end: { kind: 'stopped', why: 'blocked' } }
      const going = await deps.api.runContinue(o.companyId, o.browseRunId)
      if (going.kind !== 'ok') return { kind: 'end', reason: going.kind === 'no-answer' ? 'no-answer' : 'refused', end: interrupted }
      const page: BrowserPageSnapshot | null = await o.win.snapshot()
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: interrupted }
      if (!page) return { kind: 'end', reason: 'blocked', end: { kind: 'stopped', why: 'blocked' } }
      const left = o.deadline - now()
      if (left <= 0) return { kind: 'end', reason: 'timeout', end: interrupted }
      const step = await o.operator.step({
        cli: o.cli, model: o.operator.model, signal: o.cut.signal, timeoutMs: Math.min(BL.roundMs, left), parentEnv: o.parentEnv,
        prompt: o.phase === 'preview' ? 'work-preview' : 'work',
        material: workMaterial({
          phase: o.phase, task: o.task, items: o.items, steps: o.steps, frames: o.frames(), page, history,
          writes: o.writes().map(w => w.outcome), notes, round, rounds: o.budget.steps,
        }),
      })
      if (o.locked()) return { kind: 'end', reason: 'write-unknown', end: { kind: 'unknown' } }
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: interrupted }
      if (!step.ok) return { kind: 'end', reason: 'operator-failed', end: interrupted }
      const parsed = parseWorkAnswer(step.text, { snapshot: page, items: o.items.length, phase: o.phase, adhoc: o.adhoc, domain: o.host })
      if ('problem' in parsed) return { kind: 'end', reason: 'bad-answer', end: interrupted }
      if (parsed.notes !== undefined) notes = parsed.notes
      const answer = parsed.answer
      if (answer.do === 'plan' || answer.do === 'done' || answer.do === 'stop') return { kind: 'answer', answer }
      const action: BrowserBrowseAction = answer
      if (o.log.length < BROWSER_RUN_LIMITS.steps) o.log.push(browseLogStep(action, page, o.host))
      const done = await o.win.act(action, o.cut.signal)
      history.push({ do: action.do, ...('ref' in action ? { ref: action.ref } : {}), outcome: done })
    }
    return { kind: 'end', reason: 'rounds', end: interrupted }
  }

  /** The consultation AI's write task. Off: nothing asked, started or sent. Its words only: never the page's text. */
  async function work(input: BrowserWorkInput): Promise<{ words: string }> {
    const said = (words: string) => ({ words })
    if (!deps.aiSwitch()) return said(W.off)
    const userId = deps.userId()
    if (!userId || !BROWSER_COMPANY_ID_RE.test(input.companyId)) return said(W.failed)
    if (input.skill !== null && !isValidSkillName(input.skill)) return said(W.badInput)
    const { companyId } = input
    const host = input.site
    if (!deps.registered(companyId, host)) return said(W.notAllowed)
    if (deps.stopped(companyId)) return said(W.stopped)
    const win = deps.window(companyId, host)
    const reader = deps.reader(companyId, host)
    if (!win || win.closed() || !reader) return said(W.noWindow)
    const operator = deps.operator()
    if (!operator) return said(W.noOperator)
    const windowKey = `${companyId}\0${host}`
    if (busyWindows.has(windowKey)) return said(W.busy)
    const stillCurrent = deps.context.capture({ companyId, signal: input.signal })
    if (!stillCurrent()) return said(W.stoppedBy.interrupted)
    busyWindows.add(windowKey)

    const conversation = input.conversationId ? { conversationId: input.conversationId } : {}
    const cut = new AbortController()
    const onTurn = () => cut.abort()
    input.signal.addEventListener('abort', onTurn, { once: true })
    const watchStop = setInterval(() => { if (deps.stopped(companyId)) cut.abort() }, STOP_CHECK_MS)
    const current = () => !cut.signal.aborted && stillCurrent() && !deps.stopped(companyId) && !win.closed() && deps.window(companyId, host) === win
    let frameRun: BrowserFrameRunStart | null = null
    let entry: Entry | null = null
    try {
      const resolved = await operator.resolve(deps.cliPath(), deps.parentEnv())
      if (!resolved.ok) return said(W.noOperator)
      const steps = input.skill !== null && input.companyRoot && deps.skillSteps
        ? (await deps.skillSteps(input.companyRoot, input.skill).catch(() => null))?.slice(0, L.steps) ?? null : null

      // When the frames run was asked for: the card waits no longer than the server keeps a waiting run (counted from then).
      let frameAskedAt = now()
      // [a Skill] the server builds the frames from the approved declaration it reads itself.
      if (input.skill !== null) {
        const started = await deps.api.frameStart(companyId, { skill: input.skill, ...conversation })
        if (started.kind !== 'ok') return said(refusedWords(started))
        frameRun = frameStartOf(started.value)
        if (!frameRun || frameRun.host !== host) return said(W.failed)
      }
      const neverRead = frameRun?.neverRead ?? []
      const neverReadFits = (pq: string) => neverRead.some(p => browserNeverReadFits(p, pq))

      // The preview (read only): unless a pre-approved Skill version whose text nobody changed since.
      let plan: Extract<WorkAnswer, { do: 'plan' }> | null = null
      if (!frameRun || frameRun.needsApproval) {
        const previewFinished = { ok: false }
        const previewed = await runOperator({
          phase: 'preview', companyId, host, win, operator, cli: resolved.cli, task: input.task, items: input.items, steps,
          adhoc: frameRun === null, frames: frameRun ? workFrames(frameRun.frames) : null, frameRunId: frameRun?.runId ?? null,
          cut, current, conversation, neverReadFits, writer: null, finished: previewFinished,
        })
        if (previewed.kind === 'refused') return said(previewed.words)
        // The preview's run must have let the domain go before the frames run starts (one lock across both, Codex review).
        if (!previewFinished.ok) return said(W.offline)
        if (previewed.kind === 'end') return said(workWordsForAi(previewed.end, input.items, []))
        if (previewed.answer.do === 'stop') return said(workWordsForAi({ kind: 'stopped', why: previewed.answer.why }, input.items, previewed.answer.unread))
        if (previewed.answer.do !== 'plan') return said(W.failed)
        plan = previewed.answer
        // [ad hoc] the frames from the plan, checked by the server with the declaration's rules; never pre-approvable.
        if (!frameRun) {
          frameAskedAt = now()
          const started = await deps.api.frameStart(companyId, { plan: { domain: host, writes: plan.writes ?? [] }, ...conversation })
          if (started.kind !== 'ok') return said(refusedWords(started))
          frameRun = frameStartOf(started.value)
          if (!frameRun || frameRun.host !== host || !frameRun.needsApproval) return said(W.failed)
        }
      }
      const run = frameRun as BrowserFrameRunStart
      entry = {
        userId, companyId, runId: run.runId, host, phase: run.needsApproval ? 'ready' : 'running', values: plan?.values ?? [],
        sentences: workPlanSentences({ summary: plan?.summary ?? input.task, affects: plan?.affects ?? '', frames: workFrames(run.frames) }),
        planHash: run.planHash, approvalToken: run.approvalToken, card: null, readAt: null, message: null, result: null, decide: null,
        inDoubt: null, conversationId: input.conversationId, pressing: null,
      }
      const e = entry
      keep(e)
      input.onCard(run.runId)

      // The plan card: ［任せる］ (the one-time value, from here only) or ［やめる］, the turn's stop, or the server's 10 minutes.
      if (run.needsApproval) {
        const decision = await new Promise<'approved' | 'cancelled'>((resolve) => {
          const timer = setTimeout(() => resolve('cancelled'), Math.max(0, frameAskedAt + L.approveMs - now()))
          let onCut = () => {}
          const done = (d: 'approved' | 'cancelled') => { clearTimeout(timer); cut.signal.removeEventListener('abort', onCut); e.decide = null; resolve(d) }
          onCut = () => done('cancelled')
          cut.signal.addEventListener('abort', onCut, { once: true })
          e.decide = done
          if (cut.signal.aborted) done('cancelled')
        })
        e.approvalToken = null
        if (decision !== 'approved' || !current()) {
          e.phase = 'failed'
          e.message = decision === 'approved' ? null : CW.stopped
          e.result = resultOf({ kind: 'stopped', why: decision === 'approved' ? 'interrupted' : 'not-approved' }, [], null)
          return said(workWordsForAi({ kind: 'stopped', why: decision === 'approved' ? 'interrupted' : 'not-approved' }, input.items, []))
        }
      }

      // The work: the page's writes held, each sent once within the frames.
      const afterReads = run.afterRead ?? []
      const befores = new Map<string, Array<[string, string]> | null>()
      const readTop = async (address: string): Promise<Array<[string, string]> | null> => {
        try {
          const r = await reader.read(address, cut.signal)
          return r.status === 200 ? topFields(r.body) : null
        } catch {
          return null
        }
      }
      // A literal after-read address is read before anything is written.
      for (const p of afterReads) {
        const a = beforeReadAddress(p, null)
        if (a !== null && !befores.has(p)) befores.set(p, await readTop(a))
      }
      const workLog: BrowserRunLogStep[] = []
      const writer = createFrameWriter({
        companyId, runId: run.runId, host, frames: workFrames(run.frames), api: deps.api,
        going: current, stepsSoFar: () => workLog.length, now, ...(deps.monoMs ? { monoMs: deps.monoMs } : {}),
        // A pattern after-read address the held write fits is read right before it (its "before").
        readBefore: async (heldPath) => {
          for (const p of afterReads) {
            if (befores.has(p)) continue
            const a = beforeReadAddress(p, heldPath)
            if (a !== null) befores.set(p, await readTop(a))
          }
        },
      })
      const worked = await runOperator({
        phase: 'work', companyId, host, win, operator, cli: resolved.cli, task: input.task, items: input.items, steps,
        adhoc: run.source === 'adhoc', frames: () => writer.frames(), frameRunId: run.runId, cut, current, conversation,
        neverReadFits, writer, log: workLog,
      })
      const records = writer.records()
      // The after-read: each declared address, `{created}` from the answers, read again through the read session.
      const doneRecords = records.filter(r => r.outcome === 'done' && r.path !== null)
      const done = doneRecords.map(r => ({ path: r.path as string, created: r.answerText ? createdIdOf(r.answerText) : null }))
      const reads: AfterReadResult[] = []
      if (doneRecords.length > 0) {
        for (const p of afterReads) {
          const target = afterReadTarget(p, done)
          reads.push({
            pattern: p, before: p.includes('{created}') ? 'created' : befores.get(p) ?? null,
            after: target === null ? null : await readTop(target.address),
            // What the write the address came from sent: the card's machine check compares the read with it.
            sent: target === null || target.from === null ? null : doneRecords[target.from].sent,
          })
        }
      }
      const unreadAddresses = reads.filter(r => !r.after).map(r => r.pattern)
      const end: WorkEnd = writer.locked() && records.some(r => r.outcome === 'unknown') ? { kind: 'unknown' }
        : worked.kind === 'refused' ? { kind: 'stopped', why: 'interrupted' }
          : worked.kind === 'end' ? worked.end
            : worked.answer.do === 'done' ? { kind: 'done' } : { kind: 'stopped', why: worked.answer.do === 'stop' ? worked.answer.why : 'blocked' }
      const answer = worked.kind === 'answer' ? worked.answer : null
      const checks = answer?.do === 'done' ? answer.checks : []
      e.card = workResultCard({
        end, summary: answer?.do === 'done' ? answer.result : null,
        writes: records.map(r => ({ line: r.line, outcome: r.outcome, status: r.status })),
        afterReads: reads, checks, comparedName: answer?.do === 'done' ? answer.comparedName : null,
      })
      e.readAt = new Date(now()).toISOString()
      e.phase = 'finished'
      e.result = resultOf(end, records, e.card.headline)
      // The write in doubt the server knows (it had a permit): the person may answer about it on the card, past its window.
      const doubt = records.find(r => r.outcome === 'unknown' && typeof r.write === 'number')
      e.inDoubt = doubt ? { write: doubt.write as number, from: confirmableAt(doubt.permittedAt ?? null), line: doubt.line } : null
      // The server's own time for the answer (and whatever it already knows of that write) drives the card's buttons.
      if (e.inDoubt) await syncDoubt(e)
      const unread = answer && answer.do !== 'plan' ? answer.unread : []
      return said(worked.kind === 'refused' ? worked.words : workWordsForAi(end, input.items, unread, unreadAddresses))
    } finally {
      clearInterval(watchStop)
      input.signal.removeEventListener('abort', onTurn)
      cut.abort()
      if (entry?.decide) entry.decide('cancelled')
      if (entry && entry.phase !== 'finished' && entry.phase !== 'failed') entry.phase = 'failed'
      busyWindows.delete(windowKey)
      // The frames run ends with the task: its unused frames vanish (a write on its way is left to its report or time-out).
      if (frameRun) void deps.api.frameEnd(companyId, frameRun.runId).catch(() => {})
    }
  }

  /** One browse run of the task (the server's run and lock, the window in `ai` mode), its log and lock always told. */
  async function runOperator(o: {
    phase: 'preview' | 'work'
    companyId: string
    host: string
    win: BrowserBrowseSurface
    operator: PreviewOperator
    cli: PreviewOperatorCli
    task: string
    items: readonly string[]
    steps: string | null
    adhoc: boolean
    frames: WorkFrame[] | null | (() => WorkFrame[])
    frameRunId: string | null
    cut: AbortController
    current: () => boolean
    conversation: { conversationId?: string }
    neverReadFits: (pathAndQuery: string) => boolean
    writer: FrameWriter | null
    log?: BrowserRunLogStep[]
    /** Set to whether the server took the run's finish (its log and the lock released), awaited before returning. */
    finished?: { ok: boolean }
  }): Promise<
    | { kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }> }
    | { kind: 'end'; reason: BrowserRunEndReason; end: WorkEnd }
    | { kind: 'refused'; words: string }
  > {
    const started = await deps.api.runStart(o.companyId, { host: o.host, ...o.conversation, ...(o.frameRunId ? { frameRunId: o.frameRunId } : {}), write: true })
    if (started.kind !== 'ok') return { kind: 'refused', words: refusedWords(started) }
    const browseRunId = (started.value as { runId?: unknown } | null)?.runId
    if (typeof browseRunId !== 'string' || !BROWSER_RUN_ID_RE.test(browseRunId)) return { kind: 'refused', words: W.failed }
    // The run's budget is the server's choice (a Skill's approved work gets more room); an older server's answer: standard.
    // It operates no longer than the budget allows and the server said (never past the frames run's end).
    const answered = started.value as { budget?: unknown; operateMs?: unknown } | null
    const budget = browserRunBudget(answered?.budget)
    const told = typeof answered?.operateMs === 'number' && Number.isFinite(answered.operateMs) ? Math.max(0, answered.operateMs) : budget.operateMs
    const deadline = now() + Math.min(budget.operateMs, told)
    const log = o.log ?? []
    const writer = o.writer
    let outcome: BrowserRunOutcome = 'failed'
    let reason: BrowserRunEndReason | undefined
    let entered = false
    try {
      if (!o.current()) { outcome = 'stopped'; reason = 'context-changed'; return { kind: 'end', reason, end: { kind: 'stopped', why: 'interrupted' } } }
      entered = true
      // The preview holds every write and fails it (read only); the work hands each to the writer. A never-read address is refused in both.
      const hooks = {
        holdWrite: writer ? (held: Parameters<FrameWriter['hold']>[0]) => writer.hold(held) : async () => ({ kind: 'fail' as const }),
        neverRead: o.neverReadFits,
        // The window's DevTools connection went while a write was held: the page's original may have gone out on its own.
        detached: () => writer?.abandon('detached'),
      }
      if (!(await o.win.enter(() => deps.stopped(o.companyId) || !o.current(), hooks))) {
        reason = 'refused'
        return { kind: 'end', reason, end: { kind: 'stopped', why: 'blocked' } }
      }
      const got = await operate({
        phase: o.phase, companyId: o.companyId, browseRunId, host: o.host, win: o.win, operator: o.operator, cli: o.cli, parentEnv: deps.parentEnv(),
        task: o.task, items: o.items, steps: o.steps, adhoc: o.adhoc,
        frames: () => (typeof o.frames === 'function' ? o.frames() : o.frames),
        writes: () => writer?.records() ?? [], locked: () => writer?.locked() ?? false,
        cut: o.cut, budget, deadline, current: o.current, log,
      })
      if (got.kind === 'end') {
        outcome = got.end.kind === 'unknown' ? 'failed' : 'stopped'
        reason = got.reason
      } else {
        outcome = got.answer.do === 'stop' ? 'stopped' : 'done'
        if (got.answer.do === 'stop') reason = got.answer.why as BrowserBrowseStop
      }
      return got
    } finally {
      // Nothing more is held; a write on its way finishes (its result recorded) before the window is given back.
      if (writer) {
        writer.close()
        let timer: ReturnType<typeof setTimeout> | undefined
        const idle = await Promise.race([
          writer.idle().then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), deps.idleMaxMs ?? IDLE_MAX_MS) }),
        ])
        clearTimeout(timer)
        // A write still on its way when the wait ran out: kept as unknown (the card, the AI's words, the run log) and the run
        // locked, never counted as done or left out (independent review of #856).
        if (!idle) writer.abandon('timeout')
      }
      if (entered) await o.win.leave().catch(() => {})
      const writes: BrowserRunWriteStep[] = writer?.log() ?? []
      // Awaited: the next phase (the frames run, the work) needs this run's lock released first.
      const finish = (w: BrowserRunWriteStep[]) => deps.api.runFinish(o.companyId, browseRunId, { outcome, ...(reason ? { reason } : {}), steps: log, ...(w.length ? { writes: w } : {}) })
        .catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
      let finished = await finish(writes)
      // An older server knows no `site-refused`: it refuses the whole log as a bad run (and keeps the lock until its lease).
      // Once more with those steps as `unknown` (independent review of #859).
      if (finished.kind === 'refused' && finished.code === 'BROWSER_BAD_RUN' && writes.some(w => w.outcome === 'site-refused')) {
        finished = await finish(writes.map(w => (w.outcome === 'site-refused' ? { ...w, outcome: 'unknown' as const } : w)))
      }
      if (o.finished) o.finished.ok = finished.kind === 'ok'
    }
  }

  /** The write in doubt settled on the card: a person's answer (theirs, or one the server already holds), or the site's late one. */
  function settleDoubt(e: Entry, to: 'done' | 'not_done', headline: string): void {
    const doubt = e.inDoubt
    if (!doubt || !e.result) return
    const unknown = e.result.unknown.filter(l => l !== doubt.line)
    e.result = {
      ...e.result, headline, unknown,
      done: to === 'done' ? [...e.result.done, doubt.line] : e.result.done,
      notDone: to === 'not_done' ? [...e.result.notDone, doubt.line] : e.result.notDone,
      byHand: unknown.map(CW.byHand), confirm: null,
    }
    e.inDoubt = null
  }

  /**
   * Read the run again (`GET /browser-frame-runs/:runId`) and take what the server holds of the write in doubt: an answer
   * already kept (`confirmed`), a late sure answer of the site (its state moved), or its time (`confirmableAt`). Nothing
   * read → as it was.
   */
  async function syncDoubt(e: Entry): Promise<void> {
    const doubt = e.inDoubt
    if (!doubt) return
    const got = await Promise.resolve().then(() => deps.api.frameGet(e.companyId, e.runId)).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
    if (got.kind !== 'ok') return
    const w = (got.value as { writes?: unknown } | null)?.writes
    const write = Array.isArray(w) ? (w as Array<Record<string, unknown>>).find(x => x?.write === doubt.write) : undefined
    if (!write) return
    const confirmed = write.confirmed as { answer?: unknown } | null | undefined
    if (confirmed && (confirmed.answer === 'done' || confirmed.answer === 'not_done')) {
      settleDoubt(e, confirmed.answer, confirmed.answer === 'done' ? CW.confirmedDone : CW.confirmedNotDone)
    } else if (write.state === 'done' || write.state === 'verified') {
      settleDoubt(e, 'done', CW.lateDone)
    } else if (write.state === 'refused') {
      settleDoubt(e, 'not_done', CW.lateRefused)
    } else if (write.state === 'unknown' && typeof write.confirmableAt === 'string' && Number.isFinite(Date.parse(write.confirmableAt))) {
      doubt.from = write.confirmableAt
    }
  }

  /** From when the server takes the person's answer: the permit + 5 s + 30 s (its estimate; it decides on both clocks). */
  function confirmableAt(permittedAt: string | null): string | null {
    const at = permittedAt === null ? Number.NaN : Date.parse(permittedAt)
    return Number.isFinite(at) ? new Date(at + CONFIRM_AFTER_MS).toISOString() : null
  }

  /** The card's result lists (the write card's shape): done, not sent, unknown and what to check by hand. */
  function resultOf(end: WorkEnd, records: readonly FrameWriteRecord[], headline: string | null): BrowserWriteResultView {
    const unknown = records.filter(r => r.outcome === 'unknown').map(r => r.line)
    return {
      outcome: end.kind === 'done' ? 'succeeded' : end.kind === 'unknown' ? 'unknown' : records.some(r => r.outcome === 'done') ? 'partial' : 'stopped',
      headline: headline ?? (end.kind === 'stopped' ? W.stoppedBy[end.why] : CW.stopped),
      done: records.filter(r => r.outcome === 'done').map(r => r.line),
      notDone: records.filter(r => r.outcome === 'not-sent' || r.outcome === 'refused' || r.outcome === 'site-refused').map(r => r.line),
      unknown,
      byHand: unknown.map(CW.byHand),
      confirm: null,
    }
  }

  /** This member's card (the main window's IPC asks it; the renderer never gets the approval value). */
  function mine(userId: string | null, companyId: string, runId: string): Entry | null {
    if (!userId) return null
    return entries.get(key(userId, companyId, runId)) ?? null
  }

  return {
    available: () => deps.aiSwitch(),
    work,
    card(companyId: string, runId: string): BrowserWriteGetResult | null {
      const e = mine(deps.userId(), companyId, runId)
      return e ? { ok: true, view: viewOf(e) } : null
    },
    /**
     * ［任せる］ on the card (a window showing its consultation, the caller checked): the plan's hash the card showed, then the server's
     * approve with the one-time value held here. The AI's tools never reach this.
     */
    async approve(companyId: string, runId: string, planHash: unknown): Promise<BrowserWriteGetResult | null> {
      const e = mine(deps.userId(), companyId, runId)
      if (!e) return null
      if (e.phase !== 'ready' || !e.decide || !e.approvalToken || !e.planHash) return { ok: false, message: 'まだ任せられる状態ではありません。' }
      if (planHash !== e.planHash) return { ok: false, message: 'カードの中身が変わりました。もう一度確かめてください。' }
      // One press wins: the same card shown in a second window answers with the card as it stands (it moves on by itself).
      if (e.pressing) { await e.pressing.catch(() => {}); return { ok: true, view: viewOf(e) } }
      const { planHash: hash, approvalToken: token } = e
      // The whole press (the server's answer and the card's move) is what a second window waits for.
      const done = (async () => {
        const a = await deps.api.frameApprove(companyId, runId, { planHash: hash, approvalToken: token })
        if (a.kind !== 'ok') {
          if (a.kind === 'refused') { e.phase = 'failed'; e.message = refusedWords(a); e.decide?.('cancelled') }
          return
        }
        // The task may have ended meanwhile (the turn stopped, the card's time): the card stays as the task left it.
        if (!e.decide) return
        e.phase = 'running'
        e.decide('approved')
      })()
      e.pressing = done
      await done.finally(() => { e.pressing = null })
      return { ok: true, view: viewOf(e) }
    },
    /**
     * ［済んでいた］／［されていなかった］ on the card (a window showing its consultation, the caller checked): the person's answer about the
     * write in doubt, sent to the server with this PC's key. It never unlocks the run or sends anything again; after
     * 「されていなかった」 the person asks again in the chat (a new run). The AI's tools never reach this.
     */
    async confirm(companyId: string, runId: string, answer: unknown): Promise<BrowserWriteGetResult | null> {
      const e = mine(deps.userId(), companyId, runId)
      if (!e) return null
      if ((answer !== 'done' && answer !== 'not_done') || !e.inDoubt || !e.result) return { ok: false, message: CW.confirmNotNow }
      // One press wins (the card in two windows): the second waits for it and shows the card as it then stands.
      if (e.pressing) { await e.pressing.catch(() => {}); return { ok: true, view: viewOf(e) } }
      const done = (async () => {
        const sent = await deps.api.frameConfirm(companyId, runId, { write: (e.inDoubt as { write: number }).write, answer })
        if (sent.kind === 'ok') settleDoubt(e, answer, answer === 'done' ? CW.confirmedDone : CW.confirmedNotDone)
        else await syncDoubt(e)
        return sent
      })()
      e.pressing = done
      const sent = await done.finally(() => { e.pressing = null })
      // Not taken: the server's word (read again above) decides what the card shows next — already answered, no longer in
      // doubt, its time —, never a loop of 「もう一度押してください」 (independent review of #859).
      if (sent.kind === 'ok' || !e.inDoubt) return { ok: true, view: viewOf(e) }
      if (sent.kind === 'refused' && sent.code === 'BROWSER_TOO_EARLY') return { ok: false, message: CW.confirmTooEarly }
      if (sent.kind === 'refused' && (sent.code === 'BROWSER_FRAME_CONFIRMED' || sent.code === 'BROWSER_FRAME_NOT_UNKNOWN')) {
        // The server holds another answer or state the read could not bring: the card stops asking.
        e.inDoubt = null
        if (e.result) e.result = { ...e.result, confirm: null }
        return { ok: false, message: CW.confirmSettledElsewhere }
      }
      return { ok: false, message: CW.confirmFailed }
    },
    /** ［やめる］: the plan is not approved; the run ends (nothing is written). */
    cancel(companyId: string, runId: string): BrowserWriteGetResult | null {
      const e = mine(deps.userId(), companyId, runId)
      if (!e) return null
      if (e.phase === 'ready' && e.decide) e.decide('cancelled')
      return { ok: true, view: viewOf(e) }
    },
    /** The card's consultation (the caller lets only a window showing it read or press the card). */
    placeOf(companyId: string, runId: string): { conversationId: string | null } | null {
      const e = mine(deps.userId(), companyId, runId)
      return e ? { conversationId: e.conversationId } : null
    },
    clear: () => entries.clear(),
  }
}

export type BrowserWorkWiring = ReturnType<typeof wireBrowserWork>

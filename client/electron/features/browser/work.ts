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
import { BROWSER_BROWSE_LIMITS as BL, aimedAction, browseLogStep, pageWithScreen, type BrowserBrowseAction, type BrowserBrowseHistoryEntry, type BrowserBrowseStop, type BrowserBrowseSurface, type BrowserPageSnapshot } from '../../../shared/browser-browse'
import {
  BROWSER_WORK_CARD_WORDS as CW, BROWSER_WORK_LIMITS as L, BROWSER_WORK_WORDS as W, afterReadTarget, beforeReadAddress, createdIdOf, parseWorkAnswer,
  topFields, workBusyWords, workEndAfterRefusals, workFrameOf, workMaterial, workPlanSentences, workPreviewStoppedCard, workResultCard, workRetrySentence, workStopNext, workWordsForAi,
  type AfterReadResult, type WorkAnswer, type WorkEnd, type WorkFrame, type WorkPlanValue, type WorkStopReason, type WorkWriteSeen,
} from '../../../shared/browser-frame-writes'
import { browserNeverReadFits } from '../../../../shared/core/browser-frame-match'
import { browserSkillRef } from '../../../../shared/core/browser-skill'
import { BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, type BrowserRunEndReason, type BrowserRunLogStep, type BrowserRunOutcome, type BrowserRunWriteStep } from '../../../../shared/core/browser-run-log'
import { browserFrameApproveMs, browserRunBudget, type BrowserRunBudget } from '../../../../shared/core/browser-run-budget'
import type { BrowserFrameRunStart, BrowserFrameView } from '../../../../shared/types/browser-frames'
import type { BrowserPreviewSurface } from '../../../shared/browser-runner'
import { noWindowWords, type BrowserRunWindow } from '../../../shared/browser-operation'
import type { BrowserWriteGetResult, BrowserWriteResultView, BrowserWriteView } from '../../../shared/browser-line-writes'
import type { BrowserInspectionView } from '../../../shared/browser-inspection'
import { answerProblemOf, createOperatorTrail, trailForCard, type BrowserStopNext, type BrowserTrailRun, type OperatorTrailRecorder } from '../../../shared/browser-operator-trail'
import type { BrowserAiSwitch } from './ai-switch'
import type { BrowserContext } from './context'
import { createFrameWriter, type FrameWriteRecord, type FrameWriter } from './frame-writes'
import type { BrowserFramesApi, BrowserLinesAnswer, BrowserRunsApi } from './lines-api'
import { sendEnd, type PendingEnds } from './pending-ends'
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
  /**
   * The window a run needs (controller `windowForRun`, agent-browser.md "The window a run needs"): asked before the run
   * looks for it, so a window closed meanwhile opens again by itself while this app run holds the member's login.
   */
  openWindow?(companyId: string, host: string, signal: AbortSignal): Promise<BrowserRunWindow>
  api: BrowserRunsApi & BrowserFramesApi
  operator(): PreviewOperator | null
  cliPath(): string
  parentEnv(): Readonly<Record<string, string | undefined>>
  /** A company or department Skill's steps (its SKILL.md and site notes) from the member's company folder, by the Skill's path; null when there is none. */
  skillSteps?(companyRoot: string, skill: string): Promise<string | null>
  busyWindows?: Set<string>
  now?: () => number
  monoMs?: () => number
  /** How long the run waits for a write on its way before giving it up as unknown (default 45 s; tests shorten it). */
  idleMaxMs?: number
  /** How long main watches for a write the page starts after an action (default `BROWSER_WORK_LIMITS.writeStartMs`; tests shorten it). */
  writeStartMs?: number
  /** Ends the server did not hear (a lost `end` / `finish`): retried, and flushed before this member's next task. */
  pendingEnds?: PendingEnds
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
  /** The operator's trails (the preview's when there was one, the work's), read live for the card. */
  trails: OperatorTrailRecorder[]
  /** What the stopped card asks of the member first (its question, or the window), or null. */
  next: BrowserStopNext | null
}

/** A server refusal → the consultation AI's fixed words (busy: with roughly when the domain frees up, when the server said). */
function refusedWords(a: Exclude<BrowserLinesAnswer, { kind: 'ok' }>, now: number): string {
  if (a.kind === 'no-answer') return W.offline
  const code = a.code ?? ''
  if (code === 'BROWSER_RUN_BUSY') return workBusyWords(a.freeAt, now)
  if (code === 'BROWSER_RUN_TOO_LATE') return W.tooLate
  if (code === 'BROWSER_NOT_ALLOWED') return W.notAllowed
  if (code === 'BROWSER_TYPE_NOT_GRANTED') return W.notGranted
  if (code === 'BROWSER_AI_STOPPED') return W.stopped
  if (code.startsWith('BROWSER_DEVICE_')) return W.pc
  if (code === 'BROWSER_SKILL_AMBIGUOUS') return W.skillAmbiguous
  if (code.startsWith('BROWSER_SKILL_')) return W.skill
  return W.failed
}

/** A refusal of the operator run's continue → why the card and the AI say it stopped. */
const continueStop = (a: Exclude<BrowserLinesAnswer, { kind: 'ok' }>): WorkStopReason =>
  a.kind === 'no-answer' ? 'network' : a.code === 'BROWSER_AI_STOPPED' ? 'ai-stopped' : a.code === 'BROWSER_RUN_ENDED' ? 'timeout' : 'server-refused'

const frameStartOf = (v: unknown): BrowserFrameRunStart | null => {
  const r = v as BrowserFrameRunStart | null
  return r && typeof r.runId === 'string' && /^bf_[0-9a-f]{32}$/.test(r.runId) && Array.isArray(r.frames) && typeof r.planHash === 'string' ? r : null
}
const workFrames = (frames: readonly BrowserFrameView[]): WorkFrame[] => frames.map(workFrameOf)

/** The trails that did anything, as a view's field (absent when none). */
const trailOf = (trails: readonly OperatorTrailRecorder[]) => {
  const trail = trailForCard(trails.map(t => t.view()))
  return trail ? { trail } : {}
}

/**
 * A stopped preview's view: what it asks of the member first (`next`), the fixed reason once, the operator's trail folded
 * beside it.
 */
const previewStoppedView = (host: string, end: WorkEnd, at: number, trail: BrowserTrailRun, next: BrowserStopNext | null): BrowserInspectionView => ({
  card: workPreviewStoppedCard(end), readAt: new Date(at).toISOString(), siteLabel: host, ...(trailForCard([trail]) ? { trail: [trail] } : {}),
  ...(next ? { next } : {}),
})

/**
 * What the operator asks the member when it stopped on its own word: its `question`, else its stop `reason` (an operator
 * that put the question there, as every one did before the key existed: the incident of 2026-11-27). Outside text, kept for
 * the member's card only (`workStopNext` keeps it only for `need-person`); never in the consultation AI's words or a log.
 */
const operatorQuestion = (answer: { question: string | null }, trail: OperatorTrailRecorder): string | null =>
  answer.question ?? trail.view().end?.reason ?? null

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
      result, ...(e.phase === 'ready' ? { cancellable: true } : {}), ...trailOf(e.trails), ...(e.next ? { next: e.next } : {}),
    }
  }

  // A stopped preview's card (no plan, so no frames run card): named by the preview's operator run (`bo_…`), shown by the
  // generic card through the inspection card's IPC like a read run's; memory only, this member's.
  const previews = new Map<string, BrowserInspectionView>()
  const keepPreview = (userId: string, companyId: string, runId: string, view: BrowserInspectionView) => {
    const k = key(userId, companyId, runId)
    previews.delete(k)
    previews.set(k, view)
    while (previews.size > KEPT_CARDS) previews.delete(previews.keys().next().value as string)
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
    writes: () => WorkWriteSeen[]
    locked: () => boolean
    /** Counts the operator's actions (its history's numbering), so a held write says which one it followed. */
    actions?: { n: number }
    /**
     * Before the page is looked at again: every write the page held is decided (and, right after an action that may make
     * one, a moment for the page's script to start it). False: the wait ran out and the writes still held were given up.
     */
    settleWrites: (afterAction: boolean) => Promise<boolean>
    cut: AbortController
    /** The operator's trail for the member's card only (its actions in the log's kept form, its reasons, notes and end). */
    trail: OperatorTrailRecorder
    /** The run's budget as the server chose it, and when the app stops operating (its start + `operateMs`). */
    budget: Readonly<BrowserRunBudget>
    deadline: number
    current: () => boolean
    /** Why `current()` said no (the AI stop, the member's stop or the consultation closed, the window, the context). */
    whyNot: () => WorkStopReason
    log: BrowserRunLogStep[]
  }): Promise<{ kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }> } | { kind: 'end'; reason: BrowserRunEndReason; end: WorkEnd }> {
    const history: BrowserBrowseHistoryEntry[] = []
    let notes = ''
    // The app's one re-ask after an answer out of its form (fixed words), or null: one per slip, within the run's steps.
    let retry: string | null = null
    const stopped = (why: WorkStopReason) => ({ kind: 'stopped' as const, why })
    // Whether the last thing done was an action that may make the page write (a press, typing, a choice, back).
    let acted = false
    for (let round = 1; round <= o.budget.steps; round++) {
      // The page's writes are decided before the operator sees the page again, so its material never shows a frame's unit
      // taken without the write's result (incident 2026-11-27: the operator could not tell whether its press was sent).
      await o.settleWrites(acted)
      acted = false
      // A write that may have been sent without an answer: nothing more in this run.
      if (o.locked()) return { kind: 'end', reason: 'write-unknown', end: { kind: 'unknown' } }
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: stopped(o.whyNot()) }
      if (!o.win.pageClean()) return { kind: 'end', reason: 'other-frames', end: stopped('blocked') }
      const going = await deps.api.runContinue(o.companyId, o.browseRunId)
      if (going.kind !== 'ok') return { kind: 'end', reason: going.kind === 'no-answer' ? 'no-answer' : 'refused', end: stopped(continueStop(going)) }
      const shown: BrowserPageSnapshot | null = await o.win.snapshot()
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: stopped(o.whyNot()) }
      if (!shown) return { kind: 'end', reason: 'blocked', end: stopped('blocked') }
      // The screen beside the text, its elements marked by number: for this step's operator only, then dropped. Its size
      // goes with the page (a press by position is measured in its pixels).
      const image = (await o.win.screenshot?.(shown)) ?? null
      const page = pageWithScreen(shown, image)
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: stopped(o.whyNot()) }
      const left = o.deadline - now()
      if (left <= 0) return { kind: 'end', reason: 'timeout', end: stopped('timeout') }
      const step = await o.operator.step({
        cli: o.cli, model: o.operator.model, signal: o.cut.signal, timeoutMs: Math.min(BL.roundMs, left), parentEnv: o.parentEnv,
        prompt: o.phase === 'preview' ? 'work-preview' : 'work',
        material: workMaterial({
          phase: o.phase, task: o.task, items: o.items, steps: o.steps, frames: o.frames(), page, history,
          writes: o.writes(), notes, round, rounds: o.budget.steps, retry,
        }),
        image,
      })
      if (o.locked()) return { kind: 'end', reason: 'write-unknown', end: { kind: 'unknown' } }
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: stopped(o.whyNot()) }
      if (!step.ok) return { kind: 'end', reason: 'operator-failed', end: stopped('operator') }
      const parsed = parseWorkAnswer(step.text, { snapshot: page, items: o.items.length, phase: o.phase, adhoc: o.adhoc, domain: o.host })
      if ('problem' in parsed) {
        // Out of form: asked again once (the next of the run's steps, the same page, the rule it broke in fixed words);
        // a second slip in a row ends the run, the card's trail naming the rule.
        const problem = answerProblemOf(parsed.problem)
        if (retry === null && round < o.budget.steps) { retry = workRetrySentence(problem); continue }
        o.trail.problem(problem)
        return { kind: 'end', reason: 'bad-answer', end: stopped('operator') }
      }
      retry = null
      if (parsed.notes !== undefined) notes = parsed.notes
      o.trail.notes(parsed.notes)
      o.trail.unlisted(parsed.unlisted)
      const answer = parsed.answer
      if (answer.do === 'plan' || answer.do === 'done' || answer.do === 'stop') {
        o.trail.end(answer.do, parsed.reason)
        return { kind: 'answer', answer }
      }
      const action: BrowserBrowseAction = answer
      // A press by position or a typing without a ref: what the window's hit-test finds there now; refused → nothing done.
      const aimed = aimedAction(action) ? (await o.win.aim?.(action)) ?? { ok: false as const, why: 'nothing' as const } : undefined
      if (aimed && !aimed.ok) { history.push({ do: action.do, outcome: 'refused', why: aimed.why }); if (o.actions) o.actions.n = history.length; continue }
      const logStep = browseLogStep(action, page, o.host, aimed)
      if (o.log.length < BROWSER_RUN_LIMITS.steps) o.log.push(logStep)
      o.trail.step(logStep, parsed.reason)
      // Counted before the action, so a write its press makes says it followed this one.
      if (o.actions) o.actions.n = history.length + 1
      const done = await o.win.act(action, o.cut.signal)
      acted = action.do !== 'wait' && action.do !== 'go'
      history.push({ do: action.do, ...('ref' in action ? { ref: action.ref } : {}), outcome: done })
    }
    return { kind: 'end', reason: 'rounds', end: stopped('rounds') }
  }

  /** Until every write the writer holds is recorded, or `ms` passed (false). */
  async function idleWithin(writer: FrameWriter, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = await Promise.race([
      writer.idle().then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)) }),
    ])
    clearTimeout(timer)
    return idle
  }

  /**
   * Until every write the writer holds is recorded, at most `idleMaxMs`. A write still on its way when the wait runs out:
   * kept as unknown (the card, the AI's words, the run log) and the run locked and closed — never counted as done or left
   * out, never sent again (independent review of #856).
   */
  async function idleOrGiveUp(writer: FrameWriter): Promise<boolean> {
    const idle = await idleWithin(writer, deps.idleMaxMs ?? IDLE_MAX_MS)
    if (!idle) writer.abandon('timeout')
    return idle
  }

  /** Watches up to `ms` for a write the page holds (returns early once one is held or the run is cut). */
  async function watchForWrite(writer: FrameWriter, ms: number, signal: AbortSignal): Promise<void> {
    const until = performance.now() + ms
    while (writer.sending() === 0 && !signal.aborted && performance.now() < until) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(0, until - performance.now()))))
    }
  }

  /**
   * Between an operator's action and its next look at the page (agent-browser.md "Writes within frames, in the app"), all
   * within one limit (`idleMaxMs`, the end's 45 s): right after an action that may make the page write, a moment
   * (`writeStartMs`, one value for every site) for the page's script to start it; every held write recorded; after the
   * page got its answers, the same moment again for a write it makes next (and its record), as long as it goes on; then
   * the page settles (the window's rule after an action). Past the limit: a write still on its way is given up (unknown,
   * the run locked: false); none on its way → the operator looks at the page as it is.
   */
  async function settleWrites(writer: FrameWriter, win: BrowserBrowseSurface, afterAction: boolean, signal: AbortSignal): Promise<boolean> {
    const limit = performance.now() + (deps.idleMaxMs ?? IDLE_MAX_MS)
    const left = () => limit - performance.now()
    const moment = deps.writeStartMs ?? L.writeStartMs
    let watch = afterAction
    let answered = false
    while (!signal.aborted) {
      if (watch) await watchForWrite(writer, Math.min(moment, left()), signal)
      if (writer.sending() === 0) break
      if (!(await idleWithin(writer, left()))) {
        if (writer.sending() > 0) { writer.abandon('timeout'); return false }
        break
      }
      answered = true
      watch = left() > 0
    }
    if (answered && !signal.aborted) await win.settled?.(signal)
    return true
  }

  /** The consultation AI's write task. Off: nothing asked, started or sent. Its words only: never the page's text. */
  async function work(input: BrowserWorkInput): Promise<{ words: string }> {
    const said = (words: string) => ({ words })
    if (!deps.aiSwitch()) return said(W.off)
    const userId = deps.userId()
    if (!userId || !BROWSER_COMPANY_ID_RE.test(input.companyId)) return said(W.failed)
    if (input.skill !== null && browserSkillRef(input.skill) !== input.skill) return said(W.badInput)
    const { companyId } = input
    const host = input.site
    if (!deps.registered(companyId, host)) return said(W.notAllowed)
    if (deps.stopped(companyId)) return said(W.stopped)
    const operator = deps.operator()
    if (!operator) return said(W.noOperator)
    // The context is taken before the wait for the window, so a sign-in or setting change meanwhile is seen (Codex review).
    const stillCurrent = deps.context.capture({ companyId, signal: input.signal })
    const found = await deps.openWindow?.(companyId, host, input.signal)
    if (found && deps.stopped(companyId)) return said(W.stopped)
    const win = deps.window(companyId, host)
    const reader = deps.reader(companyId, host)
    if (!win || win.closed() || !reader) return said(noWindowWords(W.noWindow, found))
    const windowKey = `${companyId}\0${host}`
    if (busyWindows.has(windowKey)) return said(W.busy)
    if (!stillCurrent()) return said(W.stoppedBy[input.signal.aborted ? 'stop-button' : 'context-changed'])
    busyWindows.add(windowKey)

    const conversation = input.conversationId ? { conversationId: input.conversationId } : {}
    const cut = new AbortController()
    const onTurn = () => cut.abort()
    input.signal.addEventListener('abort', onTurn, { once: true })
    const watchStop = setInterval(() => { if (deps.stopped(companyId)) cut.abort() }, STOP_CHECK_MS)
    const current = () => !cut.signal.aborted && stillCurrent() && !deps.stopped(companyId) && !win.closed() && deps.window(companyId, host) === win
    // The AI stop first (an administrator's stop also ends the turn), then the member's stop or the consultation closed.
    const whyNot = (): WorkStopReason => (deps.stopped(companyId) ? 'ai-stopped' : input.signal.aborted ? 'stop-button'
      : !stillCurrent() ? 'context-changed' : win.closed() || deps.window(companyId, host) !== win ? 'window-closed' : 'context-changed')
    let frameRun: BrowserFrameRunStart | null = null
    let entry: Entry | null = null
    try {
      const resolved = await operator.resolve(deps.cliPath(), deps.parentEnv())
      if (!resolved.ok) return said(W.noOperator)
      // This member's own leftover ends on this company (a lost `end` / `finish`) go first, so the lock they hold is let go.
      await deps.pendingEnds?.flush(userId, companyId)
      // When the frames run was asked for: the card waits no longer than the server keeps a waiting run (counted from then).
      let frameAskedAt = now()
      // [a Skill] the server builds the frames from the approved declaration it reads itself, and says which Skill a name
      // means (its path: the company's or a department's; a name two Skills share is refused, never guessed).
      if (input.skill !== null) {
        const started = await deps.api.frameStart(companyId, { skill: input.skill, ...conversation })
        if (started.kind !== 'ok') return said(refusedWords(started, now()))
        frameRun = frameStartOf(started.value)
        if (!frameRun || frameRun.host !== host) return said(W.failed)
      }
      // The steps of exactly the Skill the server's frames come from (never the name the AI typed).
      const steps = frameRun?.skill && input.companyRoot && deps.skillSteps
        ? (await deps.skillSteps(input.companyRoot, frameRun.skill).catch(() => null))?.slice(0, L.steps) ?? null : null
      const neverRead = frameRun?.neverRead ?? []
      const neverReadFits = (pq: string) => neverRead.some(p => browserNeverReadFits(p, pq))

      // The operator's trails (the preview's, the work's): on the member's card only (agent-browser.md "The operator's trail on the card").
      const previewTrail = createOperatorTrail('preview')
      const workTrail = createOperatorTrail('work')
      // The preview (read only): unless a pre-approved Skill version whose text nobody changed since.
      let plan: Extract<WorkAnswer, { do: 'plan' }> | null = null
      if (!frameRun || frameRun.needsApproval) {
        const previewFinished = { ok: false }
        const previewRan: { runId: string | null } = { runId: null }
        const previewed = await runOperator({
          phase: 'preview', userId, companyId, host, win, operator, cli: resolved.cli, task: input.task, items: input.items, steps,
          adhoc: frameRun === null, frames: frameRun ? workFrames(frameRun.frames) : null, frameRunId: frameRun?.runId ?? null,
          cut, current, whyNot, conversation, neverReadFits, writer: null, trail: previewTrail, finished: previewFinished, ran: previewRan,
        })
        if (previewed.kind === 'refused') return said(previewed.words)
        // A preview that ended without a plan still leaves the member a card: why it stopped (the fixed words) and what the
        // operator tried (its trail), named by the preview's operator run (incident 2026-11-27: a need-person stop left nothing).
        const previewEnd: WorkEnd | null = previewed.kind === 'end' ? previewed.end
          : previewed.answer.do === 'stop' ? { kind: 'stopped', why: previewed.answer.why }
            : previewed.answer.do === 'plan' ? null : { kind: 'stopped', why: 'operator' }
        // Its operator's question (need-person) or the window (need-login) goes first on that card, never to the AI.
        const previewNext = previewEnd && previewed.kind === 'answer' && previewed.answer.do === 'stop'
          ? workStopNext(previewEnd, operatorQuestion(previewed.answer, previewTrail)) : previewEnd ? workStopNext(previewEnd, null) : null
        let asked = false
        if (previewEnd && previewRan.runId && deps.userId() === userId) {
          keepPreview(userId, companyId, previewRan.runId, previewStoppedView(host, previewEnd, now(), previewTrail.view(), previewNext))
          input.onCard(previewRan.runId)
          asked = previewNext?.kind === 'decide'
        }
        // The preview's run must have let the domain go before the frames run starts (one lock across both, Codex review).
        if (!previewFinished.ok) return said(W.offline)
        if (previewed.kind === 'end') return said(workWordsForAi(previewed.end, input.items, []))
        if (previewed.answer.do === 'stop') return said(workWordsForAi({ kind: 'stopped', why: previewed.answer.why }, input.items, previewed.answer.unread, [], asked))
        if (previewed.answer.do !== 'plan') return said(W.failed)
        plan = previewed.answer
        // [ad hoc] the frames from the plan, checked by the server with the declaration's rules; never pre-approvable.
        if (!frameRun) {
          frameAskedAt = now()
          const started = await deps.api.frameStart(companyId, { plan: { domain: host, writes: plan.writes ?? [] }, ...conversation })
          if (started.kind !== 'ok') return said(refusedWords(started, now()))
          frameRun = frameStartOf(started.value)
          if (!frameRun || frameRun.host !== host || !frameRun.needsApproval) return said(W.failed)
        }
      }
      const run = frameRun as BrowserFrameRunStart
      entry = {
        userId, companyId, runId: run.runId, host, phase: run.needsApproval ? 'ready' : 'running', values: plan?.values ?? [],
        sentences: workPlanSentences({ summary: plan?.summary ?? input.task, affects: plan?.affects ?? '', frames: workFrames(run.frames) }),
        planHash: run.planHash, approvalToken: run.approvalToken, card: null, readAt: null, message: null, result: null, decide: null,
        inDoubt: null, conversationId: input.conversationId, pressing: null, trails: plan ? [previewTrail, workTrail] : [workTrail], next: null,
      }
      const e = entry
      keep(e)
      input.onCard(run.runId)

      // The plan card: ［任せる］ (the one-time value, from here only) or ［やめる］, the turn's stop, or the server's 10 minutes.
      if (run.needsApproval) {
        const decision = await new Promise<'approved' | 'cancelled'>((resolve) => {
          const timer = setTimeout(() => resolve('cancelled'), Math.max(0, frameAskedAt + browserFrameApproveMs(input.skill !== null ? 'skill' : 'adhoc') - now()))
          let onCut = () => {}
          const done = (d: 'approved' | 'cancelled') => { clearTimeout(timer); cut.signal.removeEventListener('abort', onCut); e.decide = null; resolve(d) }
          onCut = () => done('cancelled')
          cut.signal.addEventListener('abort', onCut, { once: true })
          e.decide = done
          if (cut.signal.aborted) done('cancelled')
        })
        e.approvalToken = null
        if (decision !== 'approved' || !current()) {
          // The card dismissed or its time over → not approved; anything else that ended the wait says its own reason.
          const why: WorkStopReason = decision === 'approved' || cut.signal.aborted ? whyNot() : 'not-approved'
          e.phase = 'failed'
          // The result's headline says why, once (no second box repeating that it stopped).
          e.result = resultOf({ kind: 'stopped', why }, [], null)
          return said(workWordsForAi({ kind: 'stopped', why }, input.items, []))
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
      const actions = { n: 0 }
      const writer = createFrameWriter({
        companyId, runId: run.runId, host, frames: workFrames(run.frames), api: deps.api,
        going: current, stepsSoFar: () => workLog.length, actionsSoFar: () => actions.n, now, ...(deps.monoMs ? { monoMs: deps.monoMs } : {}),
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
        phase: 'work', userId, companyId, host, win, operator, cli: resolved.cli, task: input.task, items: input.items, steps,
        adhoc: run.source === 'adhoc', frames: () => writer.frames(), frameRunId: run.runId, cut, current, whyNot, conversation,
        neverReadFits, writer, log: workLog, trail: workTrail, actions,
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
      // A held write refused as outside the frames is why the operator then stopped: said first (incident 2026-11-27).
      const end: WorkEnd = writer.locked() && records.some(r => r.outcome === 'unknown') ? { kind: 'unknown' }
        : worked.kind === 'refused' ? { kind: 'stopped', why: worked.why }
          : workEndAfterRefusals(worked.kind === 'end' ? worked.end
            : worked.answer.do === 'done' ? { kind: 'done' } : { kind: 'stopped', why: worked.answer.do === 'stop' ? worked.answer.why : 'blocked' }, records.map(r => r.outcome))
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
      // The operator's question (need-person) or the window (need-login) first on the card; the AI hears only that it asks.
      // After any held write the answers are not offered (a new run would start the work over: Codex review).
      e.next = workStopNext(end, answer?.do === 'stop' ? operatorQuestion(answer, workTrail) : null, records.length)
      // The write in doubt the server knows (it had a permit): the person may answer about it on the card, past its window.
      const doubt = records.find(r => r.outcome === 'unknown' && typeof r.write === 'number')
      e.inDoubt = doubt ? { write: doubt.write as number, from: confirmableAt(doubt.permittedAt ?? null), line: doubt.line } : null
      // The server's own time for the answer (and whatever it already knows of that write) drives the card's buttons.
      if (e.inDoubt) await syncDoubt(e)
      const unread = answer && answer.do !== 'plan' ? answer.unread : []
      return said(worked.kind === 'refused' ? worked.words : workWordsForAi(end, input.items, unread, unreadAddresses, e.next?.kind === 'decide'))
    } finally {
      clearInterval(watchStop)
      input.signal.removeEventListener('abort', onTurn)
      cut.abort()
      if (entry?.decide) entry.decide('cancelled')
      if (entry && entry.phase !== 'finished' && entry.phase !== 'failed') entry.phase = 'failed'
      busyWindows.delete(windowKey)
      // The frames run ends with the task: its unused frames vanish (a write on its way is left to its report or time-out).
      // An end lost to the network is kept and sent again until the run's own hour (agent-browser.md "Letting a domain go").
      if (frameRun) {
        const ending = frameRun
        const until = Date.parse(ending.expiresAt)
        void sendEnd(deps.pendingEnds, { runId: ending.runId, userId, companyId, until: Number.isFinite(until) ? until : now() }, () => deps.api.frameEnd(companyId, ending.runId))
      }
    }
  }

  /** One browse run of the task (the server's run and lock, the window in `ai` mode), its log and lock always told. */
  async function runOperator(o: {
    phase: 'preview' | 'work'
    userId: string
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
    whyNot: () => WorkStopReason
    conversation: { conversationId?: string }
    neverReadFits: (pathAndQuery: string) => boolean
    writer: FrameWriter | null
    log?: BrowserRunLogStep[]
    actions?: { n: number }
    trail: OperatorTrailRecorder
    /** Set to whether the server took the run's finish (its log and the lock released), awaited before returning. */
    finished?: { ok: boolean }
    /** Set to the operator run's id once the server gave it (a stopped preview's card is named by it). */
    ran?: { runId: string | null }
  }): Promise<
    | { kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }> }
    | { kind: 'end'; reason: BrowserRunEndReason; end: WorkEnd }
    | { kind: 'refused'; words: string; why: WorkStopReason }
  > {
    const started = await deps.api.runStart(o.companyId, { host: o.host, ...o.conversation, ...(o.frameRunId ? { frameRunId: o.frameRunId } : {}), write: true })
    if (started.kind !== 'ok') return { kind: 'refused', words: refusedWords(started, now()), why: started.kind === 'no-answer' ? 'network' : 'server-refused' }
    const browseRunId = (started.value as { runId?: unknown } | null)?.runId
    if (typeof browseRunId !== 'string' || !BROWSER_RUN_ID_RE.test(browseRunId)) return { kind: 'refused', words: W.failed, why: 'server-refused' }
    if (o.ran) o.ran.runId = browseRunId
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
      if (!o.current()) { outcome = 'stopped'; reason = 'context-changed'; return { kind: 'end', reason, end: { kind: 'stopped', why: o.whyNot() } } }
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
        writes: () => writer?.seen() ?? [], locked: () => writer?.locked() ?? false, ...(o.actions ? { actions: o.actions } : {}),
        settleWrites: (afterAction: boolean) => (writer ? settleWrites(writer, o.win, afterAction, o.cut.signal) : Promise.resolve(true)),
        cut: o.cut, trail: o.trail, budget, deadline, current: o.current, whyNot: o.whyNot, log,
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
      // Nothing more is held; a write on its way finishes (its result recorded) before the window is given back — unless
      // the run already gave its writes up (a wait during the work ran out: they are kept unknown, never waited for twice).
      if (writer) {
        writer.close()
        if (!writer.gaveUp()) await idleOrGiveUp(writer)
      }
      if (entered) await o.win.leave().catch(() => {})
      const writes: BrowserRunWriteStep[] = writer?.log() ?? []
      // Awaited: the next phase (the frames run, the work) needs this run's lock released first.
      const finish = (w: BrowserRunWriteStep[]) => deps.api.runFinish(o.companyId, browseRunId, { outcome, ...(reason ? { reason } : {}), steps: log, ...(w.length ? { writes: w } : {}) })
        .catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
      const finishAll = async (): Promise<BrowserLinesAnswer> => {
        const first = await finish(writes)
        // An older server knows no `site-refused`: it refuses the whole log as a bad run (and keeps the lock until its lease).
        // Once more with those steps as `unknown` (independent review of #859).
        if (first.kind === 'refused' && first.code === 'BROWSER_BAD_RUN' && writes.some(w => w.outcome === 'site-refused')) {
          return finish(writes.map(w => (w.outcome === 'site-refused' ? { ...w, outcome: 'unknown' as const } : w)))
        }
        return first
      }
      // Not heard (the network): kept and sent again until its lease is surely over — the lock goes with it, and a run past
      // its lease counts as ended on the server anyway (agent-browser.md "Letting a domain go").
      const finished = await sendEnd(deps.pendingEnds, { runId: browseRunId, userId: o.userId, companyId: o.companyId, until: now() + BROWSER_RUN_LIMITS.leaseMs }, finishAll)
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
      headline: headline ?? (end.kind === 'stopped' ? W.stoppedBy[end.why] : end.kind === 'unknown' ? CW.unknown : CW.done),
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
          if (a.kind === 'refused') { e.phase = 'failed'; e.message = refusedWords(a, now()); e.decide?.('cancelled') }
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
    /** A stopped preview's card (a `bo_` id; the inspection card's IPC asks it after the read runs' cards). */
    previewCard(userId: string, companyId: string, runId: string): BrowserInspectionView | undefined {
      return previews.get(key(userId, companyId, runId))
    },
    clear: () => { entries.clear(); previews.clear() },
  }
}

export type BrowserWorkWiring = ReturnType<typeof wireBrowserWork>

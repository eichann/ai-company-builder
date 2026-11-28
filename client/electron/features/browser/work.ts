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
// **The run's promise** (agent-browser.md "The run's promise"): before the plan card (or, for a pre-approved Skill, before
// the work) the run's promise is made on the server from what the person approved — their own values, the preview's values
// the card shows, a stopped card's answer this run continues — as digests under a key this wiring holds for the run alone;
// a write outside it is asked about on the card (［書いてよい］／［書かない］) while the page waits.
//
// One lock per company × domain on the server joins the frames run and the operator's runs (each run names its frames run).
// The page's text, the plan's words, the values read and the site's answers go to the member's card only (kept here in
// memory, per signed-in member); the consultation AI gets `workWordsForAi`. No Electron.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_BROWSE_LIMITS as BL, aimedAction, browseHistoryEntry, browseLogStep, pageWithScreen, type BrowserBrowseAction, type BrowserBrowseHistoryEntry, type BrowserBrowseStop, type BrowserBrowseSurface, type BrowserOperatorImage, type BrowserPageSnapshot } from '../../../shared/browser-browse'
import {
  BROWSER_WORK_CARD_WORDS as CW, BROWSER_WORK_LIMITS as L, BROWSER_WORK_WORDS as W, afterReadTarget, beforeReadAddress, createdIdOf, parseWorkAnswer,
  readBackLanded, readBackUnchanged, topFields, workBusinessOf, workBusyWords, workEndAfterRefusals, workFrameOf, workMaterial, workPlanSentences, workPreviewStoppedCard, workResultCard, workRetrySentence, workStopNext,
  workWordsForAi, workWriteLine,
  type AfterReadResult, type WorkAnswer, type WorkApprovedPlan, type WorkEnd, type WorkFrame, type WorkPerson, type WorkPlanValue, type WorkStopReason, type WorkWriteSeen,
} from '../../../shared/browser-frame-writes'
import { browserNeverReadFits } from '../../../../shared/core/browser-frame-match'
import { browserSkillRef } from '../../../../shared/core/browser-skill'
import { browserSkillStepsCheck, type BrowserSkillStepsText } from '../../../../shared/core/browser-skill-steps'
import { BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, type BrowserRunEndReason, type BrowserRunLogStep, type BrowserRunOutcome, type BrowserRunWriteStep } from '../../../../shared/core/browser-run-log'
import { browserFrameApproveMs, browserRunBudget, type BrowserRunBudget } from '../../../../shared/core/browser-run-budget'
import type { BrowserFrameRunStart, BrowserFrameView } from '../../../../shared/types/browser-frames'
import type { BrowserPreviewSurface } from '../../../shared/browser-runner'
import { noWindowWords, type BrowserRunWindow } from '../../../shared/browser-operation'
import type { BrowserWriteGetResult, BrowserWriteResultView, BrowserWriteView } from '../../../shared/browser-line-writes'
import type { BrowserInspectionView } from '../../../shared/browser-inspection'
import { answerProblemOf, browserStopScreen, createOperatorTrail, trailForCard, type BrowserStopNext, type BrowserStopScreen, type BrowserTrailRun, type OperatorTrailRecorder } from '../../../shared/browser-operator-trail'
import { DEFAULT_BROWSER_OPERATOR_TOOLSET, readToolsetAnswer, toolsetHistory, type BrowserOperatorToolset } from '../../../shared/browser-operator-toolsets'
import type { BrowserAiSwitch } from './ai-switch'
import type { BrowserContext } from './context'
import { createFrameWriter, type FrameWriteRecord, type FrameWriter, type PromiseAsk, type WriterPromise } from './frame-writes'
import { browserPromiseState, buildBrowserRunPromise, type BrowserRunPromiseAddition, type BrowserRunPromiseInput } from '../../../../shared/core/browser-run-promise'
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
  /**
   * A company or department Skill's steps (its SKILL.md and site notes, joined by the core's rule) from the member's company
   * folder, by the Skill's path; null when the path is no Skill place. Checked against the server's seal before use.
   */
  skillSteps?(companyRoot: string, skill: string): Promise<BrowserSkillStepsText | null>
  busyWindows?: Set<string>
  now?: () => number
  monoMs?: () => number
  /** How long the run waits for a write on its way before giving it up as unknown (default 45 s; tests shorten it). */
  idleMaxMs?: number
  /** How long main watches for a write the page starts after an action (default `BROWSER_WORK_LIMITS.writeStartMs`; tests shorten it). */
  writeStartMs?: number
  /** How long after a press that made no write yet the next press waits (default `BROWSER_WORK_LIMITS.pressGapMs`; tests shorten it). */
  pressGapMs?: number
  /** Ends the server did not hear (a lost `end` / `finish`): retried, and flushed before this member's next task. */
  pendingEnds?: PendingEnds
  /**
   * This PC's tool set for the operator (agent-browser.md "The operator's tool sets"), read once per request (its preview
   * and its work use the same); absent: `current`.
   */
  toolset?: () => BrowserOperatorToolset
  /** This PC's log (which tool set each operator run used; agent-browser.md "The operator's tool sets"); absent: the console. */
  log?: Pick<Console, 'info'>
}

export interface BrowserWorkInput {
  companyId: string
  conversationId: string | null
  companyRoot: string | null
  site: string
  task: string
  skill: string | null
  /** What the person said: their prohibitions and limits, and values (the operator's first source; absent = none). */
  said?: readonly string[]
  values?: ReadonlyArray<{ label: string; value: string }>
  /**
   * The stopped card this request continues (its `bo_` / `bf_` id), which the member answered ［そのまま進める］ here
   * (agent-browser.md "The stopped card's answer"); absent / null: none.
   */
  decision?: string | null
  items: readonly string[]
  signal: AbortSignal
  /** Puts the card's reference (the frames run's id) into the reply. */
  onCard(runId: string): void
}

const STOP_CHECK_MS = 500
const KEPT_CARDS = 100
/** How long a stopped card's answer may be continued (the member's ［そのまま進める］ → the AI's new request). */
const DECISION_MS = 30 * 60_000
/** How long the card waits for the person's ［書いてよい］／［書かない］ about a write outside the promise (never past the run). */
const ASK_MS = 10 * 60_000
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
  /**
   * The write in doubt the person may answer about (the server's write and from when), or null. `runId`: the frames run it
   * belongs to when not this card's own (the write ledger: an earlier request's write, asked before this one writes).
   */
  inDoubt: { write: number; from: string | null; line: string; runId?: string } | null
  /** How the last write in doubt was settled: the person's answer or the site's (done / not_done), or `gone` (answered elsewhere). */
  doubtSettled: 'done' | 'not_done' | 'gone' | null
  /** The consultation the card was made in: the windows that may press it are the ones that show it. */
  conversationId: string | null
  /** A press on its way (［任せる］ or the answer): a second one from another window waits for it, never asks again. */
  pressing: Promise<unknown> | null
  /** The operator's trails (the preview's when there was one, the work's), read live for the card. */
  trails: OperatorTrailRecorder[]
  /** What the stopped card asks of the member first (its question, or the window), or null. */
  next: BrowserStopNext | null
  /** The screen the operator last looked at when it stopped to ask (beside `next` only; memory only). */
  screen: BrowserStopScreen | null
  /** A write outside the run's promise the card asks about now (its line and items; the person's card only), or null. */
  ask?: { line: string; items: string[] } | null
  /** The card's ［書いてよい］／［書かない］, waited for by the writer (set while `ask` is up). */
  answerAsk?: ((allow: boolean) => void) | null
}

/**
 * A stopped card that asks the member to decide (agent-browser.md "The stopped card's answer"): what the next request must
 * match to continue it — the site, the Skill as the AI named it, the consultation — and the operator's question, which goes
 * back only to the next run's operator (never to the consultation AI). `choice` once the member pressed.
 */
interface Decidable { host: string; skill: string | null; conversationId: string | null; question: string; choice: 'proceed' | 'stop' | null; at: number; used: boolean }

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
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
/** The screen the operator stopped on, as its card keeps it (memory only). */
const stopScreen = (image: BrowserOperatorImage | null | undefined) => browserStopScreen(image, bytes => Buffer.from(bytes).toString('base64'))
/** A short wait that ends at once when the run is cut. */
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

/** The trails that did anything, as a view's field (absent when none). */
const trailOf = (trails: readonly OperatorTrailRecorder[]) => {
  const trail = trailForCard(trails.map(t => t.view()))
  return trail ? { trail } : {}
}

/**
 * A stopped preview's view: what it asks of the member first (`next`), the fixed reason once, the operator's trail folded
 * beside it.
 */
const previewStoppedView = (host: string, end: WorkEnd, at: number, trail: BrowserTrailRun, next: BrowserStopNext | null, screen: BrowserStopScreen | null): BrowserInspectionView => ({
  card: workPreviewStoppedCard(end), readAt: new Date(at).toISOString(), siteLabel: host, ...(trailForCard([trail]) ? { trail: [trail] } : {}),
  ...(next ? { next, ...(screen ? { screen } : {}) } : {}),
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
      result, ...(e.phase === 'ready' ? { cancellable: true } : {}), ...trailOf(e.trails), ...(e.next ? { next: e.next, ...(e.screen ? { screen: e.screen } : {}) } : {}),
      ...(e.ask ? { ask: { line: e.ask.line, items: [...e.ask.items] } } : {}),
    }
  }

  /** Stopped cards that ask the member to decide, and their answers (main's memory, per member; agent-browser.md "The stopped card's answer"). */
  const decidables = new Map<string, Decidable>()
  const keepDecidable = (userId: string, companyId: string, cardId: string, d: Omit<Decidable, 'choice' | 'at' | 'used'>) => {
    const k = key(userId, companyId, cardId)
    decidables.delete(k)
    decidables.set(k, { ...d, choice: null, at: now(), used: false })
    while (decidables.size > KEPT_CARDS) decidables.delete(decidables.keys().next().value as string)
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
    /** The request's tool set: what the operator is told and how its answer is read (agent-browser.md "The operator's tool sets"). */
    toolset: BrowserOperatorToolset
    cli: PreviewOperatorCli
    parentEnv: Readonly<Record<string, string | undefined>>
    task: string
    person: WorkPerson
    items: readonly string[]
    steps: string | null
    /** A Skill's run: the consultation AI's request is not handed to the operator. */
    skill: boolean
    /** The work's approved plan (null: no preview). */
    plan: WorkApprovedPlan | null
    adhoc: boolean
    frames: () => WorkFrame[] | null
    writes: () => WorkWriteSeen[]
    locked: () => boolean
    /** How many held writes are being sent now (0 in the preview). */
    sending?: () => number
    /**
     * Before a press, typing or choice that follows one which has made no write yet (`since`: the writes held so far when
     * that one was done; `at`: when): waits until `pressGapMs` after it for a write the page may still start. True when a
     * write came meanwhile (the press is then not done: the operator sees it first).
     */
    writeCameLate?: (since: number, at: number) => Promise<boolean>
    /** Every write held in the run so far (what a press's later write is told apart by). */
    heldCount?: () => number
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
  }): Promise<{ kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }>; screen: BrowserOperatorImage | null } | { kind: 'end'; reason: BrowserRunEndReason; end: WorkEnd }> {
    const history: BrowserBrowseHistoryEntry[] = []
    let notes = ''
    // The app's one re-ask after an answer out of its form (fixed words), or null: one per slip, within the run's steps.
    let retry: string | null = null
    const stopped = (why: WorkStopReason) => ({ kind: 'stopped' as const, why })
    // Whether the last thing done was an action that may make the page write (a press, typing, a choice, back).
    let acted = false
    // The last such action actually done: the writes held so far then, and when (a later press waits for its write).
    let lastPress: { since: number; at: number } | null = null
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
        prompt: o.phase === 'preview' ? 'work-preview' : 'work', toolset: o.toolset,
        material: workMaterial({
          phase: o.phase, request: o.task, person: o.person, skill: o.skill, items: o.items, steps: o.steps, plan: o.plan, frames: o.frames(), page,
          history: toolsetHistory(o.toolset, history),
          writes: o.writes(), notes, round, rounds: o.budget.steps, retry,
        }),
        image,
      })
      if (o.locked()) return { kind: 'end', reason: 'write-unknown', end: { kind: 'unknown' } }
      if (!o.current()) return { kind: 'end', reason: 'context-changed', end: stopped(o.whyNot()) }
      if (!step.ok) return { kind: 'end', reason: 'operator-failed', end: stopped('operator') }
      const read = readToolsetAnswer(o.toolset, step.text, { page, history, host: o.host })
      const parsed = 'problem' in read ? read : parseWorkAnswer(read.text, { snapshot: page, items: o.items.length, phase: o.phase, adhoc: o.adhoc, domain: o.host })
      if ('problem' in parsed) {
        // Out of form: asked again once (the next of the run's steps, the same page, the rule it broke in fixed words);
        // a second slip in a row ends the run, the card's trail naming the rule.
        const problem = answerProblemOf(parsed.problem)
        if (retry === null && round < o.budget.steps) { retry = workRetrySentence(problem, o.toolset); continue }
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
        // The screen this answer was given on: what a stopped card shows the member (memory only).
        return { kind: 'answer', answer, screen: image }
      }
      const action: BrowserBrowseAction = answer
      const mayWrite = action.do !== 'wait' && action.do !== 'go'
      // After the held writes: while one is being sent, nothing that could make another write is done (a press queued
      // behind it would be sent as a second write: seen on a real window); a press after one that has made no write yet
      // first waits, up to `pressGapMs` after it, for a write that page may still start — one that comes is shown first.
      // Only reading (`go`) and waiting pass. Told in fixed words.
      if (mayWrite && ((o.sending?.() ?? 0) > 0 || (lastPress && (o.heldCount?.() ?? 0) === lastPress.since && await o.writeCameLate?.(lastPress.since, lastPress.at)))) {
        history.push({ do: action.do, ...('ref' in action ? { ref: action.ref } : {}), outcome: 'refused', why: 'sending' })
        continue
      }
      // A press by position or a typing without a ref: what the window's hit-test finds there now; refused → nothing done.
      const aimed = aimedAction(action) ? (await o.win.aim?.(action)) ?? { ok: false as const, why: 'nothing' as const } : undefined
      if (aimed && !aimed.ok) { history.push({ do: action.do, outcome: 'refused', why: aimed.why }); continue }
      const logStep = browseLogStep(action, page, o.host, aimed)
      if (o.log.length < BROWSER_RUN_LIMITS.steps) o.log.push(logStep)
      o.trail.step(logStep, parsed.reason)
      // A write names the last action that could have made it: set before a press, typing, choice or back is done (a write
      // held during a wait, a read or a refused action names the press before it).
      if (mayWrite) {
        if (o.actions) o.actions.n = history.length + 1
        lastPress = { since: o.heldCount?.() ?? 0, at: performance.now() }
      }
      const done = await o.win.act(action, o.cut.signal)
      acted = mayWrite
      history.push(browseHistoryEntry(action, done))
    }
    return { kind: 'end', reason: 'rounds', end: stopped('rounds') }
  }

  /** Until every write the writer holds is recorded, or `ms` passed or the run was cut (false). */
  async function idleWithin(writer: FrameWriter, ms: number, signal?: AbortSignal): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onCut = () => {}
    const idle = await Promise.race([
      writer.idle().then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms))
        onCut = () => resolve(false)
        if (signal?.aborted) resolve(false)
        else signal?.addEventListener('abort', onCut, { once: true })
      }),
    ])
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCut)
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

  /** Watches up to `ms` for a write the page holds (returns early once one was held since `since`, or the run is cut). */
  async function watchForWrite(writer: FrameWriter, since: number, ms: number, signal: AbortSignal): Promise<void> {
    const until = performance.now() + ms
    while (writer.heldCount() === since && !signal.aborted && performance.now() < until) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(0, until - performance.now()))))
    }
  }

  /**
   * Between an operator's action and its next look at the page (agent-browser.md "Writes within frames, in the app"), all
   * within one limit (`idleMaxMs`, the end's 45 s): right after an action that may make the page write, a moment
   * (`writeStartMs`, one value for every site) for the page's script to start it; every held write recorded; after the
   * page got its answers, the same moment again for a write it makes next (and its record), as long as it goes on; then
   * the page settles (the window's rule after an action). A write that came and went between two looks counts as one
   * (`heldCount`: Codex review). Past the limit: a write still on its way is given up (unknown, the run locked: false);
   * none on its way → the operator looks at the page as it is.
   */
  async function settleWrites(writer: FrameWriter, win: BrowserBrowseSurface, afterAction: boolean, signal: AbortSignal): Promise<boolean> {
    let limitFrom = performance.now()
    let limit = limitFrom + (deps.idleMaxMs ?? IDLE_MAX_MS)
    const left = () => limit - performance.now()
    const moment = deps.writeStartMs ?? L.writeStartMs
    let watch = afterAction
    let answered = false
    // The wait for a write's record ran out (the limit or a stop): decided here, never by reading the clock again — a
    // timer may fire a moment before `performance.now()` reaches the limit (CI, Linux).
    let ranOut = false
    while (!signal.aborted) {
      const since = writer.heldCount()
      if (watch) await watchForWrite(writer, since, Math.min(moment, left()), signal)
      if (writer.sending() > 0) {
        if (!(await idleWithin(writer, left(), signal))) {
          // A write waiting for the person's answer on the card is not on its way: its wait is the card's (it ends by the
          // person, the card's time or the run's stop), so the limit starts again once it is answered.
          // A question answered during this wait: the send after it gets its own whole limit from the answer (Codex review).
          if (!signal.aborted && (writer.asking() > 0 || writer.askEnded() > limitFrom)) {
            limitFrom = writer.asking() > 0 ? performance.now() : writer.askEnded()
            limit = limitFrom + (deps.idleMaxMs ?? IDLE_MAX_MS)
            continue
          }
          ranOut = true
          break
        }
      } else if (writer.heldCount() === since) break
      // The page got answers (or refusals): it may go on with another write — the same moment again, within the limit.
      answered = true
      watch = left() > 0
    }
    // Past the limit or cut by a stop with a write still on its way: given up as at the end (unknown, the run locked).
    if (writer.sending() > 0 && (ranOut || signal.aborted)) { writer.abandon('timeout'); return false }
    if (answered && !signal.aborted) await win.settled?.(signal)
    return true
  }

  /**
   * Before a press that follows one which has made no write yet: watches until `pressGapMs` after that press for a write
   * the page may still start (none held since `since`). True when one came (then the press is not done this round).
   */
  async function writeCameLate(writer: FrameWriter, since: number, at: number, signal: AbortSignal): Promise<boolean> {
    const rest = at + (deps.pressGapMs ?? L.pressGapMs) - performance.now()
    if (rest > 0) await watchForWrite(writer, since, rest, signal)
    return writer.heldCount() !== since
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
    // A stopped card this request continues: the member answered it here, for this site and Skill, not used yet, in time.
    // Its question goes back only to the next operator, never to the consultation AI (agent-browser.md "The stopped card's answer").
    let decided: { question: string; answer: 'proceed' } | null = null
    let decision: Decidable | null = null
    if (input.decision !== undefined && input.decision !== null) {
      const d = decidables.get(key(userId, companyId, input.decision))
      if (!d || d.used || d.choice !== 'proceed' || d.host !== host || d.skill !== input.skill || now() - d.at > DECISION_MS
        || (d.conversationId !== null && d.conversationId !== input.conversationId)) return said(W.badDecision)
      // Used once the run really starts (below): a refusal before that (no window, busy, the Skill) keeps the answer.
      decision = d
      decided = { question: d.question, answer: 'proceed' }
    }
    const operator = deps.operator()
    if (!operator) return said(W.noOperator)
    // One tool set for the request's preview and work: only what the operator is told and how its answer is read.
    const toolset = deps.toolset?.() ?? DEFAULT_BROWSER_OPERATOR_TOOLSET
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
      // The run's card was put into the reply (once: the write ledger's question may put it there before the plan card).
      let cardShown = false
      /**
       * The write ledger (agent-browser.md "The write ledger across requests"): earlier writes in doubt the server's start
       * named for this run's frames are asked on this run's card, one by one (［済んでいた］／［されていなかった］, the earlier
       * run's own confirm), **before the operator works**. Every one answered 「されていなかった」 (or found not taken by the
       * site meanwhile) → null, the work goes on; 「済んでいた」 → `earlier-done` (this request may be that very write again);
       * no answer within the card's time → `earlier-unknown`; the turn cut → its own reason. The server refuses a permit to
       * the same target anyway until it is answered: this is where the person is asked, not the guard.
       */
      const askEarlier = async (run: BrowserFrameRunStart, summary: string): Promise<WorkStopReason | null> => {
        const doubts = run.doubts ?? []
        if (doubts.length === 0) return null
        const e: Entry = {
          userId, companyId, runId: run.runId, host, phase: 'preparing', values: [],
          sentences: workPlanSentences({ summary, affects: '', frames: workFrames(run.frames) }),
          planHash: null, approvalToken: null, card: null, readAt: null, message: null, result: null, decide: null,
          inDoubt: null, doubtSettled: null, conversationId: input.conversationId, pressing: null, trails: [], next: null, screen: null,
        }
        entry = e
        keep(e)
        if (!cardShown) { input.onCard(run.runId); cardShown = true }
        const until = frameAskedAt + browserFrameApproveMs(run.source)
        for (const d of doubts) {
          const line = workWriteLine(d.frame.method, d.frame.path, d.frame.query ?? null)
          e.inDoubt = { write: d.write, from: d.confirmableAt, line, runId: d.runId }
          e.doubtSettled = null
          e.result = { outcome: 'unknown', headline: CW.earlierDoubt, done: [], notDone: [], unknown: [line], byHand: [CW.byHand(line)], confirm: null }
          await syncDoubt(e)
          while (e.inDoubt) {
            if (cut.signal.aborted || !current()) return whyNot()
            if (now() >= until) return 'earlier-unknown'
            await pause(STOP_CHECK_MS, cut.signal)
          }
          if (e.doubtSettled === 'done') return 'earlier-done'
          if (e.doubtSettled !== 'not_done') return 'earlier-unknown'
        }
        e.inDoubt = null
        e.result = null
        return null
      }
      const stoppedBefore = (why: WorkStopReason) => {
        if (entry) { entry.phase = 'failed'; entry.inDoubt = null; entry.result = resultOf({ kind: 'stopped', why }, [], null) }
        return said(workWordsForAi({ kind: 'stopped', why }, input.items, []))
      }
      // [a Skill] the server builds the frames from the approved declaration it reads itself, and says which Skill a name
      // means (its path: the company's or a department's; a name two Skills share is refused, never guessed).
      if (input.skill !== null) {
        const started = await deps.api.frameStart(companyId, { skill: input.skill, ...conversation })
        if (started.kind !== 'ok') return said(refusedWords(started, now()))
        frameRun = frameStartOf(started.value)
        if (!frameRun || frameRun.host !== host) return said(W.failed)
      }
      // Checked before anything is asked of the member (an earlier write in doubt), so nobody answers for a run that cannot start.
      // The steps of exactly the Skill the server's frames come from (never the name the AI typed), and only exactly the text
      // the server sealed for that folder version: steps that differ, are missing or would be cut start nothing (agent-browser.md
      // "The operator works from the approved steps"). A company without the company folder has no copy here: no steps, as before.
      let steps: string | null = null
      if (frameRun?.skill && input.companyRoot && deps.skillSteps) {
        const local = await deps.skillSteps(input.companyRoot, frameRun.skill).catch(() => null)
        const checked = browserSkillStepsCheck(frameRun.steps, local, sha256)
        if (!checked.ok) {
          const failed = frameRun
          if (!entry) {
            entry = {
              userId, companyId, runId: failed.runId, host, phase: 'failed', values: [], sentences: workPlanSentences({ summary: input.task, affects: '', frames: workFrames(failed.frames) }),
              planHash: null, approvalToken: null, card: null, readAt: null, message: null, result: null, decide: null,
              inDoubt: null, doubtSettled: null, conversationId: input.conversationId, pressing: null, trails: [], next: null, screen: null,
            }
            keep(entry)
          }
          if (!cardShown) { input.onCard(failed.runId); cardShown = true }
          return stoppedBefore(checked.problem)
        }
        steps = checked.steps
      }
      if (frameRun) {
        const earlier = await askEarlier(frameRun, input.task)
        if (earlier) return stoppedBefore(earlier)
      }
      if (decision) decision.used = true
      const person: WorkPerson = { said: input.said ?? [], values: input.values ?? [], ...(decided ? { decided: [decided] } : {}) }
      // The consultation AI's request is withheld only when the Skill's steps are what the operator works from: a Skill with
      // no steps here (none in it, or a company without the company folder) keeps the request, as before (Codex review).
      const skillRun = steps !== null
      const neverRead = frameRun?.neverRead ?? []
      const neverReadFits = (pq: string) => neverRead.some(p => browserNeverReadFits(p, pq))

      // The operator's trails (the preview's, the work's): on the member's card only (agent-browser.md "The operator's trail on the card").
      const previewTrail = createOperatorTrail('preview', toolset)
      const workTrail = createOperatorTrail('work', toolset)
      // The preview (read only): unless a pre-approved Skill version whose text nobody changed since.
      let plan: Extract<WorkAnswer, { do: 'plan' }> | null = null
      if (!frameRun || frameRun.needsApproval) {
        const previewFinished = { ok: false }
        const previewRan: { runId: string | null } = { runId: null }
        const previewed = await runOperator({
          phase: 'preview', userId, companyId, host, win, operator, toolset, cli: resolved.cli, task: input.task, person, skill: skillRun, plan: null, items: input.items, steps,
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
          const shot = previewed.kind === 'answer' ? stopScreen(previewed.screen) : null
          keepPreview(userId, companyId, previewRan.runId, previewStoppedView(host, previewEnd, now(), previewTrail.view(), previewNext, shot))
          if (previewNext?.kind === 'decide') keepDecidable(userId, companyId, previewRan.runId, { host, skill: input.skill, conversationId: input.conversationId, question: previewNext.question })
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
          const earlier = await askEarlier(frameRun, plan.summary)
          if (earlier) return stoppedBefore(earlier)
        }
      }
      const run = frameRun as BrowserFrameRunStart
      entry = {
        userId, companyId, runId: run.runId, host, phase: run.needsApproval ? 'ready' : 'running', values: plan?.values ?? [],
        sentences: workPlanSentences({ summary: plan?.summary ?? input.task, affects: plan?.affects ?? '', frames: workFrames(run.frames) }),
        planHash: run.planHash, approvalToken: run.approvalToken, card: null, readAt: null, message: null, result: null, decide: null,
        inDoubt: null, doubtSettled: null, conversationId: input.conversationId, pressing: null, trails: plan ? [previewTrail, workTrail] : [workTrail], next: null, screen: null,
      }
      const e = entry
      keep(e)
      if (!cardShown) { input.onCard(run.runId); cardShown = true }

      // The run's promise (agent-browser.md "The run's promise"), before the card and any permit: the person's own values, the
      // preview's values this card shows them (only when there is a card: a pre-approved Skill's run has no preview, so
      // nothing read from the screen is promised), a stopped card's answer it continues. Digests under this run's own key.
      const runKey = randomBytes(32)
      const digest = (v: string) => `hmac:${createHmac('sha256', runKey).update(v.normalize('NFC'), 'utf8').digest('hex')}`
      const built = buildBrowserRunPromise({
        // A plan exists only from a preview, which runs only for a run with a card: a pre-approved run promises nothing read.
        frames: workFrames(run.frames), person: person.values, preview: plan ? plan.values : null, decisions: decided ? ['proceed'] : [], digest,
      })
      let promised: BrowserRunPromiseInput | null = null
      /** When the work's operator run stops operating (its deadline, set once it started). */
      const workUntil = { at: Number.POSITIVE_INFINITY }
      const added: BrowserRunPromiseAddition[] = []
      if (deps.api.framePromise) {
        const made = await deps.api.framePromise(companyId, run.runId, built.promise).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
        if (made.kind === 'ok') promised = built.promise
        // An older server has no such route: the run goes on without a promise (that server checks none either).
        else if (!(made.kind === 'refused' && made.code === 'NOT_FOUND')) {
          e.phase = 'failed'
          const why: WorkStopReason = made.kind === 'no-answer' ? 'network' : 'server-refused'
          e.result = resultOf({ kind: 'stopped', why }, [], null)
          return said(workWordsForAi({ kind: 'stopped', why }, input.items, []))
        }
      }
      /** The card's question about a write outside the promise: true once the person said 「書いてよい」 and the server took it. */
      const askPerson = async (q: PromiseAsk): Promise<'allowed' | 'denied' | 'failed'> => {
        if (!promised || !deps.api.framePromiseAdd) return 'failed'
        const allowed = await new Promise<boolean>((resolve) => {
          // Never past the work's own operating time: an answer after it could no longer be sent (independent review).
          const until = Math.min(now() + ASK_MS, Date.parse(run.expiresAt) || now() + ASK_MS, workUntil.at)
          let timer: ReturnType<typeof setTimeout> | undefined
          let onCut = () => {}
          const done = (a: boolean) => { clearTimeout(timer); cut.signal.removeEventListener('abort', onCut); e.ask = null; e.answerAsk = null; resolve(a) }
          timer = setTimeout(() => done(false), Math.max(0, until - now()))
          onCut = () => done(false)
          cut.signal.addEventListener('abort', onCut, { once: true })
          e.ask = { line: q.line, items: q.items }
          e.answerAsk = done
          if (cut.signal.aborted) done(false)
        })
        if (!allowed) return 'denied'
        const a = await deps.api.framePromiseAdd(companyId, run.runId, q.addition).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
        if (a.kind !== 'ok') return 'failed'
        added.push(q.addition)
        return 'allowed'
      }
      const writerPromise: WriterPromise | null = promised
        ? { state: () => browserPromiseState(promised as BrowserRunPromiseInput, added), digest, ask: askPerson }
        : null

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
      /** One read: the card's rows, and the whole answer text (the write ledger's read-back compares it losslessly). */
      const readBoth = async (address: string): Promise<{ top: Array<[string, string]> | null; text: string | null }> => {
        try {
          const r = await reader.read(address, cut.signal)
          return r.status === 200 ? { top: topFields(r.body), text: r.body } : { top: null, text: null }
        } catch {
          return { top: null, text: null }
        }
      }
      const readTop = async (address: string) => (await readBoth(address)).top
      /** Each address read before a write, by the address itself, as its whole answer text (the read-back's "before"). */
      const beforeAt = new Map<string, string | null>()
      /**
       * Each held write's own address as it read right before that very write (a later write's too, not only the run's first
       * look: Codex review) — what a refused write is compared with ("Sent is not done").
       */
      const lastBefore = new Map<string, string | null>()
      const readBefore = async (p: string, a: string) => {
        const both = await readBoth(a)
        befores.set(p, both.top)
        beforeAt.set(a, both.text)
      }
      // A literal after-read address is read before anything is written.
      for (const p of afterReads) {
        const a = beforeReadAddress(p, null)
        if (a !== null && !befores.has(p)) await readBefore(p, a)
      }
      const workLog: BrowserRunLogStep[] = []
      const actions = { n: 0 }
      const writer = createFrameWriter({
        companyId, runId: run.runId, host, frames: workFrames(run.frames), api: deps.api,
        going: current, stepsSoFar: () => workLog.length, actionsSoFar: () => actions.n, now, ...(deps.monoMs ? { monoMs: deps.monoMs } : {}),
        // A pattern after-read address the held write fits is read right before it (its "before").
        readBefore: async (heldPath) => {
          lastBefore.delete(heldPath)
          for (const p of afterReads) {
            const a = beforeReadAddress(p, heldPath)
            if (a === null) continue
            if (!befores.has(p)) {
              await readBefore(p, a)
              if (a === heldPath) lastBefore.set(a, beforeAt.get(a) ?? null)
            } else if (a === heldPath && !lastBefore.has(a)) lastBefore.set(a, (await readBoth(a)).text)
          }
        },
        // A refused write's own address read again: "not saved" only when it reads exactly as it did right before the write.
        readAgain: async (heldPath, sent) => {
          const was = lastBefore.get(heldPath)
          if (was === undefined || was === null) return null
          return readBackUnchanged(sent, was, (await readBoth(heldPath)).text) ? 'unchanged' : null
        },
        promise: () => writerPromise,
      })
      // The plan the person approved on the card goes to the work as its material; none → no preview (a pre-approved Skill).
      const approvedPlan: WorkApprovedPlan | null = plan ? { summary: plan.summary, affects: plan.affects, values: plan.values } : null
      const worked = await runOperator({
        phase: 'work', userId, companyId, host, win, operator, toolset, cli: resolved.cli, task: input.task, person, skill: skillRun, plan: approvedPlan, items: input.items, steps,
        adhoc: run.source === 'adhoc', frames: () => writer.frames(), frameRunId: run.runId, cut, current, whyNot, conversation,
        neverReadFits, writer, log: workLog, trail: workTrail, actions, onDeadline: (at: number) => { workUntil.at = at },
      })
      const held = writer.records()
      /**
       * The write ledger's machine check (agent-browser.md "The write ledger across requests"): the write in doubt (the one
       * with a permit; nothing more was permitted after it) read back at its very address — read before it, no other write
       * of the run to it — shows every value it sent and a change → it landed. Reported `done` (`read-back`) from this PC;
       * only once the server took it does the card and the AI count it done, so neither this card nor a later request asks
       * the person. Anything less asks them as before.
       */
      const readBack = async (r: FrameWriteRecord | undefined): Promise<boolean> => {
        if (!r || r.path === null || typeof r.write !== 'number' || held.some(o => o !== r && o.path === r.path)) return false
        if (!afterReads.some(p => beforeReadAddress(p, r.path) === r.path) || !beforeAt.has(r.path)) return false
        if (!r.sentWhole || !readBackLanded(r.sent, beforeAt.get(r.path) ?? null, (await readBoth(r.path)).text)) return false
        const told = await deps.api.frameReport(companyId, run.runId, { write: r.write, result: 'done', reason: 'read-back' })
          .catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
        return told.kind === 'ok'
      }
      const inDoubtFirst = held.find(r => r.outcome === 'unknown' && typeof r.write === 'number')
      const landed = await readBack(inDoubtFirst) ? inDoubtFirst : undefined
      const records = landed ? held.map(r => (r === landed ? { ...r, outcome: 'done' as const, status: null } : r)) : held
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
            // What the write the address came from sent and what the run promised for it: the card's machine check.
            sent: target === null || target.from === null ? null : doneRecords[target.from].sent,
            promised: target === null || target.from === null ? null : doneRecords[target.from].promised ?? null,
            from: target === null ? null : target.from,
          })
        }
      }
      const unreadAddresses = reads.filter(r => !r.after).map(r => r.pattern)
      // Sent is not done (agent-browser.md "Sent is not done"): what reading back says of the writes the site took.
      const business = workBusinessOf(doneRecords.length, reads)
      // A held write refused as outside the frames is why the operator then stopped: said first (incident 2026-11-27).
      const end: WorkEnd = writer.locked() && records.some(r => r.outcome === 'unknown') ? { kind: 'unknown' }
        : worked.kind === 'refused' ? { kind: 'stopped', why: worked.why }
          // The work stopped at the lost answer; the read-back found that write landed.
          : landed && worked.kind === 'end' && worked.end.kind === 'unknown' ? { kind: 'stopped', why: 'read-back' }
          : workEndAfterRefusals(worked.kind === 'end' ? worked.end
            : worked.answer.do === 'done' ? { kind: 'done', business } : { kind: 'stopped', why: worked.answer.do === 'stop' ? worked.answer.why : 'blocked' }, records.map(r => r.outcome))
      const answer = worked.kind === 'answer' ? worked.answer : null
      const checks = answer?.do === 'done' ? answer.checks : []
      e.card = workResultCard({
        end, summary: answer?.do === 'done' ? answer.result : null,
        writes: records.map(r => ({ line: r.line, outcome: r.outcome, status: r.status, ...(r.refusal ? { refusal: r.refusal } : {}) })),
        afterReads: reads, checks, comparedName: answer?.do === 'done' ? answer.comparedName : null,
      })
      // Said once on the card, so the person knows the app (not the site's answer) found it done.
      if (landed) e.card = { ...e.card, headline: `${e.card.headline}${CW.readBackDone}` }
      e.readAt = new Date(now()).toISOString()
      e.phase = 'finished'
      e.result = resultOf(end, records, e.card.headline)
      // The operator's question (need-person) or the window (need-login) first on the card; the AI hears only that it asks.
      // After any held write the answers are not offered (a new run would start the work over: Codex review).
      e.next = workStopNext(end, answer?.do === 'stop' ? operatorQuestion(answer, workTrail) : null, records.length)
      if (e.next?.kind === 'decide') keepDecidable(userId, companyId, run.runId, { host, skill: input.skill, conversationId: input.conversationId, question: e.next.question })
      // The screen it stopped on goes beside what the card asks (memory only, this member's card).
      e.screen = e.next && worked.kind === 'answer' ? stopScreen(worked.screen) : null
      // The write in doubt the server knows (it had a permit): the person may answer about it on the card, past its window —
      // an unknown one, else a refused one nobody found unchanged (agent-browser.md "Sent is not done").
      const doubt = records.find(r => r.outcome === 'unknown' && typeof r.write === 'number') ?? openRefusals(records).find(r => typeof r.write === 'number')
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
    toolset: BrowserOperatorToolset
    cli: PreviewOperatorCli
    task: string
    person: WorkPerson
    skill: boolean
    plan: WorkApprovedPlan | null
    items: readonly string[]
    steps: string | null
    adhoc: boolean
    frames: WorkFrame[] | null | (() => WorkFrame[])
    frameRunId: string | null
    /** Told when the app stops operating this run (its deadline), once it started. */
    onDeadline?: (at: number) => void
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
    | { kind: 'answer'; answer: Extract<WorkAnswer, { do: 'plan' | 'done' | 'stop' }>; screen: BrowserOperatorImage | null }
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
    o.onDeadline?.(deadline)
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
        // The window's DevTools connection went while a write was held: nothing more is sent. Unknown only when a page's
        // original may have gone out on its own (not parked yet); otherwise a held write not sent is not sent, one on its
        // way keeps its own result (agent-browser.md "Writes within frames, in the app").
        detached: (originalMayHaveGone: boolean) => { if (originalMayHaveGone) writer?.abandon('detached'); else writer?.close() },
      }
      if (!(await o.win.enter(() => deps.stopped(o.companyId) || !o.current(), hooks))) {
        reason = 'refused'
        return { kind: 'end', reason, end: { kind: 'stopped', why: 'blocked' } }
      }
      const got = await operate({
        phase: o.phase, companyId: o.companyId, browseRunId, host: o.host, win: o.win, operator: o.operator, toolset: o.toolset, cli: o.cli, parentEnv: deps.parentEnv(),
        task: o.task, person: o.person, skill: o.skill, plan: o.plan, items: o.items, steps: o.steps, adhoc: o.adhoc,
        frames: () => (typeof o.frames === 'function' ? o.frames() : o.frames),
        writes: () => writer?.seen() ?? [], locked: () => writer?.locked() ?? false, ...(o.actions ? { actions: o.actions } : {}),
        ...(writer ? {
          sending: () => writer.sending(), heldCount: () => writer.heldCount(),
          writeCameLate: (since: number, at: number) => writeCameLate(writer, since, at, o.cut.signal),
        } : {}),
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
      // This PC's own record of which tool set the run used (agent-browser.md "The operator's tool sets"); never the server's.
      ;(deps.log ?? console).info(`[browser] operator run ${browseRunId} (${o.phase}): tool set ${o.toolset}, ${outcome}${reason ? ` (${reason})` : ''}`)
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
    e.doubtSettled = to
  }

  /**
   * Read the run again (`GET /browser-frame-runs/:runId`) and take what the server holds of the write in doubt: an answer
   * already kept (`confirmed`), a late sure answer of the site (its state moved), or its time (`confirmableAt`). Nothing
   * read → as it was.
   */
  async function syncDoubt(e: Entry): Promise<void> {
    const doubt = e.inDoubt
    if (!doubt) return
    const got = await Promise.resolve().then(() => deps.api.frameGet(e.companyId, doubt.runId ?? e.runId)).catch((): BrowserLinesAnswer => ({ kind: 'no-answer' }))
    if (got.kind !== 'ok') return
    const w = (got.value as { writes?: unknown } | null)?.writes
    const write = Array.isArray(w) ? (w as Array<Record<string, unknown>>).find(x => x?.write === doubt.write) : undefined
    if (!write) return
    const confirmed = write.confirmed as { answer?: unknown } | null | undefined
    if (confirmed && (confirmed.answer === 'done' || confirmed.answer === 'not_done')) {
      settleDoubt(e, confirmed.answer, confirmed.answer === 'done' ? CW.confirmedDone : CW.confirmedNotDone)
    } else if (write.state === 'done' || write.state === 'verified') {
      settleDoubt(e, 'done', CW.lateDone)
    } else if (write.state === 'refused' && write.checked !== false) {
      // Read again and found unchanged (or an older server, which says nothing of it): not saved.
      settleDoubt(e, 'not_done', CW.lateRefused)
    } else if ((write.state === 'unknown' || write.state === 'refused') && typeof write.confirmableAt === 'string' && Number.isFinite(Date.parse(write.confirmableAt))) {
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
    // A refused write nobody found unchanged is not "not done" (agent-browser.md "Sent is not done"): it is listed as not known.
    const open = new Set(openRefusals(records))
    const unknown = records.filter(r => r.outcome === 'unknown' || open.has(r)).map(r => r.line)
    return {
      outcome: end.kind === 'done' ? 'succeeded' : end.kind === 'unknown' ? 'unknown' : records.some(r => r.outcome === 'done') ? 'partial' : 'stopped',
      headline: headline ?? (end.kind === 'stopped' ? W.stoppedBy[end.why] : end.kind === 'unknown' ? CW.unknown : CW.doneUnconfirmed),
      done: records.filter(r => r.outcome === 'done').map(r => r.line),
      notDone: records.filter(r => r.outcome === 'not-sent' || r.outcome === 'refused' || (r.outcome === 'site-refused' && !open.has(r))).map(r => r.line),
      unknown,
      byHand: unknown.map(CW.byHand),
      confirm: null,
    }
  }

  /**
   * The refused writes whether saved or not is not known (agent-browser.md "Sent is not done"): not read again and found
   * unchanged, and not followed by a done write of this run to the very same address (its corrected try settled it).
   */
  function openRefusals(records: readonly FrameWriteRecord[]): FrameWriteRecord[] {
    return records.filter((r, i) => r.outcome === 'site-refused' && r.refusal !== 'unchanged'
      && !records.slice(i + 1).some(o => o.outcome === 'done' && o.path !== null && o.path === r.path && o.line === r.line))
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
        const doubt = e.inDoubt as { write: number; runId?: string }
        const sent = await deps.api.frameConfirm(companyId, doubt.runId ?? runId, { write: doubt.write, answer })
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
        e.doubtSettled = 'gone'
        if (e.result) e.result = { ...e.result, confirm: null }
        return { ok: false, message: CW.confirmSettledElsewhere }
      }
      return { ok: false, message: CW.confirmFailed }
    },
    /**
     * ［書いてよい］／［書かない］ on the card (a window showing its consultation, the caller checked): the person's answer about a
     * write outside the run's promise, while the page's request waits (agent-browser.md "The run's promise"). The AI's tools
     * never reach this.
     */
    allow(companyId: string, runId: string, allow: unknown): BrowserWriteGetResult | null {
      const e = mine(deps.userId(), companyId, runId)
      if (!e) return null
      if (typeof allow !== 'boolean' || !e.answerAsk) return { ok: false, message: CW.askGone }
      e.answerAsk(allow)
      return { ok: true, view: viewOf(e) }
    },
    /**
     * ［そのまま進める］／［やめる］ on a stopped card that asks the member to decide (agent-browser.md "The stopped card's answer"):
     * kept as the card's fixed answer, once. Only a later request that names this card (`decision`) continues it; nothing here
     * reaches the site or an AI.
     */
    decide(companyId: string, cardId: string, choice: unknown): { ok: true } | { ok: false; message: string } | null {
      const userId = deps.userId()
      if (!userId) return null
      const d = decidables.get(key(userId, companyId, cardId))
      if (!d) return null
      if (choice !== 'proceed' && choice !== 'stop') return { ok: false, message: CW.askGone }
      if (d.choice !== null && d.choice !== choice) return { ok: false, message: CW.askGone }
      d.choice = choice
      d.at = now()
      return { ok: true }
    },
    /** A stopped card's consultation (the caller lets only a window showing it answer). */
    decidePlace(companyId: string, cardId: string): { conversationId: string | null } | null {
      const userId = deps.userId()
      const d = userId ? decidables.get(key(userId, companyId, cardId)) : undefined
      return d ? { conversationId: d.conversationId } : null
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
    clear: () => { entries.clear(); previews.clear(); decidables.clear() },
  }
}

export type BrowserWorkWiring = ReturnType<typeof wireBrowserWork>

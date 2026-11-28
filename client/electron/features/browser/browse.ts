// The operator's window tools of 「ブラウザ操作」, wired (redesign step ④; agent-browser.md "The operator's window tools"):
// the consultation AI asks (`browser_browse`: a registered domain, an instruction in words, the headings it wants) → the
// server's gate and the company × domain lock (`POST /browser-runs`) → the operator AI (the member's closed Claude Code, no
// tool) is shown the page and answers one action a step; main does it in the member's own window, in `ai` mode with a gate
// that refuses every write → before every step the server is asked again (`continue`) → the run's log (no value) goes to
// the server and the lock is released, whatever happened (`finish`).
//
// Isolation (design memo I6): the page's text reaches the operator only. The consultation AI gets fixed words and its own
// headings by number (`browseWordsForAi`); what the operator read is on the member's card alone, kept here in memory
// (never on disk, the server, a log or the consultation AI). No Electron: main.ts hands in the window controller's
// `browseWindow`, the policy store's stop, the session's HTTP client, the context and the operator.
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import {
  BROWSER_BROWSE_LIMITS as L, BROWSER_BROWSE_WORDS as W, aimedAction, browseCard, browseHistoryEntry, browseLogStep, browseMaterial, browseWordsForAi, pageWithScreen, parseBrowseAnswer,
  type BrowserBrowseAction, type BrowserBrowseHistoryEntry, type BrowserBrowseStop, type BrowserBrowseSurface, type BrowserPageSnapshot,
} from '../../../shared/browser-browse'
import type { BrowserInspectionView } from '../../../shared/browser-inspection'
import { createOperatorTrail } from '../../../shared/browser-operator-trail'
import { DEFAULT_BROWSER_OPERATOR_TOOLSET, readToolsetAnswer, toolsetHistory, type BrowserOperatorToolset } from '../../../shared/browser-operator-toolsets'
import { noWindowWords, type BrowserRunWindow } from '../../../shared/browser-operation'
import { BROWSER_RUN_ID_RE, BROWSER_RUN_LIMITS, type BrowserRunEndReason, type BrowserRunLogStep, type BrowserRunOutcome } from '../../../../shared/core/browser-run-log'
import type { BrowserAiSwitch } from './ai-switch'
import type { BrowserContext } from './context'
import type { BrowserLinesAnswer, BrowserRunsApi } from './lines-api'
import { sendEnd, type PendingEnds } from './pending-ends'
import type { PreviewOperator } from './preview'

export interface BrowserBrowseDeps {
  aiSwitch: BrowserAiSwitch
  userId: () => string | null
  /** The context the plans use too (sign-in, the company's setting, quitting, the switch). */
  context: BrowserContext
  /** `browserAiStopped(policy.stop(companyId))`. */
  stopped(companyId: string): boolean
  /** The member's open window of the domain as the window tools act on it (controller `browseWindow`), or null. */
  window(companyId: string, host: string): BrowserBrowseSurface | null
  /** Whether the company registered the domain (its current valid policy, controller `siteNow`). */
  registered(companyId: string, host: string): boolean
  /**
   * The window a run needs (controller `windowForRun`, agent-browser.md "The window a run needs"): asked before the run
   * looks for it, so a window closed meanwhile opens again by itself while this app run holds the member's login.
   */
  openWindow?(companyId: string, host: string, signal: AbortSignal): Promise<BrowserRunWindow>
  api: BrowserRunsApi
  /** The member's agent's operator (`browserOperatorOf`), its CLI and the app's environment. */
  operator(): PreviewOperator | null
  cliPath(): string
  parentEnv(): Readonly<Record<string, string | undefined>>
  /** One window serves one run at a time, on every path (the plans' runner shares the set). */
  busyWindows?: Set<string>
  now?: () => number
  log?: Pick<Console, 'warn'>
  /** Ends the server did not hear (a lost `finish`): retried, and flushed before this member's next task. */
  pendingEnds?: PendingEnds
  /** This PC's tool set for the operator (agent-browser.md "The operator's tool sets"), read once per run; absent: `current`. */
  toolset?: () => BrowserOperatorToolset
}

export type BrowserBrowseOutcome =
  | { kind: 'card'; runId: string; words: string }
  | { kind: 'refused'; words: string }

/** How often the AI stop is asked while a run goes on (an emergency stop ends the operator's step within this). */
const STOP_CHECK_MS = 500

/** The cards kept in memory (per signed-in member), at most this many: the oldest go first. */
const KEPT_CARDS = 100

/** The server's refusal of a run → the consultation AI's fixed words. */
function refusedWords(answer: Exclude<BrowserLinesAnswer, { kind: 'ok' }>): string {
  if (answer.kind === 'no-answer') return W.offline
  switch (answer.code) {
    case 'BROWSER_RUN_BUSY': return W.busy
    case 'BROWSER_NOT_ALLOWED': return W.notAllowed
    case 'BROWSER_TYPE_NOT_GRANTED': return W.notGranted
    case 'BROWSER_AI_STOPPED': return W.stopped
    default: return answer.code?.startsWith('BROWSER_DEVICE_') ? W.pc : W.failed
  }
}

export function wireBrowserBrowse(deps: BrowserBrowseDeps) {
  const now = deps.now ?? Date.now
  const busyWindows = deps.busyWindows ?? new Set<string>()
  const cards = new Map<string, BrowserInspectionView>()
  const key = (userId: string, companyId: string, runId: string) => `${userId}|${companyId}|${runId}`
  const keep = (k: string, view: BrowserInspectionView) => {
    cards.delete(k)
    cards.set(k, view)
    while (cards.size > KEPT_CARDS) cards.delete(cards.keys().next().value as string)
  }

  /** The consultation AI's read task: a card for the member, fixed words for the AI. Off: nothing read, started or sent. */
  async function browse(input: {
    companyId: string; conversationId: string | null; site: string; task: string; items: readonly string[]; signal: AbortSignal
  }): Promise<BrowserBrowseOutcome> {
    const refused = (words: string): BrowserBrowseOutcome => ({ kind: 'refused', words })
    if (!deps.aiSwitch()) return refused(W.off)
    const userId = deps.userId()
    if (!userId || !BROWSER_COMPANY_ID_RE.test(input.companyId)) return refused(W.failed)
    const { companyId } = input
    const host = input.site
    // Only a domain the company registered (its current valid policy): the request's host is a name, nothing more.
    if (!deps.registered(companyId, host)) return refused(W.notAllowed)
    if (deps.stopped(companyId)) return refused(W.stopped)
    const operator = deps.operator()
    if (!operator) return refused(W.noOperator)
    // The context is taken before the wait for the window, so a sign-in or setting change meanwhile is seen (Codex review).
    const stillCurrent = deps.context.capture({ companyId, signal: input.signal })
    const found = await deps.openWindow?.(companyId, host, input.signal)
    if (found && deps.stopped(companyId)) return refused(W.stopped)
    const win = deps.window(companyId, host)
    if (!win || win.closed()) return refused(noWindowWords(W.noWindow, found))
    const windowKey = `${companyId}\0${host}`
    if (busyWindows.has(windowKey)) return refused(W.busy)
    if (!stillCurrent()) return refused(W.interrupted)

    // The server decides first: nothing is read or started unless it gives the run (and its lock). The window is taken
    // before asking, so a plan's run cannot start in it meanwhile.
    busyWindows.add(windowKey)
    let runId = ''
    try {
      // This member's own leftover ends on this company go first, so the lock they hold is let go.
      await deps.pendingEnds?.flush(userId, companyId)
      const started = await deps.api.runStart(companyId, { host, ...(input.conversationId ? { conversationId: input.conversationId } : {}) })
      if (started.kind !== 'ok') return refused(refusedWords(started))
      const id = (started.value as { runId?: unknown } | null)?.runId
      if (typeof id !== 'string' || !BROWSER_RUN_ID_RE.test(id)) return refused(W.failed)
      runId = id
    } finally {
      if (!runId) busyWindows.delete(windowKey)
    }

    const steps: BrowserRunLogStep[] = []
    let outcome: BrowserRunOutcome = 'failed'
    let reason: BrowserRunEndReason | undefined
    let entered = false
    // The run's own signal: the turn's (the member's stop, an administrator's stop, a closed consultation) or the deadline.
    const cut = new AbortController()
    const onTurn = () => cut.abort()
    input.signal.addEventListener('abort', onTurn, { once: true })
    const deadline = now() + L.totalMs
    const timer = setTimeout(() => cut.abort(), L.totalMs)
    // The emergency stop ends the operator's step at once (its CLI killed), not only after its answer (review L5).
    const watchStop = setInterval(() => { if (deps.stopped(companyId)) cut.abort() }, STOP_CHECK_MS)
    const current = () => !cut.signal.aborted && stillCurrent() && !deps.stopped(companyId)
      && !win.closed() && deps.window(companyId, host) === win
    const whyNot = (): BrowserRunEndReason => (input.signal.aborted ? 'stopped-by-person' : deps.stopped(companyId) ? 'ai-stopped'
      : !stillCurrent() ? 'context-changed'
        : win.closed() || deps.window(companyId, host) !== win ? 'window-closed' : now() >= deadline ? 'timeout' : 'context-changed')
    try {
      const parentEnv = deps.parentEnv()
      const resolved = await operator.resolve(deps.cliPath(), parentEnv)
      if (!resolved.ok) { reason = 'operator-failed'; return refused(W.failed) }
      if (!current()) { outcome = 'stopped'; reason = whyNot(); return refused(W.interrupted) }
      // `ai` mode: every write the page makes is refused, whatever the operator presses (step ⑤ adds writes).
      // Left in `finally` whatever `enter` answers or throws (a gate attached late must not keep the window in `ai` mode).
      entered = true
      if (!(await win.enter(() => deps.stopped(companyId) || !current()))) { reason = 'refused'; return refused(W.failed) }

      const history: BrowserBrowseHistoryEntry[] = []
      // One tool set for the whole run: only what the operator is told and how its answer is read (the same actions after).
      const toolset = deps.toolset?.() ?? DEFAULT_BROWSER_OPERATOR_TOOLSET
      // The operator's own working memory between its fresh, tool-less steps (never the chat AI's).
      let notes = ''
      // Its trail for the member's card only (outside text: never the chat AI's words or the server's log).
      const trail = createOperatorTrail('browse')
      for (let round = 1; round <= L.rounds; round++) {
        if (!current()) { outcome = 'stopped'; reason = whyNot(); return refused(W.interrupted) }
        // No frame the write gate does not see (a login check left in the page): stop, as a run does.
        if (!win.pageClean()) { outcome = 'stopped'; reason = 'other-frames'; return refused(W.failed) }
        // The server asks again before every step: the PC, the setting, the stop, the person's level; the lease renewed.
        const going = await deps.api.runContinue(companyId, runId)
        if (going.kind !== 'ok') { outcome = 'stopped'; reason = going.kind === 'no-answer' ? 'no-answer' : 'refused'; return refused(refusedWords(going)) }
        const shown: BrowserPageSnapshot | null = await win.snapshot()
        if (!current()) { outcome = 'stopped'; reason = whyNot(); return refused(W.interrupted) }
        if (!shown) { reason = 'blocked'; return refused(W.failed) }
        // The screen beside the text, its elements marked by number: for this step's operator only, then dropped. Its size
        // goes with the page (a press by position is measured in its pixels).
        const image = (await win.screenshot?.(shown)) ?? null
        const page = pageWithScreen(shown, image)
        if (!current()) { outcome = 'stopped'; reason = whyNot(); return refused(W.interrupted) }
        const left = deadline - now()
        if (left <= 0) { outcome = 'stopped'; reason = 'timeout'; return refused(W.interrupted) }
        const step = await operator.step({
          cli: resolved.cli, model: operator.model, signal: cut.signal, timeoutMs: Math.min(L.roundMs, left), parentEnv, prompt: 'browse', toolset,
          material: browseMaterial({ task: input.task, items: input.items, page, history: toolsetHistory(toolset, history), notes, round }), image,
        })
        if (!current()) { outcome = 'stopped'; reason = whyNot(); return refused(W.interrupted) }
        if (!step.ok) { reason = 'operator-failed'; return refused(W.failed) }
        const read = readToolsetAnswer(toolset, step.text, page)
        const parsed = 'problem' in read ? read : parseBrowseAnswer(read.text, { snapshot: page, items: input.items.length })
        if ('problem' in parsed) { reason = 'bad-answer'; return refused(W.failed) }
        const answer = parsed.answer
        if (parsed.notes !== undefined) notes = parsed.notes
        trail.notes(parsed.notes)
        trail.unlisted(parsed.unlisted)
        if (answer.do === 'done' || answer.do === 'stop') {
          trail.end(answer.do, parsed.reason)
          const end = answer.do === 'done' ? { kind: 'done' as const, result: answer.result } : { kind: 'stopped' as const, why: answer.why as BrowserBrowseStop }
          outcome = answer.do === 'done' ? 'done' : 'stopped'
          if (answer.do === 'stop') reason = answer.why
          // Kept for this member only, in memory: the card is the one place what the operator read is shown.
          if (deps.userId() !== userId) { outcome = 'stopped'; reason = 'context-changed'; return refused(W.interrupted) }
          keep(key(userId, companyId, runId), {
            card: browseCard({ host, items: input.items, outcome: end, unread: answer.unread }),
            readAt: new Date(now()).toISOString(), siteLabel: host, trail: [trail.view()],
          })
          return { kind: 'card', runId, words: browseWordsForAi(end.kind === 'done' ? { kind: 'done' } : { kind: 'stopped', why: end.why }, input.items, answer.unread) }
        }
        const action: BrowserBrowseAction = answer
        // A press by position or a typing without a ref: what the window's hit-test finds there now; refused → nothing done.
        const aimed = aimedAction(action) ? (await win.aim?.(action)) ?? { ok: false as const, why: 'nothing' as const } : undefined
        if (aimed && !aimed.ok) { history.push({ do: action.do, outcome: 'refused', why: aimed.why }); continue }
        const logStep = browseLogStep(action, page, host, aimed)
        if (steps.length < BROWSER_RUN_LIMITS.steps) steps.push(logStep)
        trail.step(logStep, parsed.reason)
        const done = await win.act(action, cut.signal)
        history.push(browseHistoryEntry(action, done))
      }
      outcome = 'stopped'
      reason = 'rounds'
      return refused(W.interrupted)
    } finally {
      clearTimeout(timer)
      clearInterval(watchStop)
      input.signal.removeEventListener('abort', onTurn)
      cut.abort()
      if (entered) await win.leave().catch(() => {})
      busyWindows.delete(windowKey)
      // The log and the lock: always told (no value in it); lost to the network = kept and sent again until its lease is
      // over (agent-browser.md "Letting a domain go"; a run past its lease counts as ended on the server anyway).
      const body = { outcome, ...(reason ? { reason } : {}), steps }
      void sendEnd(deps.pendingEnds, { runId, userId, companyId, until: now() + BROWSER_RUN_LIMITS.leaseMs }, () => deps.api.runFinish(companyId, runId, body))
    }
  }

  return {
    /** Whether the tool may exist at all (the switch, asked per turn). */
    available: () => deps.aiSwitch(),
    browse,
    /** The member's card of a run (the inspection card's IPC asks it for a `bo_` id). */
    card(userId: string, companyId: string, runId: string): BrowserInspectionView | undefined {
      return cards.get(key(userId, companyId, runId))
    },
    /** Sign-out: no card of the previous account stays in memory. */
    clear: () => cards.clear(),
  }
}

export type BrowserBrowseWiring = ReturnType<typeof wireBrowserBrowse>

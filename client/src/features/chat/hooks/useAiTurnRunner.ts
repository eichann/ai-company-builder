import { useCallback, useRef, useState } from 'react'
import type { AiTurnItemsView, AiTurnItemView, AiTurnSettleResult, AutoTurnSettings } from '../../../../shared/ai-turns'
import { pluginStepConsultationTitle } from '../../../../shared/ai-turn-steps/plugin'
import { aiTurnStepForRecord } from '../../../../shared/ai-turn-steps/registry'
import type { AiTurnCandidate } from '../../../../shared/ai-turn-steps/types'
import { DEFAULT_FEATURES, type CompanyFeatures } from '../../../../../shared/core/features'
import { useInterval } from '../../../shared/hooks/useInterval'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { rateLimitsOf } from '../agentStatusStore'
import { consultationStatusOf } from '../consultationStatusStore'
import { consultationHoldOf, rememberAutomaticConsultation } from '../automaticConsultationsStore'
import { claimAiTurn, getAiTurnStopConfirmed, getAutoTurnSettings, getChatSessionSummaries, patchChatSession, retryAiTurn, settleAiTurn } from '../api'
import {
  AI_TURN_PASS_INTERVAL_MS, aiTurnItems, aiTurnNoticeText, askedAgain, canResumeAiTurns, handUrgent, handedOver, logForToday, movedOn,
  closesWhenRunEnds, mayStartAiTurns, nextAiTurn, recordOutcome, recordStarted, resumed, retitledConsultation, retried, usageLimitReached, usagePause, usagePauseLifted,
  type AiTurnLog, type AiTurnOutcome,
} from '../aiTurns'
import type { ChatInputRequest } from '../components/ChatConversation'

/** How often the runner looks (cheap: no server call unless something starts or ends). */
export const AI_TURN_TICK_MS = 3_000
/** A claimed turn whose consultation never started working within this time counts as unfinished. */
const START_TIMEOUT_MS = 2 * 60_000
const SETTINGS_TTL_MS = 10 * 60_000

interface Running {
  recordId: string
  /** The record's version in the queue when this run started. */
  version: number
  /** Its state then (a hand-off remembers it: back in another state, it is another turn — `movedOn`). */
  state: string | null
  tabId: string
  phase: 'claiming' | 'running'
  since: number
  sawWorking: boolean
  needsYou: boolean
  /** The hidden consultation (known once the tab claims) and the name the runner gave it. */
  conversationId: string | null
  title: string
  /** The consultation's name for the record's title now (the run may rename the record). */
  titleFor: (recordTitle: string) => string
}

export interface AiTurnRunnerOptions {
  companyId: string
  /** The company folder (a company Skill pinned as a plugin step's procedure is read there). */
  companyRoot?: string
  userId: string
  /** Records waiting for the member's AI (「AI の番」) whose kind has a step (`aiTurnQueue`, ai-turn-steps/registry.ts). */
  queue: readonly AiTurnCandidate[]
  authMode: string
  /** The chosen AI is installed and signed in (the chat's setup check). */
  agentReady: boolean
  /** A new consultation tab behind the shown one; returns its tab id. */
  openBackgroundTab: () => string
  closeTab: (tabId: string) => void
  /** Hand that tab its request (it claims with its own conversation id, then sends). */
  deliver: (tabId: string, request: Extract<ChatInputRequest, { kind: 'aiTurn' }>) => void
  /** Each waiting record's state changed (for the screens that list them). */
  onItems?: (view: AiTurnItemsView) => void
  /** The company's 「使う機能」 (absent = all on): the first message asks nothing of a feature that is off. */
  features?: CompanyFeatures
}

const storageKey = (companyId: string, userId: string) => `aiTurns:${companyId}:${userId}`

function readLog(key: string, now: number): AiTurnLog {
  try { return logForToday(JSON.parse(localStorage.getItem(key) ?? 'null'), now) } catch { return logForToday(null, now) }
}

function writeLog(key: string, log: AiTurnLog): void {
  try { localStorage.setItem(key, JSON.stringify(log)) } catch { /* unavailable: today's counts live in memory only */ }
}

/**
 * Runs the member's 「AI の番」 automatically while the main window is open
 * (.claude/rules/ai-turns.md): one hidden consultation at a time, claimed by
 * the record's version first, saved like any other consultation. The rules
 * are in aiTurns.ts; this hook carries them out on a timer.
 */
export function useAiTurnRunner(options: AiTurnRunnerOptions): { notice: string | null; canResume: boolean; resume: () => void } {
  const latest = useLatestRef(options)
  const key = storageKey(options.companyId, options.userId)
  const memoryLog = useRef<AiTurnLog | null>(null)
  const running = useRef<Running | null>(null)
  const settings = useRef<{ value: AutoTurnSettings; at: number } | null>(null)
  const pass = useRef<{ startedAt: number; started: number } | null>(null)
  // A version another PC (or the member) took first is not tried again.
  const taken = useRef(new Set<string>())
  const ticking = useRef(false)
  // The chosen AI and whether it is signed in, as last seen (a change lifts Claude's usage pause).
  const lastAgent = useRef<string | null>(null)
  const published = useRef('')
  const [notice, setNotice] = useState<{ text: string | null; canResume: boolean }>({ text: null, canResume: false })

  const loadLog = useCallback((now: number) => memoryLog.current ? logForToday(memoryLog.current, now) : readLog(key, now), [key])
  const saveLog = useCallback((log: AiTurnLog) => { memoryLog.current = log; writeLog(key, log) }, [key])

  const settle = useCallback(async (run: Running, now: number) => {
    const o = latest.current
    const snapshot = rateLimitsOf('claude-code')
    const result: AiTurnSettleResult = await settleAiTurn(o.companyId, run.recordId).catch(() => ({ outcome: 'unknown' }))
    const outcome: AiTurnOutcome = result.outcome === 'done' ? 'done'
      : usageLimitReached(snapshot) ? 'usage-limit' : result.outcome === 'failed' ? 'failed' : 'unfinished'
    if (settings.current) saveLog(recordOutcome(loadLog(now), run.recordId, outcome, settings.current.value, usagePause(snapshot, now), run.version, run.state))
    running.current = null
    // Ended well and nothing of the member's there: the consultation closes like a member's close
    // (「終わったもの」, history kept; owner FB #28). A review, a failure or the member's words keep it open.
    // Still remembered afterwards: should it stay as the last tab (closeTab keeps one), the record's end closes it later.
    if (closesWhenRunEnds(outcome, consultationStatusOf(run.tabId), consultationHoldOf(run.tabId))) o.closeTab(run.tabId)
    // The run named its record (a message without a subject): the consultation follows, unless the member renamed it.
    if (result.title && run.conversationId) {
      const conversationId = run.conversationId
      const sessions = await getChatSessionSummaries(o.companyId).catch(() => [])
      const title = retitledConsultation({ given: run.title, current: sessions.find(s => s.id === conversationId)?.title, renamed: run.titleFor(result.title) })
      if (title) await patchChatSession(o.companyId, conversationId, { title, titleAutoGenerated: false }).catch(() => undefined)
    }
  }, [latest, loadLog, saveLog])

  const start = useCallback((notice: AiTurnCandidate, now: number) => {
    const o = latest.current
    // A business plugin's step (plugin-steps.md): main's claim makes its first message from the pinned procedure.
    const pluginStep = notice.pluginStep ?? null
    const step = pluginStep ? null : aiTurnStepForRecord(notice.id, notice.state)
    const stepName = step?.step ?? pluginStep
    if (!stepName) return
    const titleFor = (recordTitle: string) => step ? step.consultationTitle({ ...notice, title: recordTitle }) : pluginStepConsultationTitle(recordTitle)
    const title = titleFor(notice.title)
    const tabId = o.openBackgroundTab()
    const run: Running = { recordId: notice.id, version: notice.version, state: notice.state ?? null, tabId, phase: 'claiming', since: now, sawWorking: false, needsYou: false, conversationId: null, title, titleFor }
    running.current = run
    if (!pass.current || now - pass.current.startedAt >= AI_TURN_PASS_INTERVAL_MS) pass.current = { startedAt: now, started: 0 }
    pass.current.started += 1
    o.deliver(tabId, {
      kind: 'aiTurn',
      step: stepName,
      title,
      ...(step?.linksMinutes ? { minutesId: notice.id } : {}),
      claim: async (conversationId: string) => {
        const result = await claimAiTurn(o.companyId, notice.id, notice.version, conversationId, o.companyRoot).catch(() => ({ claimed: false as const, reason: 'unavailable' as const }))
        if (running.current !== run) return null
        if (!result.claimed) {
          if (result.reason === 'taken') taken.current.add(`${notice.id}@${notice.version}`)
          running.current = null
          latest.current.closeTab(tabId)
          return null
        }
        saveLog(recordStarted(loadLog(Date.now()), notice.id))
        // Ending the record later closes it too, unless the member wrote there (ChatPanel's chat.closeRecordConsultations).
        rememberAutomaticConsultation(o.companyId, o.userId, conversationId, notice.id)
        run.conversationId = conversationId
        run.phase = 'running'
        run.since = Date.now()
        // The message names the version the claim left the record at (the AI cannot look it up).
        const message = step ? step.firstMessage(notice, result.version, latest.current.features ?? DEFAULT_FEATURES) : result.message
        if (!message) { running.current = null; latest.current.closeTab(tabId); return null }
        return { message }
      },
    })
  }, [latest, loadLog, saveLog])

  // The member's two choices; the next tick (≤ 3 s) publishes the new states.
  const giveBack = useCallback(async (recordId: string) => {
    // The server's run may be waiting for a person too (S10b). It goes first: a claim that reached
    // the server before it would be refused and the record marked taken.
    const companyId = latest.current.companyId
    if (companyId) await retryAiTurn(companyId, recordId).catch(() => undefined)
    saveLog(retried(loadLog(Date.now()), recordId))
    published.current = ''
    for (const k of [...taken.current]) if (k.startsWith(`${recordId}@`)) taken.current.delete(k)
  }, [latest, loadLog, saveLog])
  const retry = useCallback((recordId: string) => { void giveBack(recordId) }, [giveBack])
  const handOver = useCallback((recordId: string) => {
    const shown = published.current ? JSON.parse(published.current) as AiTurnItemView[] : []
    saveLog(handedOver(loadLog(Date.now()), recordId, shown.find(i => i.recordId === recordId)?.reason ?? ''))
    published.current = ''
  }, [loadLog, saveLog])

  const tick = useCallback(async () => {
    if (ticking.current) return
    ticking.current = true
    try {
      const o = latest.current
      const now = Date.now()
      if (!running.current && o.queue.length === 0) {
        setNotice(prev => prev.text === null ? prev : { text: null, canResume: false })
        if (published.current !== '[]') { published.current = '[]'; o.onItems?.({ items: [], retry, handOver }) }
        return
      }
      if (!settings.current || now - settings.current.at > SETTINGS_TTL_MS) {
        const value = await getAutoTurnSettings(o.companyId).catch(() => null)
        if (value) settings.current = { value, at: now }
      }
      const run = running.current
      if (run?.phase === 'claiming' && now - run.since > START_TIMEOUT_MS) {
        running.current = null
        o.closeTab(run.tabId)
      } else if (run?.phase === 'running') {
        const status = consultationStatusOf(run.tabId)
        // An approval or a question keeps the turn running (the AI waits for the member: handed early);
        // 「確認をお願いします」 comes after it ended.
        run.needsYou = status?.state === 'needs-you' && status.kind !== 'review'
        const busy = status?.state === 'working' || run.needsYou
        if (busy) run.sawWorking = true
        const ended = status !== undefined && !busy && (run.sawWorking || status.state === 'unseen' || status.state === 'failed')
        if (ended || (!run.sawWorking && now - run.since > START_TIMEOUT_MS)) await settle(run, now)
      }
      const current = running.current
      const queue = o.queue.filter(n => !taken.current.has(`${n.id}@${n.version}`))
      // Asked for again after a failure: the same as 「もう一度」, without the member pressing twice.
      for (const id of askedAgain(loadLog(now), queue)) await giveBack(id)
      // Handed in one state and now waiting in another (a 返事のお願い drafted, then her reply came): a new turn.
      for (const id of movedOn(loadLog(now), queue)) await giveBack(id)
      let log = loadLog(now)
      // Claude's usage pause ends early when Claude says it has room again (a newer snapshot), or when
      // the chosen AI or its sign-in changed here (perhaps another account; a limit hit again pauses again).
      const agentKey = `${o.authMode}:${o.agentReady}`
      const agentChanged = lastAgent.current !== null && lastAgent.current !== agentKey
      lastAgent.current = agentKey
      const lifted = usagePauseLifted(log, rateLimitsOf('claude-code'), agentChanged)
      if (lifted !== log) saveLog(log = lifted)
      if (settings.current?.value.enabled) {
        const urgent = handUrgent(log, queue, current?.recordId ?? null, now)
        if (urgent !== log) saveLog(log = urgent)
      }
      // No person present: nothing starts until main confirms the stop policy with the server (asked
      // each tick while something could start; main asks the server again, so this resumes by itself).
      const stopConfirmed = mayStartAiTurns(settings.current?.value ?? null, queue)
        ? await getAiTurnStopConfirmed(o.companyId).catch(() => false) : false
      const decision = nextAiTurn({
        settings: settings.current?.value ?? null, agent: o.authMode, agentReady: o.agentReady, stopConfirmed,
        busy: current !== null, log, queue, pass: pass.current, now,
      })
      const wait = 'wait' in decision ? decision.wait : null
      const text = wait ? aiTurnNoticeText(wait, { log, settings: settings.current?.value ?? null }) : null
      const canResume = canResumeAiTurns(wait)
      setNotice(prev => prev.text === text && prev.canResume === canResume ? prev : { text, canResume })
      const items = aiTurnItems({ queue, log, wait, noticeText: text, running: current && { id: current.recordId, needsYou: current.needsYou }, autoOff: settings.current ? !settings.current.value.enabled : false })
      const serialized = JSON.stringify(items)
      if (serialized !== published.current) { published.current = serialized; o.onItems?.({ items, retry, handOver }) }
      if ('run' in decision) {
        const chosen = queue.find(n => n.id === decision.run.id)
        if (chosen) start(chosen, now)
      }
    } finally {
      ticking.current = false
    }
  }, [latest, loadLog, saveLog, settle, start, giveBack, retry, handOver])

  useInterval(() => { void tick() }, AI_TURN_TICK_MS)

  const resume = useCallback(() => {
    saveLog(resumed(loadLog(Date.now())))
    setNotice({ text: null, canResume: false })
  }, [loadLog, saveLog])

  return { notice: notice.text, canResume: notice.canResume, resume }
}

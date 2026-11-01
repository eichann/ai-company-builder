import { useCallback, useRef, useState } from 'react'
import type { AutoTurnSettings } from '../../../../shared/ai-turns'
import { minutesConsultationTitle, minutesFirstMessage, type MinutesNotice } from '../../../../shared/minutes-app'
import { useInterval } from '../../../shared/hooks/useInterval'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { rateLimitsOf } from '../agentStatusStore'
import { consultationStatusOf } from '../consultationStatusStore'
import { claimAiTurn, getAutoTurnSettings, settleAiTurn } from '../api'
import {
  AI_TURN_PASS_INTERVAL_MS, aiTurnNoticeText, autoMinutesFirstMessage, logForToday, nextAiTurn, recordOutcome, recordStarted, resumed,
  usageLimitReached, usagePauseUntil, type AiTurnLog, type AiTurnOutcome,
} from '../aiTurns'
import type { ChatInputRequest } from '../components/ChatConversation'

/** How often the runner looks (cheap: no server call unless something starts or ends). */
export const AI_TURN_TICK_MS = 3_000
/** A claimed turn whose consultation never started working within this time counts as failed. */
const START_TIMEOUT_MS = 2 * 60_000
const SETTINGS_TTL_MS = 10 * 60_000

interface Running {
  recordId: string
  tabId: string
  phase: 'claiming' | 'running'
  since: number
  sawWorking: boolean
}

export interface AiTurnRunnerOptions {
  companyId: string
  userId: string
  /** Received minutes waiting for the member's AI (「AI の番」), from main's minutes check. */
  queue: readonly MinutesNotice[]
  authMode: string
  /** The chosen AI is installed and signed in (the chat's setup check). */
  agentReady: boolean
  /** A new consultation tab behind the shown one; returns its tab id. */
  openBackgroundTab: () => string
  closeTab: (tabId: string) => void
  /** Hand that tab its request (it claims with its own conversation id, then sends). */
  deliver: (tabId: string, request: Extract<ChatInputRequest, { kind: 'aiTurn' }>) => void
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
  const [notice, setNotice] = useState<{ text: string | null; canResume: boolean }>({ text: null, canResume: false })

  const loadLog = useCallback((now: number) => memoryLog.current ? logForToday(memoryLog.current, now) : readLog(key, now), [key])
  const saveLog = useCallback((log: AiTurnLog) => { memoryLog.current = log; writeLog(key, log) }, [key])

  const settle = useCallback(async (run: Running, now: number) => {
    const o = latest.current
    const snapshot = rateLimitsOf('claude-code')
    const result = await settleAiTurn(o.companyId, run.recordId).catch(() => ({ outcome: 'unknown' as const }))
    const outcome: AiTurnOutcome = result.outcome === 'done' ? 'done' : usageLimitReached(snapshot) ? 'usage-limit' : 'failed'
    if (settings.current) saveLog(recordOutcome(loadLog(now), outcome, settings.current.value, usagePauseUntil(snapshot, now)))
    running.current = null
  }, [latest, loadLog, saveLog])

  const start = useCallback((notice: MinutesNotice, now: number) => {
    const o = latest.current
    const tabId = o.openBackgroundTab()
    const run: Running = { recordId: notice.id, tabId, phase: 'claiming', since: now, sawWorking: false }
    running.current = run
    if (!pass.current || now - pass.current.startedAt >= AI_TURN_PASS_INTERVAL_MS) pass.current = { startedAt: now, started: 0 }
    pass.current.started += 1
    o.deliver(tabId, {
      kind: 'aiTurn',
      message: autoMinutesFirstMessage(minutesFirstMessage(notice)),
      title: minutesConsultationTitle(notice),
      minutesId: notice.id,
      claim: async (conversationId: string) => {
        const result = await claimAiTurn(o.companyId, notice.id, notice.version, conversationId).catch(() => ({ claimed: false as const, reason: 'unavailable' as const }))
        if (running.current !== run) return false
        if (!result.claimed) {
          if (result.reason === 'taken') taken.current.add(`${notice.id}@${notice.version}`)
          running.current = null
          latest.current.closeTab(tabId)
          return false
        }
        saveLog(recordStarted(loadLog(Date.now()), notice.id))
        run.phase = 'running'
        run.since = Date.now()
        return true
      },
    })
  }, [latest, loadLog, saveLog])

  const tick = useCallback(async () => {
    if (ticking.current) return
    ticking.current = true
    try {
      const o = latest.current
      const now = Date.now()
      if (!running.current && o.queue.length === 0) {
        setNotice(prev => prev.text === null ? prev : { text: null, canResume: false })
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
        // An approval or a question keeps the turn running; 「確認をお願いします」 comes after it ended.
        const busy = status?.state === 'working' || (status?.state === 'needs-you' && status.kind !== 'review')
        if (busy) run.sawWorking = true
        const ended = status !== undefined && !busy && (run.sawWorking || status.state === 'unseen' || status.state === 'failed')
        if (ended || (!run.sawWorking && now - run.since > START_TIMEOUT_MS)) await settle(run, now)
      }
      const log = loadLog(now)
      const queue = o.queue.filter(n => !taken.current.has(`${n.id}@${n.version}`))
      const decision = nextAiTurn({
        settings: settings.current?.value ?? null, agent: o.authMode, agentReady: o.agentReady,
        busy: running.current !== null, log, queue, pass: pass.current, now,
      })
      const text = 'wait' in decision ? aiTurnNoticeText(decision.wait, { log, settings: settings.current?.value ?? null }) : null
      const canResume = 'wait' in decision && decision.wait === 'stopped'
      setNotice(prev => prev.text === text && prev.canResume === canResume ? prev : { text, canResume })
      if ('run' in decision) {
        const chosen = queue.find(n => n.id === decision.run.id)
        if (chosen) start(chosen, now)
      }
    } finally {
      ticking.current = false
    }
  }, [latest, loadLog, settle, start])

  useInterval(() => { void tick() }, AI_TURN_TICK_MS)

  const resume = useCallback(() => {
    saveLog(resumed(loadLog(Date.now())))
    setNotice({ text: null, canResume: false })
  }, [loadLog, saveLog])

  return { notice: notice.text, canResume: notice.canResume, resume }
}

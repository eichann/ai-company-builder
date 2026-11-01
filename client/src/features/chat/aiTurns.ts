// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md): the
// runner's rules, pure. Which record goes next, whether anything may start,
// and what the per-member log (runs today, failures in a row, the usage pause)
// becomes after a run. The hook (hooks/useAiTurnRunner.ts) only carries them out.
import { agentCan } from '../../../shared/agents/registry'
import type { AiTurnItemView, AutoTurnSettings } from '../../../shared/ai-turns'
import type { RateLimitSnapshot } from '../../../shared/rate-limits'

/** A record waiting for the member's AI (today: received minutes). */
export interface AiTurnCandidate {
  id: string
  title: string
  version: number
  /** When it is due (ISO), if the record has a due date. */
  dueAt?: string | null
  /** The meeting's time (ISO) for minutes. */
  meetingAt?: string | null
}

/** What the runner remembers per member and company (localStorage; lost = a fresh day). */
export interface AiTurnLog {
  /** Local day `YYYY-MM-DD` the counts belong to. */
  day: string
  runs: number
  /** Automatic attempts per record today: a record is tried at most `MAX_ATTEMPTS_PER_RECORD` times. */
  attempts: Record<string, number>
  failuresInARow: number
  /** Stopped after `stopAfterFailures` failures in a row, until the member resumes. */
  stopped: boolean
  /** Claude's usage limit: nothing starts before this time (epoch ms). */
  pausedUntil: number | null
  /** Records given to the person (not run again until 「もう一度」), with why. Kept across days. */
  handed: Record<string, HandOff>
}

/** Why a record went to the person instead of the AI. */
export interface HandOff {
  kind: 'failed' | 'urgent' | 'by-member'
  reason: string
}

/** At most this many records are started in one pass; the next pass comes `AI_TURN_PASS_INTERVAL_MS` later. */
export const AI_TURN_PASS_CAP = 3
export const AI_TURN_PASS_INTERVAL_MS = 10 * 60_000
/** A record that failed twice today waits for a person (its notice stays). */
export const MAX_ATTEMPTS_PER_RECORD = 2
/** A record due within this time is handed to the person rather than waiting for the AI. */
export const URGENT_WITHIN_MS = 2 * 60 * 60_000
/** No usable reset time from Claude: try again after an hour. */
const USAGE_PAUSE_FALLBACK_MS = 60 * 60_000

export type AiTurnWait =
  | 'off' | 'not-ready' | 'needs-claude' | 'paused-usage' | 'stopped' | 'daily-limit' | 'busy' | 'pass-cap' | 'empty'

export interface AiTurnDecisionInput {
  settings: AutoTurnSettings | null
  /** The chosen AI (registry id) and whether it is set up and signed in. */
  agent: string
  agentReady: boolean
  /** A run is in progress (one at a time). */
  busy: boolean
  log: AiTurnLog
  queue: readonly AiTurnCandidate[]
  /** This pass: when it began and how many it started. */
  pass: { startedAt: number; started: number } | null
  now: number
}

export function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function freshLog(now: number): AiTurnLog {
  return { day: localDay(now), runs: 0, attempts: {}, failuresInARow: 0, stopped: false, pausedUntil: null, handed: {} }
}

/** The stored log for today (another day: counts start again; a stop and a pause carry over). */
export function logForToday(stored: unknown, now: number): AiTurnLog {
  const s = stored && typeof stored === 'object' ? stored as Partial<AiTurnLog> : {}
  const base = freshLog(now)
  const stopped = s.stopped === true
  const pausedUntil = typeof s.pausedUntil === 'number' && s.pausedUntil > now ? s.pausedUntil : null
  const failuresInARow = typeof s.failuresInARow === 'number' && s.failuresInARow >= 0 ? s.failuresInARow : 0
  const handed: Record<string, HandOff> = {}
  for (const [id, h] of Object.entries(s.handed && typeof s.handed === 'object' ? s.handed : {})) {
    const x = h as Partial<HandOff> | null
    if (x && (x.kind === 'failed' || x.kind === 'urgent' || x.kind === 'by-member') && typeof x.reason === 'string') handed[id] = { kind: x.kind, reason: x.reason.slice(0, 300) }
  }
  if (s.day !== base.day) return { ...base, stopped, pausedUntil, failuresInARow, handed }
  const attempts: Record<string, number> = {}
  for (const [id, n] of Object.entries(s.attempts && typeof s.attempts === 'object' ? s.attempts : {})) if (typeof n === 'number') attempts[id] = n
  return { ...base, runs: typeof s.runs === 'number' && s.runs >= 0 ? s.runs : 0, attempts, stopped, pausedUntil, failuresInARow, handed }
}

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? Infinity : t
}

/** Earliest due first; without a due date, the oldest meeting first; then by id (stable). */
export function orderAiTurns(queue: readonly AiTurnCandidate[]): AiTurnCandidate[] {
  return [...queue].sort((a, b) =>
    time(a.dueAt) - time(b.dueAt) || time(a.meetingAt) - time(b.meetingAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The record to run now, or why nothing starts. The order of the checks is the order of the reasons shown. */
export function nextAiTurn(input: AiTurnDecisionInput): { run: AiTurnCandidate } | { wait: AiTurnWait } {
  const { settings, log, now } = input
  if (!settings || !settings.enabled) return { wait: 'off' }
  const waiting = orderAiTurns(input.queue).filter(c => !log.handed[c.id] && (log.attempts[c.id] ?? 0) < MAX_ATTEMPTS_PER_RECORD)
  if (waiting.length === 0) return { wait: 'empty' }
  // Codex and the API key cannot take the record's AI actions (registry recordActions).
  if (!agentCan(input.agent, 'recordActions')) return { wait: 'needs-claude' }
  if (!input.agentReady) return { wait: 'not-ready' }
  if (log.stopped) return { wait: 'stopped' }
  if (log.pausedUntil !== null && log.pausedUntil > now) return { wait: 'paused-usage' }
  if (log.runs >= settings.dailyLimit) return { wait: 'daily-limit' }
  if (input.busy) return { wait: 'busy' }
  if (input.pass && now - input.pass.startedAt < AI_TURN_PASS_INTERVAL_MS && input.pass.started >= AI_TURN_PASS_CAP) return { wait: 'pass-cap' }
  return { run: waiting[0] }
}

/** A run starts (counted when the claim succeeded). */
export function recordStarted(log: AiTurnLog, recordId: string): AiTurnLog {
  return { ...log, runs: log.runs + 1, attempts: { ...log.attempts, [recordId]: (log.attempts[recordId] ?? 0) + 1 } }
}

/** `failed`: the AI said it could not; `unfinished`: the turn ended (or broke) before the record was done. */
export type AiTurnOutcome = 'done' | 'failed' | 'unfinished' | 'usage-limit'

export const FAILED_REASON = 'AI が「読み取れない」と判断しました。理由は「AIへの相談」に残っています。'
export const UNFINISHED_REASON = 'AI が最後まで終えられませんでした。理由は「AIへの相談」に残っています。'

/**
 * After a run of `recordId`: success clears the failures; a failure hands the record to the
 * person at once with the reason (never left silently in 「AI の番」) and N in a row stop the
 * runner; Claude's limit pauses (not a failure, the record waits).
 */
export function recordOutcome(log: AiTurnLog, recordId: string, outcome: AiTurnOutcome, settings: AutoTurnSettings, pauseUntil: number): AiTurnLog {
  if (outcome === 'done') return { ...log, failuresInARow: 0 }
  if (outcome === 'usage-limit') return { ...log, pausedUntil: pauseUntil }
  const failuresInARow = log.failuresInARow + 1
  const reason = outcome === 'failed' ? FAILED_REASON : UNFINISHED_REASON
  return {
    ...log, failuresInARow, stopped: log.stopped || failuresInARow >= settings.stopAfterFailures,
    handed: { ...log.handed, [recordId]: { kind: 'failed', reason } },
  }
}

/** The member pressed 「もう一度自動で進める」. */
export function resumed(log: AiTurnLog): AiTurnLog {
  return { ...log, stopped: false, failuresInARow: 0, pausedUntil: null }
}

/** 「もう一度」 on one record: back to the AI (its hand-off and today's attempts cleared, a stop or pause lifted). */
export function retried(log: AiTurnLog, recordId: string): AiTurnLog {
  const handed = { ...log.handed }
  delete handed[recordId]
  const attempts = { ...log.attempts }
  delete attempts[recordId]
  return { ...resumed(log), handed, attempts }
}

/** 「人に渡す」: the member takes it (the AI will not start it), keeping why it stopped. */
export function handedOver(log: AiTurnLog, recordId: string, reason: string): AiTurnLog {
  return { ...log, handed: { ...log.handed, [recordId]: { kind: 'by-member', reason: reason ? `あなたが引き取りました（${reason}）` : 'あなたが引き取りました。' } } }
}

/**
 * Hand early: a record due soon that the AI has not started goes to the person now, rather than
 * waiting for the AI's preparation (its turn, a pause, a limit).
 */
export function handUrgent(log: AiTurnLog, queue: readonly AiTurnCandidate[], runningId: string | null, now: number): AiTurnLog {
  let handed: Record<string, HandOff> | null = null
  for (const c of queue) {
    if (c.id === runningId || log.handed[c.id]) continue
    const due = time(c.dueAt)
    if (due - now > URGENT_WITHIN_MS) continue
    handed ??= { ...log.handed }
    handed[c.id] = { kind: 'urgent', reason: '期限が近いため、AI の準備を待たずにお渡しします。' }
  }
  return handed ? { ...log, handed } : log
}

/**
 * Each waiting record's state for the screens (`AiTurnItemView`). `running` is the record whose
 * hidden consultation works now; `runningNeedsYou`: that AI waits for the member's answer.
 */
export function aiTurnItems(input: {
  queue: readonly AiTurnCandidate[]
  log: AiTurnLog
  wait: AiTurnWait | null
  noticeText: string | null
  running: { id: string; needsYou: boolean } | null
}): AiTurnItemView[] {
  const { log, wait, noticeText, running } = input
  return orderAiTurns(input.queue).map((c): AiTurnItemView => {
    const handed = log.handed[c.id]
    if (handed) return { recordId: c.id, state: handed.kind === 'failed' ? 'failed' : 'handed', reason: handed.reason, canRetry: true, canHand: false }
    if (running?.id === c.id) {
      return running.needsYou
        ? { recordId: c.id, state: 'handed', reason: 'AI があなたの答えを待っています（「AIへの相談」のあなたの番）。', canRetry: false, canHand: false }
        : { recordId: c.id, state: 'running', reason: '', canRetry: false, canHand: false }
    }
    if ((log.attempts[c.id] ?? 0) >= MAX_ATTEMPTS_PER_RECORD) return { recordId: c.id, state: 'failed', reason: UNFINISHED_REASON, canRetry: true, canHand: true }
    switch (wait) {
      case 'off':
        return { recordId: c.id, state: 'not-allowed', reason: '会社の設定で、AI の番は自動では進めません。', canRetry: false, canHand: true }
      case 'needs-claude':
      case 'not-ready':
        return { recordId: c.id, state: 'not-allowed', reason: noticeText ?? '', canRetry: true, canHand: true }
      case 'paused-usage':
      case 'stopped':
      case 'daily-limit':
        return { recordId: c.id, state: 'waiting', reason: noticeText ?? '', canRetry: true, canHand: true }
      default:
        return { recordId: c.id, state: 'waiting', reason: 'AI が順番に進めます。', canRetry: false, canHand: true }
    }
  })
}

/** Claude's usage limit is reached (the account's snapshot says rejected). */
export function usageLimitReached(snapshot: RateLimitSnapshot | undefined): boolean {
  return snapshot?.status === 'rejected'
}

/** Until when to pause: the latest reset of a full window, else the earliest future reset, else an hour. */
export function usagePauseUntil(snapshot: RateLimitSnapshot | undefined, now: number): number {
  const windows = (snapshot?.windows ?? []).filter(w => w.resetsAt !== null && w.resetsAt > now)
  const full = windows.filter(w => (w.usedPercent ?? 0) >= 100).map(w => w.resetsAt as number)
  if (full.length) return Math.max(...full)
  if (windows.length) return Math.min(...windows.map(w => w.resetsAt as number))
  return now + USAGE_PAUSE_FALLBACK_MS
}

/** What the member is told (null: nothing to say). Shown only while something waits for the AI. */
export function aiTurnNoticeText(wait: AiTurnWait, ctx: { log: AiTurnLog; settings: AutoTurnSettings | null }): string | null {
  switch (wait) {
    case 'needs-claude':
      return 'AI の番の自動実行には Claude Code が必要です。相談の設定で Claude Code を選ぶと、議事録の読み取りなどを自動で進めます。'
    case 'not-ready':
      return 'AI の番の自動実行には Claude Code へのログインが必要です。相談の設定から Claude Code にログインしてください。'
    case 'paused-usage': {
      const until = ctx.log.pausedUntil
      const at = until ? new Date(until) : null
      const when = at ? `（${at.getMonth() + 1}/${at.getDate()} ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')} ごろに再開します）` : ''
      return `Claude の利用上限に達したため、AI の番の自動実行を休んでいます${when}。`
    }
    case 'stopped':
      return `AI の番の自動実行が ${ctx.log.failuresInARow} 回続けてうまくいかなかったため、止めました。理由は「AIへの相談」に残っています。`
    case 'daily-limit':
      return `今日の自動実行の上限（${ctx.settings?.dailyLimit ?? 0} 回）に達しました。明日また自動で進めます。`
    default:
      return null
  }
}

/**
 * The first message of an automatic minutes reading (the app's, not the
 * member's words). The app already marked the start (its claim), and no one
 * is watching: the AI must end with finish_reading or fail_reading. The run
 * has no records_get, so the message names the record's version after the
 * start (`version`, from the claim; null when the server did not say).
 */
export function autoMinutesFirstMessage(base: string, version: number | null): string {
  return [
    '（アプリが AI の番として自動で始めた相談です。私はいま画面を見ていません。）',
    '',
    base,
    '',
    '自動で進めるときの決まり：',
    '- 読み始めの印（meeting__start_reading）はアプリがつけました。もう一度つけないでください。',
    ...(version !== null
      ? [`- 読み始めの印をつけたあとの会議の version は ${version} です。会議の操作（meeting__finish_reading など）の expectedVersion にはこれを使い、minutes_link_bundle でまとまりをつないだら、その答えの version を使ってください。`]
      : ['- 会議の操作（meeting__finish_reading など）の expectedVersion には、minutes_read の答えの version を使ってください。']),
    '- 「ほかの人が先に変えました」と断られたら、その答えの version でもう一度だけ試してください。',
    '- どのまとまり（案件など）の会議か決まらないときや私に聞きたいことがあるときは、作業を止めずに、最後に私へのお願いとしてまとめてください。',
    '- 最後に必ず meeting__finish_reading（読めなかったときは meeting__fail_reading）にしてください。',
  ].join('\n')
}

// 「AI の番」 run automatically (stage 2 S10, .claude/rules/ai-turns.md): the
// runner's rules, pure. Which record goes next, whether anything may start,
// and what the per-member log (runs today, failures in a row, the usage pause)
// becomes after a run. The hook (hooks/useAiTurnRunner.ts) only carries them out.
import { agentCan } from '../../../shared/agents/registry'
import type { AiTurnItemView, AutoTurnSettings } from '../../../shared/ai-turns'
import type { AiTurnCandidate } from '../../../shared/ai-turn-steps/types'
import type { RateLimitSnapshot } from '../../../shared/rate-limits'
import type { ConsultationStatus } from './consultationStatus'

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
  /**
   * When Claude said so (the rate-limit snapshot's `updatedAt`): only a snapshot newer than this
   * may lift the pause early (`usagePauseLifted`). null: no such time (a log from an older build).
   */
  pauseSeenAt: number | null
  /** Records given to the person (not run again until 「もう一度」), with why. Kept across days. */
  handed: Record<string, HandOff>
}

/** Why a record went to the person instead of the AI. */
export interface HandOff {
  kind: 'failed' | 'urgent' | 'by-member'
  reason: string
  /** The record's version the failed run started from: a newer one back in the queue was asked for again (`askedAgain`). */
  version?: number
  /**
   * The record's state it was handed in (a run's start, or the queue's when handed early): back in
   * the queue in another state, it is another turn of the AI (`movedOn`).
   */
  state?: string
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
  | 'off' | 'not-ready' | 'needs-claude' | 'stop-unconfirmed' | 'paused-usage' | 'stopped' | 'daily-limit' | 'busy' | 'pass-cap' | 'empty'

export interface AiTurnDecisionInput {
  settings: AutoTurnSettings | null
  /** The chosen AI (registry id) and whether it is set up and signed in. */
  agent: string
  agentReady: boolean
  /**
   * The company's stop policy is confirmed by the server in this app run, recently (main's
   * `aiTurns:stopConfirmed`). No person is present in an AI turn, so without it nothing starts
   * (owner decision 2026-11-09); the runner asks every tick and starts once it is.
   */
  stopConfirmed: boolean
  /** A run is in progress (one at a time). */
  busy: boolean
  log: AiTurnLog
  queue: readonly AiTurnCandidate[]
  /** This pass: when it began and how many it started. */
  pass: { startedAt: number; started: number } | null
  now: number
}

// Not 「AI が判断した」: most often it was Google that refused the text, and the app cannot tell here.
export const FAILED_REASON = '読み取れませんでした。理由は「AIへの相談」に残っています。'
/** What a log kept from an older build says: read as `FAILED_REASON`. */
const OLD_FAILED_REASON = 'AI が「読み取れない」と判断しました。理由は「AIへの相談」に残っています。'

export function localDay(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function freshLog(now: number): AiTurnLog {
  return { day: localDay(now), runs: 0, attempts: {}, failuresInARow: 0, stopped: false, pausedUntil: null, pauseSeenAt: null, handed: {} }
}

/** The stored log for today (another day: counts start again; a stop and a pause carry over). */
export function logForToday(stored: unknown, now: number): AiTurnLog {
  const s = stored && typeof stored === 'object' ? stored as Partial<AiTurnLog> : {}
  const base = freshLog(now)
  const stopped = s.stopped === true
  const pausedUntil = typeof s.pausedUntil === 'number' && s.pausedUntil > now ? s.pausedUntil : null
  const pauseSeenAt = pausedUntil !== null && typeof s.pauseSeenAt === 'number' ? s.pauseSeenAt : null
  const failuresInARow = typeof s.failuresInARow === 'number' && s.failuresInARow >= 0 ? s.failuresInARow : 0
  const handed: Record<string, HandOff> = {}
  for (const [id, h] of Object.entries(s.handed && typeof s.handed === 'object' ? s.handed : {})) {
    const x = h as Partial<HandOff> | null
    if (x && (x.kind === 'failed' || x.kind === 'urgent' || x.kind === 'by-member') && typeof x.reason === 'string') {
      handed[id] = {
        kind: x.kind, reason: x.reason === OLD_FAILED_REASON ? FAILED_REASON : x.reason.slice(0, 300),
        ...(typeof x.version === 'number' ? { version: x.version } : {}), ...(typeof x.state === 'string' && x.state ? { state: x.state.slice(0, 60) } : {}),
      }
    }
  }
  if (s.day !== base.day) return { ...base, stopped, pausedUntil, pauseSeenAt, failuresInARow, handed }
  const attempts: Record<string, number> = {}
  for (const [id, n] of Object.entries(s.attempts && typeof s.attempts === 'object' ? s.attempts : {})) if (typeof n === 'number') attempts[id] = n
  return { ...base, runs: typeof s.runs === 'number' && s.runs >= 0 ? s.runs : 0, attempts, stopped, pausedUntil, pauseSeenAt, failuresInARow, handed }
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
  if (!settings) return { wait: 'off' }
  // 「自動で進める」 off: only what the member asked for themselves (［AI に読ませる］) starts.
  const queue = settings.enabled ? input.queue : input.queue.filter(c => c.asked)
  if (queue.length === 0) return { wait: 'off' }
  const waiting = orderAiTurns(queue).filter(c => !log.handed[c.id] && (log.attempts[c.id] ?? 0) < MAX_ATTEMPTS_PER_RECORD)
  if (waiting.length === 0) return { wait: 'empty' }
  // Codex and the API key cannot take the record's AI actions (registry recordActions).
  if (!agentCan(input.agent, 'recordActions')) return { wait: 'needs-claude' }
  if (!input.agentReady) return { wait: 'not-ready' }
  if (!input.stopConfirmed) return { wait: 'stop-unconfirmed' }
  if (log.stopped) return { wait: 'stopped' }
  if (log.pausedUntil !== null && log.pausedUntil > now) return { wait: 'paused-usage' }
  if (log.runs >= settings.dailyLimit) return { wait: 'daily-limit' }
  if (input.busy) return { wait: 'busy' }
  if (input.pass && now - input.pass.startedAt < AI_TURN_PASS_INTERVAL_MS && input.pass.started >= AI_TURN_PASS_CAP) return { wait: 'pass-cap' }
  return { run: waiting[0] }
}

/**
 * Whether anything could start (「自動で進める」 on, or a record the member asked for): only then
 * does the runner ask main to confirm the stop policy, which asks the server while unconfirmed.
 */
export function mayStartAiTurns(settings: AutoTurnSettings | null, queue: readonly AiTurnCandidate[]): boolean {
  return !!settings && (settings.enabled || queue.some(c => c.asked))
}

/** A run starts (counted when the claim succeeded). */
export function recordStarted(log: AiTurnLog, recordId: string): AiTurnLog {
  return { ...log, runs: log.runs + 1, attempts: { ...log.attempts, [recordId]: (log.attempts[recordId] ?? 0) + 1 } }
}

/** `failed`: the AI said it could not; `unfinished`: the turn ended (or broke) before the record was done. */
export type AiTurnOutcome = 'done' | 'failed' | 'unfinished' | 'usage-limit'

export const UNFINISHED_REASON = 'AI が最後まで終えられませんでした。理由は「AIへの相談」に残っています。'

/**
 * After a run of `recordId`: success clears the failures; a failure hands the record to the
 * person at once with the reason (never left silently in 「AI の番」) and N in a row stop the
 * runner; Claude's limit pauses (not a failure, the record waits).
 */
export function recordOutcome(log: AiTurnLog, recordId: string, outcome: AiTurnOutcome, settings: AutoTurnSettings, pause: UsagePause | null, version?: number, state?: string | null): AiTurnLog {
  if (outcome === 'done') return { ...log, failuresInARow: 0 }
  if (outcome === 'usage-limit') return pause ? { ...log, pausedUntil: pause.until, pauseSeenAt: pause.seenAt } : log
  const failuresInARow = log.failuresInARow + 1
  const reason = outcome === 'failed' ? FAILED_REASON : UNFINISHED_REASON
  return {
    ...log, failuresInARow, stopped: log.stopped || failuresInARow >= settings.stopAfterFailures,
    handed: { ...log.handed, [recordId]: { kind: 'failed', reason, ...(version !== undefined ? { version } : {}), ...(state ? { state } : {}) } },
  }
}

/**
 * Records handed to the person in one state that are back in the queue in another (owner report
 * 2026-11-05): a 返事のお願い handed while the AI drafted (準備中) — a run that ended as the member's
 * reply moved it on, or due soon — is now 確かめ中, a new turn of the AI. The hand-off answered the
 * earlier turn; left in place, the record would sit in 「AI の番」 with nothing for anyone to do.
 * The member's own 「人に渡す」 stays until 「もう一度」, and so does a hand-off from an older build
 * (no state kept).
 */
export function movedOn(log: AiTurnLog, queue: readonly AiTurnCandidate[]): string[] {
  return queue.filter(c => {
    const h = log.handed[c.id]
    return !!h && h.kind !== 'by-member' && h.state !== undefined && !!c.state && c.state !== h.state
  }).map(c => c.id)
}

/**
 * Records a person asked for again after the AI could not do them: a `failed` outcome means the
 * record left the step's claim states (`settle.couldNot` / `closed`), so one back in the queue at a
 * newer version was put there by someone's ［AI に読ませる］, on any PC. Its hand-off answers the
 * earlier run, not this request (ai-turns.md "Asked again"). The same version is only a queue not
 * read again yet; an unfinished run never left the queue and waits for 「もう一度」. A hand-off
 * without a version comes from an older build, so from before this launch.
 */
export function askedAgain(log: AiTurnLog, queue: readonly AiTurnCandidate[]): string[] {
  return queue.filter(c => {
    const h = log.handed[c.id]
    return h?.kind === 'failed' && h.reason === FAILED_REASON && (h.version === undefined || c.version > h.version)
  }).map(c => c.id)
}

/** The member pressed 「もう一度自動で進める」. */
export function resumed(log: AiTurnLog): AiTurnLog {
  return { ...log, stopped: false, failuresInARow: 0, pausedUntil: null, pauseSeenAt: null }
}

/** 「もう一度自動で進める」 is offered for a stop after failures and for Claude's usage pause (another account may have room). */
export function canResumeAiTurns(wait: AiTurnWait | null): boolean {
  return wait === 'stopped' || wait === 'paused-usage'
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
    if (c.id === runningId || log.handed[c.id] || c.notUrgent) continue
    const due = time(c.dueAt)
    if (due - now > URGENT_WITHIN_MS) continue
    handed ??= { ...log.handed }
    handed[c.id] = { kind: 'urgent', reason: '期限が近いため、AI の準備を待たずにお渡しします。', ...(c.state ? { state: c.state } : {}) }
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
  /** 「自動で進める」 is off: only what the member asked for runs, the rest says so. */
  autoOff?: boolean
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
    switch (input.autoOff && !c.asked ? 'off' : wait) {
      case 'off':
        return { recordId: c.id, state: 'not-allowed', reason: '会社の設定で、AI の番は自動では進めません。', canRetry: false, canHand: true }
      case 'needs-claude':
      case 'not-ready':
        return { recordId: c.id, state: 'not-allowed', reason: noticeText ?? '', canRetry: true, canHand: true }
      case 'paused-usage':
      case 'stopped':
      case 'daily-limit':
        return { recordId: c.id, state: 'waiting', reason: noticeText ?? '', canRetry: true, canHand: true }
      // Resumes by itself once the server answers: nothing for 「もう一度」 to do.
      case 'stop-unconfirmed':
        return { recordId: c.id, state: 'waiting', reason: noticeText ?? '', canRetry: false, canHand: true }
      default:
        return { recordId: c.id, state: 'waiting', reason: 'AI が順番に進めます。', canRetry: false, canHand: true }
    }
  })
}

/** Claude's usage limit is reached (the account's snapshot says rejected). */
export function usageLimitReached(snapshot: RateLimitSnapshot | undefined): boolean {
  return snapshot?.status === 'rejected'
}

/** Claude's usage pause: until when, and the time of the snapshot that said so. */
export interface UsagePause { until: number; seenAt: number }

/** The pause a rejecting snapshot asks for (`usagePauseUntil`), remembered with the snapshot's time. */
export function usagePause(snapshot: RateLimitSnapshot | undefined, now: number): UsagePause {
  return { until: usagePauseUntil(snapshot, now), seenAt: snapshot?.updatedAt ?? now }
}

/**
 * Lift Claude's usage pause before its reset time when the chosen AI or its sign-in changed on this
 * PC (`agentChanged`: perhaps another account), or when a rate-limit snapshot **newer than the one
 * that paused** says Claude takes requests again (another account, an earlier reset, a plan change:
 * seen in a normal consultation's turn). A snapshot from before the pause (the main process's
 * cache, a fetch after a reload) never lifts it, nor does one when the pause has no time (a log
 * from an older build). If the next run hits the limit again, it simply pauses again.
 */
export function usagePauseLifted(log: AiTurnLog, snapshot: RateLimitSnapshot | undefined, agentChanged = false): AiTurnLog {
  if (log.pausedUntil === null) return log
  const newerRoom = !!snapshot && log.pauseSeenAt !== null && snapshot.updatedAt > log.pauseSeenAt && !usageLimitReached(snapshot)
  return agentChanged || newerRoom ? { ...log, pausedUntil: null, pauseSeenAt: null } : log
}

/**
 * The hidden consultation's name after a run, when the run renamed its record (a message without a
 * subject gets the AI's title, inbox.md): `renamed` is the step's title made from the record's
 * title now. Only while the consultation still has the name the runner gave it (`given`): a name
 * the member edited is theirs and is never overwritten. null: nothing to rename.
 */
export function retitledConsultation(input: { given: string; current: string | null | undefined; renamed: string }): string | null {
  const { given, current, renamed } = input
  return current === given && renamed.trim() !== '' && renamed !== given ? renamed : null
}

// --- Closing the automatic consultation (owner FB #28, 2026-11-11) ------------

/**
 * What an automatic consultation's tab holds now, read live from the tab (the stored summary lags:
 * the draft is saved every few seconds, attachments never). Absent for a tab not mounted here.
 */
export interface ConsultationHold {
  /** Its history was restored (until then nothing below is known). */
  ready: boolean
  /** Unsent text in its input. */
  draft: string
  /** Images or files attached in its input and not sent. */
  attachments: number
  /** A turn runs, messages wait to go out, or the AI waits for an approval or an answer. */
  busy: boolean
  /** The member sent a message of their own there (anything after the app's first message). */
  memberWrote: boolean
  /** It is the tab shown in front. */
  shown: boolean
}

/** Nothing of the member's would go with it: no draft, no attachment, nothing running or written by them. */
function holdsNothingOfTheMember(hold: ConsultationHold | undefined): hold is ConsultationHold {
  return !!hold && hold.ready && !hold.busy && !hold.draft.trim() && hold.attachments === 0 && !hold.memberWrote
}

/**
 * When an automatic run ends, its consultation closes by itself (a normal close: 「終わったもの」, the
 * history kept) when the run ended well (`done`) and the member has nothing to do there. It stays
 * open when the AI asks for a review (「確認をお願いします」), when it failed or stopped (any other
 * outcome, or the tab's status 'failed'), when the member wrote in it or has a draft or an
 * attachment there, while anything still runs, and while it is the tab shown in front (the member
 * is reading it).
 */
export function closesWhenRunEnds(outcome: AiTurnOutcome, status: ConsultationStatus | undefined, hold: ConsultationHold | undefined): boolean {
  if (outcome !== 'done' || !status || (status.state !== 'unseen' && status.state !== 'idle')) return false
  return holdsNothingOfTheMember(hold) && !hold.shown
}

/**
 * When the member ends the record (完了 / 済んだ / 終わりにする, on the card or with the list's ☑), its
 * automatic consultations close too — also one that stayed open for a review or after a failure,
 * and also the one shown in front (the member ended the thing it was about). Never one the member
 * wrote in, has a draft or an attachment in, or whose AI still runs or waits for an approval or an
 * answer (closing would stop it).
 */
export function closesWhenRecordEnds(hold: ConsultationHold | undefined): boolean {
  return holdsNothingOfTheMember(hold)
}

/** The automatic consultations remembered on this PC: [conversation id, record id], oldest first. */
export type AutomaticConsultations = ReadonlyArray<readonly [sessionId: string, recordId: string]>
/** How many are remembered (older ones are forgotten: their tabs were closed long ago, or stay as the member left them). */
export const AUTOMATIC_CONSULTATIONS_KEPT = 200

/** The list after a run's consultation claimed its record. */
export function rememberedAutomatic(list: AutomaticConsultations, sessionId: string, recordId: string): AutomaticConsultations {
  return [...list.filter(([s]) => s !== sessionId), [sessionId, recordId] as const].slice(-AUTOMATIC_CONSULTATIONS_KEPT)
}

/** The list without these consultations (closed). */
export function forgottenAutomatic(list: AutomaticConsultations, sessionIds: readonly string[]): AutomaticConsultations {
  const gone = new Set(sessionIds)
  return list.filter(([s]) => !gone.has(s))
}

/** The automatic consultations of one record. */
export function automaticConsultationsOf(list: AutomaticConsultations, recordId: string): string[] {
  return list.filter(([, r]) => r === recordId).map(([s]) => s)
}

/** Reads the stored list; anything malformed is dropped. */
export function readAutomaticConsultations(stored: unknown): AutomaticConsultations {
  if (!Array.isArray(stored)) return []
  return stored.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
    .slice(-AUTOMATIC_CONSULTATIONS_KEPT)
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
/** No stop policy confirmed by the server (offline, or not answered yet since the app started). */
export const STOP_UNCONFIRMED_TEXT = '止める設定をサーバーで確かめられないため、AI の番を自動では始めていません。サーバーにつながると自動で再開します。'

export function aiTurnNoticeText(wait: AiTurnWait, ctx: { log: AiTurnLog; settings: AutoTurnSettings | null }): string | null {
  switch (wait) {
    case 'needs-claude':
      return 'AI の番の自動実行には Claude Code が必要です。相談の設定で Claude Code を選ぶと、議事録の読み取りなどを自動で進めます。'
    case 'not-ready':
      return 'AI の番の自動実行には Claude Code へのログインが必要です。相談の設定から Claude Code にログインしてください。'
    case 'stop-unconfirmed':
      return STOP_UNCONFIRMED_TEXT
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

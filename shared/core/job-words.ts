/**
 * The words of scheduled jobs (定期の仕事, `.claude/rules/jobs.md` "The screens", PR 4): what a definition,
 * a state and an occurrence say in plain Japanese, for the admin console's 「定期の仕事」 and the app's
 * 「受け取る」 — one copy, so the person accepting reads the same sentences the admin approved.
 *
 * Words only: no rule is decided here (the parser is `jobs.ts`, the slots `job-schedule.ts`). Pure
 * (server/tests/unit/core-purity.test.ts).
 */
import { JOB_MINUTES_ROUTE, jobDeliveryLabel, type JobCheck, type JobDefinition, type JobGrant, type JobMissed, type JobOccurrenceState, type JobPauseReason, type JobRun, type JobTrigger, type JobWeekday } from './jobs'

const WEEKDAY_WORDS: Record<JobWeekday, string> = { mon: '月曜', tue: '火曜', wed: '水曜', thu: '木曜', fri: '金曜', sat: '土曜', sun: '日曜' }

/** 「毎週火曜の1営業日前 09:00」, 「毎営業日 09:00」, 「毎月末日 09:00（休みの日なら前の営業日）」. */
export function jobTriggerText(trigger: JobTrigger): string {
  if (trigger.every === 'day') return `${trigger.businessDaysOnly ? '毎営業日' : '毎日'} ${trigger.at}`
  if (trigger.every === 'week') {
    const day = WEEKDAY_WORDS[trigger.weekday]
    return trigger.businessDaysBefore > 0 ? `毎週${day}の${trigger.businessDaysBefore}営業日前 ${trigger.at}` : `毎週${day} ${trigger.at}`
  }
  const day = trigger.day === 'last' ? '末日' : `${trigger.day}日`
  const moved = trigger.ifHoliday === 'before' ? '（休みの日なら前の営業日）' : trigger.ifHoliday === 'after' ? '（休みの日なら次の営業日）' : ''
  return `毎月${day} ${trigger.at}${moved}`
}

/** What runs, in one sentence. */
export function jobRunText(run: JobRun): string {
  if (run.kind === 'operation') {
    const due = run.dueBusinessDays === null ? '期限なし' : run.dueBusinessDays === 0 ? '期限はその日' : `期限は${run.dueBusinessDays}営業日後`
    return `責任者に、やること「${run.title}」を作ります（${due}）。AI は使いません`
  }
  const skill = run.procedure.source === 'shelf_skill' ? `会社の Skill の棚の「${run.procedure.skill}」` : `会社の Skill「${run.procedure.skill}」`
  return `${skill}を、責任者の PC の AI が動かします`
}

/** The check before running, or null when there is none. */
export function jobCheckText(check: JobCheck): string | null {
  if (check.kind === 'new_files') return `「${check.path}」に新しいファイルがあるときだけ動きます`
  if (check.kind === 'new_meetings') {
    const words = check.titleWords.length > 0 ? `（名前に${check.titleWords.map(w => `「${w}」`).join('か')}を含むもの）` : ''
    return `前の回のあとに責任者が出た会議${words}があるときだけ動きます`
  }
  return null
}

/** A missed occurrence (the server was down at that time). */
export function jobMissedText(missed: JobMissed): string {
  const within = jobMinutesText(missed.expiresAfterMinutes)
  return missed.policy === 'latest_only'
    ? `時間に動けなかったときは、${within}以内なら一番新しい回だけ動きます`
    : `時間に動けなかった回は見送ります（${within}で期限切れ）`
}

/** 30 → 「30分」, 90 → 「1時間30分」, 1440 → 「1日」. */
export function jobMinutesText(minutes: number): string {
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  return [days ? `${days}日` : '', hours ? `${hours}時間` : '', mins ? `${mins}分` : ''].join('') || '0分'
}

const TOOL_WORDS: Record<string, string> = {
  records: 'やること・記録を読む（作るのは、終わったときのやること1つだけ）',
  approvals: '承認のお願いを出す',
  outbound_draft: 'メールの下書きを作る（送るのは人）',
  files_read: '下の場所のファイルを読む',
  files_write: '決めたフォルダにファイルを置く',
}

/**
 * What the grant lets a run do, line by line — the part the responsible person accepts with who runs it
 * and what (`jobConsentCanonical`). Places are named as written: only shown to someone who reads them.
 */
export function jobGrantLines(grant: JobGrant): string[] {
  const lines: string[] = []
  for (const t of grant.tools) lines.push(`道具：${TOOL_WORDS[t] ?? t}`)
  if (grant.reads.paths.length > 0) lines.push(`読む場所：${grant.reads.paths.map(p => `「${p}」`).join('・')}`)
  if (grant.writes.area === 'deliverable') lines.push(`置く場所：「${grant.writes.place}」の中の、責任者だけのフォルダ「${grant.writes.folder}」`)
  // The exact place outside is the responsible person's choice when accepting: the line names its kind only.
  if (grant.deliverTo) lines.push(`できたものを置く先：${jobDeliveryLabel(grant.deliverTo) ?? 'つなぎ先'}（責任者が受け取るときに選ぶ1か所だけ。社外の人も見られる場所には置きません）`)
  if (grant.creates.includes('task')) lines.push('作れるもの：やること')
  if (grant.routes.includes(JOB_MINUTES_ROUTE)) lines.push('議事録：確かめで見つかった、責任者が出た会議のものだけ読む')
  if (grant.routes.length > 0) lines.push(`使える操作：${grant.routes.length}種類`)
  lines.push(grant.outbound === 'draft_only' ? '外に送るもの：下書きまで（送るのは人）' : '外に送るもの：なし')
  lines.push(`上限：1回 ${jobMinutesText(grant.limits.minutes)}・1日 ${grant.limits.runsPerDay}回`)
  return lines
}

/** Where it runs. */
export function jobPlacementText(placement: JobDefinition['placement']): string {
  return placement === 'e' ? 'サーバー（AI は使いません）' : '責任者の PC'
}

/** Why a job is paused (`pausedReason`). */
export function jobPauseReasonText(reason: JobPauseReason | null): string {
  switch (reason) {
    case 'ADMIN': return '管理者が止めました'
    case 'BY_RESPONSIBLE': return '責任者が止めました'
    case 'OWNER_LEFT': return '責任者が会社を離れたため止まりました。新しい責任者を決めてください'
    case 'OWNER_RIGHTS_CHANGED': return '責任者の権限が変わり、仕事の範囲に足りなくなったため止まりました'
    default: return '止まっています'
  }
}

/** Why it would not run now (`waiting`), or that it runs. */
export function jobWaitingText(waiting: 'NOT_APPROVED' | 'NOT_ACCEPTED' | 'PAUSED' | 'COMPANY_STOPPED' | null, pausedReason: JobPauseReason | null): string {
  switch (waiting) {
    case 'NOT_APPROVED': return 'まだ承認されていません'
    case 'NOT_ACCEPTED': return '責任者の受け取り待ちです（受け取るまで動きません）'
    case 'PAUSED': return jobPauseReasonText(pausedReason)
    case 'COMPANY_STOPPED': return '「定期の仕事をすべて止める」が入っています'
    default: return '動いています'
  }
}

/**
 * Whether it runs, as a person reads it: `jobWaitingText`, except that a job on the responsible person's PC
 * (placement `a`) runs only while their app is open with 自動で進める on (B PR 5a-2) — said so, never a bare
 * 「動いています」 for one.
 */
export function jobRunsText(waiting: 'NOT_APPROVED' | 'NOT_ACCEPTED' | 'PAUSED' | 'COMPANY_STOPPED' | null, pausedReason: JobPauseReason | null, placement: JobDefinition['placement'] | undefined | null): string {
  if (waiting === null && placement === 'a') return '動いています（責任者のアプリが開いていて「自動で進める」が入っているときに動きます）'
  return jobWaitingText(waiting, pausedReason)
}

const OUTCOME_WORDS: Record<string, string> = {
  JOB_PAUSED: '仕事が止まっていたため動かしませんでした',
  COMPANY_STOPPED: '「定期の仕事をすべて止める」が入っていたため動かしませんでした',
  NOT_ACCEPTED: '責任者の受け取り前だったため動かしませんでした',
  JOB_VERSION_CHANGED: '別の版が承認されたため、この回は動かしませんでした',
  OWNER_LEFT: '責任者が会社を離れていたため動かしませんでした',
  OWNER_RIGHTS_CHANGED: '責任者の権限が足りなくなっていたため動かしませんでした',
  OWNER_ABSENT: '責任者が不在の日だったため見送りました（代わりの人は動かしません）',
  SUPERSEDED: '新しい回が来たため、この回は見送りました',
  MISSED: '時間に動けず、「見送る」決まりのため見送りました',
  EXPIRED: '期限までに動かなかったため見送りました',
  RECORDS_OFF: '記録の機能がオフのため、やることを作れませんでした',
  TASK_NOT_CREATED: 'やることを作れませんでした',
  RUN_FAILED: 'AI がこの回を終えられなかったため、人が確かめる必要があります',
  TIME_LIMIT: '承認された時間を過ぎたため AI を止めました。人が確かめる必要があります',
  RESULT_UNKNOWN: '外への操作が済んだか分からないまま時間が来ました。人が確かめる必要があります',
  PLACE_NOT_USABLE: '責任者が選んだ置き先が使えなくなっていました（使える期間が過ぎたか、消されました）。責任者が「受け取る」から選び直してください',
}

const STATE_WORDS: Record<JobOccurrenceState, string> = {
  due: 'これから動きます',
  running: '動いています',
  done: 'できました',
  nothing: '確かめたところ、することがありませんでした',
  needs_person: '人が確かめる必要があります',
  skipped: '見送りました',
  expired: '期限切れ',
  held: '動かしませんでした',
}

/** An occurrence's state: a short label and, when there is one, why. */
export function jobOccurrenceText(state: JobOccurrenceState, outcomeCode: string | null): { label: string; why: string | null } {
  return { label: STATE_WORDS[state] ?? state, why: outcomeCode ? OUTCOME_WORDS[outcomeCode] ?? null : null }
}

/** `2026-11-05T09:00` → 「11月5日 09:00」 (as given when it is not a slot). */
export function jobSlotText(slot: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(slot)
  return m ? `${Number(m[2])}月${Number(m[3])}日 ${m[4]}` : slot
}

const RETRY_BLOCK_WORDS: Record<string, string> = {
  NOT_RETRYABLE: 'この回は「もう一度」できません（人が確かめる回と、期限切れの回だけです）',
  NOT_LATEST: 'このあとの回がもう来ているため、この回は「もう一度」できません',
  JOB_PAUSED: '仕事が止まっています。再開してから押してください',
  JOB_STOPPED: '「定期の仕事をすべて止める」が入っています',
  AI_STOPPED: '責任者の AI が止められています（緊急停止）',
  JOB_VERSION_CHANGED: 'この回のあとに別の版が承認されたため、「もう一度」できません',
  JOB_NOT_ACCEPTED: '責任者がまだ今の版を受け取っていません',
  JOB_GRANT_EXCEEDS: '責任者の今の権限では、この仕事の範囲に足りません',
  JOB_SKILL_MISSING: '手順の Skill が、承認された版のまま見つかりません',
  JOB_PLACE_NOT_USABLE: 'できたものを置く先が使えなくなっています。責任者が「受け取る」から選び直してください',
  JOB_RESULT_UNKNOWN: '外への操作（メールの下書きなど）が済んだか分からないものがあります。先に確かめてください',
}

/** Why 「もう一度」 cannot be pressed now, in plain words (`JOB_RETRY_BLOCKS`). */
export function jobRetryBlockText(code: string): string {
  return RETRY_BLOCK_WORDS[code] ?? '今は「もう一度」できません'
}

/** What an outside operation of a run was, in plain words (the run's operation kind; anything else: 外への操作). */
export function jobOperationKindText(kind: string): string {
  if (kind === 'mail-draft' || kind === 'mail-draft-version' || kind === 'outbound') return 'メールの下書き'
  if (kind === 'drive-put') return 'Google Drive に置くファイル'
  return '外への操作'
}

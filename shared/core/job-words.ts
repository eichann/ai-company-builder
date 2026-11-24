/**
 * The words of scheduled jobs (定期の仕事, `.claude/rules/jobs.md` "The screens", PR 4): what a definition,
 * a state and an occurrence say in plain Japanese, for the admin console's 「定期の仕事」 and the app's
 * 「受け取る」 — one copy, so the person accepting reads the same sentences the admin approved.
 *
 * Words only: no rule is decided here (the parser is `jobs.ts`, the slots `job-schedule.ts`). Pure
 * (server/tests/unit/core-purity.test.ts).
 */
import { JOB_MINUTES_ROUTE, isRecordTrigger, isSetTrigger, jobDeliveryLabel, jobSetWatchOpened, type JobCheck, type JobSetTrigger, type JobRecordTrigger, type JobDefinition, type JobGrant, type JobMissed, type JobOccurrenceState, type JobPauseReason, type JobRun, type JobTrigger, type JobWeekday } from './jobs'

const WEEKDAY_WORDS: Record<JobWeekday, string> = { mon: '月曜', tue: '火曜', wed: '水曜', thu: '木曜', fri: '金曜', sat: '土曜', sun: '日曜' }

/** The record types an event-triggered job may watch, as people call them (stage 4a). */
const EVENT_TYPE_WORDS: Record<string, string> = { task: 'やること' }
/** Their states, in the words the app's screens use (client/shared/thing-words.ts). */
const EVENT_STATE_WORDS: Record<string, Record<string, string>> = {
  task: {
    todo: '未着手', in_progress: '進めている', review: '確かめてもらっている', waiting: '返事待ち', done: '完了',
    cancelled: 'アーカイブ済み', declined: '受けられないと返した', awaiting_acceptance: '引き受け待ち',
  },
}

/** A state of a type an event-triggered job may watch, in plain words (the name itself for one this build does not know). */
export function jobEventStateText(type: string, state: string): string {
  return EVENT_STATE_WORDS[type]?.[state] ?? state
}

/**
 * 「見張っているやること（責任者が担当）が「完了」になったとき（次は、この仕事が作ったやることを見張ります）」 (stage 4a). Never the
 * watched record's title: who reads the sentence may not read it.
 */
export function jobRecordTriggerText(trigger: JobRecordTrigger): string {
  const what = `見張っている${EVENT_TYPE_WORDS[trigger.type] ?? trigger.type}（責任者が担当）`
  const to = `「${jobEventStateText(trigger.type, trigger.to)}」`
  const when = trigger.from ? `${what}が「${jobEventStateText(trigger.type, trigger.from)}」から${to}になったとき` : `${what}が${to}になったとき`
  return trigger.followMadeTask ? `${when}（そのあとは、この仕事が作ったやることを見張ります）` : `${when}（1回だけ）`
}

/**
 * A set watch (schema 5, owner memo 「4b-4」 §2-1): the one combination opened today in its words; any other (a later build's, or
 * one no longer opened) is never described as if it were that one.
 */
export function jobSetTriggerText(trigger: JobSetTrigger): string {
  if (!jobSetWatchOpened(trigger)) return 'この画面では説明できない条件です（画面を新しくしてください）'
  return '自分が担当の「議事録を確認する」を初めて完了したとき（これから来る、条件に合うもの全部。社外の人が出た会議だけ、1つの会議につき1回）'
}

/**
 * What an event-triggered job never runs for (owner decision ②, the memo's 「制約として画面と例に書く」): shown with its
 * trigger on every screen that shows one.
 */
export const JOB_EVENT_NOTE = '見張るのは選んだやること1つだけです（名前を変えても同じもの）。人（と、その人の相談の中の AI）が変えたときに動きます。定期の仕事や「AI の番」が変えたとき、業務の画面から変えたとき、取り込みで入ったときは動きません。同じやることで動くのは1回だけ、止めている間の出来事は再開しても動きません'

/** 「毎週火曜の1営業日前 09:00」, 「毎営業日 09:00」, 「毎月末日 09:00（休みの日なら前の営業日）」; an event: `jobRecordTriggerText`. */
export function jobTriggerText(trigger: JobTrigger): string {
  if (isRecordTrigger(trigger)) return jobRecordTriggerText(trigger)
  if (isSetTrigger(trigger)) return jobSetTriggerText(trigger)
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
  const p = run.procedure
  const skill = p.source === 'shelf_skill' ? `会社の Skill の棚の「${p.skill}」`
    : p.source === 'department_skill' ? `「${p.place}」の Skill「${p.skill}」` : `会社の Skill「${p.skill}」`
  return `${skill}を、責任者の PC の AI が動かします`
}

/** The check before running, or null when there is none. */
export function jobCheckText(check: JobCheck): string | null {
  if (check.kind === 'new_files') return `「${check.path}」に新しいファイルがあるときだけ動きます`
  if (check.kind === 'new_meetings') {
    const words = check.titleWords.length > 0 ? `（名前に${check.titleWords.map(w => `「${w}」`).join('か')}を含むもの）` : ''
    return `前の回のあとに責任者が出た会議${words}があるときだけ動きます`
  }
  if (check.kind === 'source_record') {
    const mark = check.doneMark === 'file_linked' ? '。そのやることにファイルがもうつながっていれば、AI は動きません' : ''
    return `見張っているやることが今もその状態で、担当が責任者のままのときだけ、AI が動きます（途中で変わったら止めます）${mark}`
  }
  if (check.kind === 'matched_record') return 'その会議を今も読めて、条件に合っているときだけ、AI がその会議の議事録だけを読みます（途中で変わったら止めます）'
  return null
}

/** A missed occurrence (the server was down at that time). An event's occurrence: when it expires. */
export function jobMissedText(missed: JobMissed, trigger?: JobTrigger): string {
  const within = jobMinutesText(missed.expiresAfterMinutes)
  if (trigger && isRecordTrigger(trigger)) return `出来事のあと${within}のうちに動けなかったときは見送ります`
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
export function jobGrantLines(grant: JobGrant, trigger?: JobTrigger): string[] {
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
  // An event job (stage 4a): the day's limit is kept (company time); what comes beyond it is not run. Run by the PC's AI
  // (schema 3, stage 4b-3) its minutes per run are a hard limit too — such a grant always has tools (it creates its やること
  // with `records`), the server's operation never has any (`grant.OPERATION_TAKES_NO_AI_POWERS`).
  const dayLimit = `1日 ${grant.limits.runsPerDay}回まで（超えた出来事は動かさず、責任者に知らせます）`
  lines.push(trigger && isRecordTrigger(trigger)
    ? (grant.tools.length > 0 ? `上限：1回 ${jobMinutesText(grant.limits.minutes)}・${dayLimit}` : `上限：${dayLimit}`)
    : `上限：1回 ${jobMinutesText(grant.limits.minutes)}・1日 ${grant.limits.runsPerDay}回`)
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
  EVENT_RECORD_GONE: 'きっかけの記録が見られなくなっていたため見送りました',
  EVENT_NOT_ASSIGNEE: 'きっかけの記録の担当が、責任者ではなくなっていたため見送りました',
  EVENT_AI_TURN: 'きっかけの記録が「AI の番」の状態になっていたため見送りました',
  EVENT_NOT_WATCHED: '見張るやることが変わったため、この回は見送りました',
  EVENT_NOT_NEEDED: 'きっかけのやることがその状態ではなくなったため、AI を動かしませんでした',
  EVENT_DONE_MARK: 'きっかけのやることにファイルがもうつながっていたため、AI を動かしませんでした',
  MADE_THEN_STOPPED: '途中で続けられなくなりましたが、外にすでに作ったものがあります。人が確かめる必要があります',
  SET_WATCH_NOT_OPENED: 'この定期の仕事の条件が、いまのサーバーで使える組み合わせではなくなったため、動かしませんでした',
  SET_WATCH_MEETING_CHANGED: 'きっかけのやることにつながる会議が変わったため、この回は見送りました',
}

/**
 * Why an event job's chain stopped, in plain words (owner decision ①). `record`: the watched record's title when the
 * viewer reads it now, else null — then only 「見張っていたやることの都合で止まりました」, whatever the cause: every stop is
 * record-side (even the day's limit or an absence says the record reached the watched state, D7), and only the
 * responsible person is shown a stop of a record they do not read (`jobs.ts` `chainOf`).
 */
export function jobChainStopText(code: string, opts: { runsPerDay: number | null; record: string | null }): string {
  if (opts.record === null) return '見張っていたやることの都合で止まりました'
  const named = `「${opts.record}」`
  switch (code) {
    case 'DAY_LIMIT': return `1日の上限（${opts.runsPerDay ?? '決められた'}回）を超えたため、止まりました`
    case 'OWNER_ABSENT': return '責任者が不在の日に完了したため、止まりました'
    case 'PAUSED_EVENT': case 'JOB_PAUSED': case 'COMPANY_STOPPED': return '一時停止している間に完了したため、止まりました'
    case 'VERSION_EVENT': case 'JOB_VERSION_CHANGED': case 'NOT_ACCEPTED': return '仕事の内容が変わったため、止まりました'
    case 'EXPIRED': return '期限までに動けなかったため、止まりました'
    case 'RECORDS_OFF': case 'TASK_NOT_CREATED': return '次のやることを作れなかったため、止まりました'
    case 'OWNER_LEFT': case 'OWNER_RIGHTS_CHANGED': return '責任者がこの仕事を続けられなくなったため、止まりました'
    case 'WATCH_RESET': return '仕組みの入れ替えのため、止まりました'
    case 'TIME_LIMIT': case 'RUN_FAILED': case 'RESULT_UNKNOWN': case 'MADE_THEN_STOPPED': case 'PLACE_NOT_USABLE':
      return 'AI がこの回を終えられなかったため、止まりました'
  }
  if (code === 'EVENT_NOT_NEEDED') return `見張っていたやること${named}がその状態でなくなったため、止まりました`
  if (code === 'EVENT_DONE_MARK') return `見張っていたやること${named}にファイルがもうつながっていたため、止まりました`
  if (code === 'EVENT_NOT_ASSIGNEE') return `見張っていたやること${named}の担当が責任者でなくなったため、止まりました`
  if (code === 'EVENT_RECORD_GONE') return `責任者が見張っていたやること${named}を見られなくなったため、止まりました`
  if (code === 'EVENT_AI_TURN') return `見張っていたやること${named}が「AI の番」の状態だったため、止まりました`
  return `見張っていたやること${named}の都合で止まりました`
}

/** What a stopped chain asks of the responsible person. */
export const JOB_CHAIN_STOPPED_ASK = '止まっています。次に見張るやることを選び直してください'

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
  RETRY_LIMIT: 'この回はもう3回「もう一度」をしました。次の回を待つか、仕事の内容を見直してください',
  NEXT_SLOT_SOON: '次の回が近いため、もう一度はできません（次の回が動きます）',
  SOURCE_CHANGED: 'きっかけのやることが変わったため（状態・担当・見張り・ファイルのつながりなど）、もう一度はできません',
  RECORDS_OFF: '記録の機能がオフのため、もう一度はできません',
  JOB_SCHEMA_UNKNOWN: 'この定期の仕事は新しい版のサーバーで作られたため、このサーバーでは「もう一度」できません',
}

/** Why 「もう一度」 cannot be pressed now, in plain words (`JOB_RETRY_BLOCKS`). */
export function jobRetryBlockText(code: string): string {
  return RETRY_BLOCK_WORDS[code] ?? '今は「もう一度」できません'
}

/**
 * What earlier runs of an occurrence already made, as one sentence (「前回すでにメールの下書きを1件作っています。」), or null
 * when nothing is known to have been made.
 */
export function jobMadeBeforeText(made: ReadonlyArray<{ kind: string; count: number }>): string | null {
  const parts = made.filter(m => m.count > 0).map(m => `${jobOperationKindText(m.kind)}を${m.count}件`)
  return parts.length === 0 ? null : `前回すでに${parts.join('・')}作っています。`
}

/** What an outside operation of a run was, in plain words (the run's operation kind; anything else: 外への操作). */
export function jobOperationKindText(kind: string): string {
  if (kind === 'mail-draft' || kind === 'mail-draft-version' || kind === 'outbound') return 'メールの下書き'
  if (kind === 'drive-put') return 'Google Drive に置くファイル'
  return '外への操作'
}

/**
 * The words of scheduled jobs (定期の仕事, `.claude/rules/jobs.md` "The screens", PR 4): what a definition,
 * a state and an occurrence say in plain Japanese, for the admin console's 「定期の仕事」 and the app's
 * 「受け取る」 — one copy, so the person accepting reads the same sentences the admin approved.
 *
 * Words only: no rule is decided here (the parser is `jobs.ts`, the slots `job-schedule.ts`). Pure
 * (server/tests/unit/core-purity.test.ts).
 */
import { JOB_MINUTES_ROUTE, isRecordTrigger, isSetTrigger, jobDeliveryLabel, jobSetWatchLine, type JobCheck, type JobSetTrigger, type JobSetWatchLine, type JobRecordTrigger, type JobDefinition, type JobGrant, type JobMissed, type JobOccurrenceState, type JobPauseReason, type JobRun, type JobTrigger, type JobWeekday } from './jobs'

/** A weekday as people say it (also the card's choices, UX 段3 #13). */
export const JOB_WEEKDAY_WORDS: Record<JobWeekday, string> = { mon: '月曜', tue: '火曜', wed: '水曜', thu: '木曜', fri: '金曜', sat: '土曜', sun: '日曜' }

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
 * A set watch (schema 5, owner memo 「4b-4」 §2-1): each opened combination in its own words; any other (a later build's, or one no
 * longer opened) is never described as if it were one of them. Each starts 「自分が」 (the admin console says 「責任者が」).
 */
export function jobSetTriggerText(trigger: JobSetTrigger): string {
  switch (jobSetWatchLine(trigger)) {
    case 'review_done':
      return '自分が担当の「議事録を確認する」を初めて完了したとき（これから来る、条件に合うもの全部。社外の人が出た会議だけ、1つの会議につき1回）'
    case 'first_read':
      return '自分が出た会議の議事録を、出た人のだれかの AI が初めて読み終えたとき（これから来る、条件に合うもの全部。社外の人が出た会議だけ、1つの会議につき1回）'
    default:
      return 'この画面では説明できない条件です（画面を新しくしてください）'
  }
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
    const day = JOB_WEEKDAY_WORDS[trigger.weekday]
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
/** An outcome code's words, or null for a code these words do not know. */
export function jobOutcomeWords(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(OUTCOME_WORDS, code) ? OUTCOME_WORDS[code] : null
}

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

/*
 * The set watch's consent and judgement words (schema 5, owner memo 「4b-4」 §2 / §3 / §5 / §6), said where the responsible
 * person accepts it (the app's 受け取る, 4b-4 PR6) and where the admin approves it (PR7 kept the same sentences in
 * `admin/src/lib/jobs.ts` until the app needed them; one copy from here on). Only for an opened combination
 * (`jobSetWatchOpened`): one that is not is described by `jobSetTriggerText` as such, never as this one.
 */

const SET_WATCH_GUARD_WORDS: Record<string, string> = {
  people_only_meeting: '出た人だけが見られる会議だけ（2026年11月4日より前の、フォルダつきの会議は対象外）',
  attendee_responsible: '責任者がその会議に出ていて（または担当で）、今もその会議を読めるときだけ',
  outside_attendee: '社外の人が1人以上出た会議だけ（社内だけの会議では AI を動かしません）',
  after_acceptance: '責任者が受け取ったあとに、AI が初めて読み終えた会議と、そのあと作られた「議事録を確認する」だけ（受け取る前に読み終えた会議では動きません）',
  plugin_step_exclusive: '同じ Skill を業務プラグインの手順で自動で動かしていないこと（同じ会議で、手順の頼みが開いているか動いているときは見送ります）',
}

/** The second line's own words where they differ (4b-4 A3: the record is the meeting itself). */
const FIRST_READ_GUARD_WORDS: Record<string, string> = {
  after_acceptance: '責任者が受け取ったあとに、AI が初めて読み終えた会議だけ（受け取る前に届いた会議でも、読み終えたのが受け取ったあとなら動きます）',
}

/** The lines of 「どれで動くか」 for an opened set watch: the counted causes, the assignee, the event, the unit and each guard. */
export function setWatchConditionLines(trigger: JobSetTrigger): string[] {
  const line = jobSetWatchLine(trigger)
  if (line === null) return []
  if (line === 'first_read') {
    return [
      '会議に出た人（担当を含む）のだれかの AI が議事録を読み終えたとき（その人の「AI の番」での読み取りか、その人の相談の中の AI）。責任者の PC がもう一度読むことはありません。人が変えたとき、会議に出ていない人の AI、定期の仕事、取り込みでは動きません',
      '責任者がその会議に出た人（または担当）で、今もその会議を読めるときだけ',
      'その会議の一生で初めての読み終わりだけ（読み直しても動きません）',
      '1つの会議につき1回だけ（仕事を直しても作り直しても、「議事録を確認する」を完了しても、同じ会議で二度は動きません）',
      ...trigger.guards.map(g => FIRST_READ_GUARD_WORDS[g] ?? SET_WATCH_GUARD_WORDS[g] ?? 'この画面では説明できない条件があります（画面を新しくしてください）'),
    ]
  }
  return [
    '人（と、その人の相談の中の AI）が完了したときだけ。定期の仕事・「AI の番」・業務の画面・取り込みでの完了では動きません',
    '作られたときから責任者が担当の「議事録を確認する」だけ（途中で担当になったものでは動きません）',
    'その「議事録を確認する」の一生で初めての完了だけ（開き直してまた完了しても動きません）',
    '1つの会議につき1回だけ（仕事を直しても作り直しても、同じ会議で二度は動きません）',
    ...trigger.guards.map(g => SET_WATCH_GUARD_WORDS[g] ?? 'この画面では説明できない条件があります（画面を新しくしてください）'),
  ]
}

/** 「いつ」 of an opened line in one sentence: the first of `setWatchSummaryLines`, and the help of the admin's 「いつ作るか」. */
export function setWatchWhenText(line: JobSetWatchLine, who: 'あなた' | '責任者'): string {
  return line === 'first_read'
    ? `社外の人が出た、${who}も出た会議の議事録を、出た人のだれかの AI が読み終えたあと（すぐ）`
    : `社外の人が出た会議の、${who}が担当の「議事録を確認する」が完了したあと`
}

/**
 * The admin's 「いつ作るか」 (4b-4 A3b, owner decision D2 2026-11-25): each opened line as a short choice, the recommended one
 * first — 「AI が読み終えたとき」, recommended for sales staff (it makes drafts before a person has checked the minutes; nothing is
 * written anywhere until the person presses ［反映する］). What the person consents to stays `jobSetTriggerText` and the
 * condition lines.
 */
export const SET_WATCH_LINE_CHOICES: ReadonlyArray<{ line: JobSetWatchLine; label: string; note: string | null }> = [
  {
    line: 'first_read',
    label: 'AI が議事録を読み終えたとき（すぐ）',
    note: 'おすすめ（法人営業の担当には、こちら）。人が議事録を確かめる前に作りますが、作るのは下書きと更新案だけです',
  },
  { line: 'review_done', label: '責任者が「議事録を確認する」を済ませたとき', note: null },
]

/**
 * The three lines read first, before ［くわしく］ opens every line above (owner FB 2026-11-24, 使い心地のメモ #37: some fifteen
 * lines of 「動く条件」 were too long to read): when it runs, what it makes, and that nothing leaves ACB until the person
 * presses — true of every opened set watch, whose grant has no mail, no place outside and no operation (`jobs.ts`
 * `SET_WATCH_NONE`). A summary only: the full words stay what the person consents to. [] for a combination not opened.
 * `reader`: the responsible person reads 「あなた」 (the app's 受け取る); anyone else — an owner / admin approving another
 * member's — reads 「責任者」, so it never says the admin's own PC or meetings.
 */
export function setWatchSummaryLines(d: JobDefinition, reader: 'responsible' | 'other'): string[] {
  const line = isSetTrigger(d.trigger) ? jobSetWatchLine(d.trigger) : null
  if (line === null) return []
  const who = reader === 'responsible' ? 'あなた' : '責任者'
  const p = d.run.kind === 'procedure' ? d.run.procedure : null
  const skill = p && p.source === 'department_skill' ? `「${p.place}」の Skill「${p.skill}」で、` : ''
  return [
    `いつ：${setWatchWhenText(line, who)}`,
    `すること：${who}の PC の AI が、${skill}たたき台と、記録の更新案を作ります`,
    `外には何も送りません。更新案は、${who}が［反映する］を押すまで、どこにも書き込まれません`,
  ]
}

/** When it does not run although the person expected it (memo §2-2 「うまくいかない場面」), said on every screen of it. */
export const SET_WATCH_NOT_RUN_NOTE =
  '動くのは、［AI に読ませる］を押した人（「議事録を確認する」の担当）の仕事だけです。上司やアシスタントが押した会議、Google をつないでいない・別のアドレスで招待された会議、途中で担当を変えた会議では動きません。動かなかった会議の提案書などは、責任者が普通の AI相談で作れます。'

/** Who sees its occurrences (memo §2-5, I8): never an owner / admin who did not attend. */
export const SET_WATCH_SEEN_NOTE =
  'この仕事の回・知らせ・件数・理由は、その会議を今読めて、会議に出た人（または担当）にだけ見えます。会議に出ていない管理者には、回の記録にも出てきません。'

/** The day's limit of a set watch (memo §2-4 / O6, Q2). */
export function setWatchDayLimitText(runsPerDay: number): string {
  return `1日 ${runsPerDay}回まで。超えた会議では動かさず（その会議は、あとからも動きません）、その日1回だけ責任者に知らせます（会議の名前や件数は書きません）`
}

/** A missed occurrence of a set watch: the responsible person's app was not open in time (counted from its line's event). */
export function setWatchMissedText(expiresAfterMinutes: number, trigger?: JobSetTrigger): string {
  const after = trigger && jobSetWatchLine(trigger) === 'first_read' ? '読み終えたあと' : '完了のあと'
  return `${after}${jobMinutesText(expiresAfterMinutes)}のうちに責任者のアプリで動けなかったときは見送ります`
}

/**
 * The grant's lines for a set watch: the shared `jobGrantLines` speak of a time / event job, so three of its lines are said
 * as the set watch's grant is — `records` only makes the one やること, the minutes are the triggering meeting's only, and the
 * day's limit says what happens beyond it.
 */
export function setWatchGrantLines(grant: JobGrant): string[] {
  return jobGrantLines(grant).flatMap((line) => {
    if (line.startsWith('道具：やること・記録を読む')) return ['道具：終わったときに、責任者だけに見えるやることを1つ作る（やることや記録は読みません）']
    if (line.startsWith('議事録：')) return ['議事録：動くきっかけになった会議の議事録だけ読む']
    if (line.startsWith('使える操作：')) return []
    if (line.startsWith('上限：')) return [`上限：1回 ${jobMinutesText(grant.limits.minutes)}・${setWatchDayLimitText(grant.limits.runsPerDay)}`]
    return [line]
  })
}

/** The Skills its AI reads besides the one it runs, as 「「部署」の Skill「名前」」; null when none. */
export function setWatchReadSkillsText(d: JobDefinition): string | null {
  const pins = d.grant.reads.skills ?? []
  return pins.length === 0 ? null : pins.map(p => `「${p.place}」の Skill「${p.skill}」`).join('・')
}

/** The reasons the Skill judges by (its `decision.json`, pinned by the server), by their labels. */
export function setWatchReasonLabels(d: JobDefinition): string[] {
  return (d.decision?.reasons ?? []).map(r => r.label)
}

/**
 * The permanent hint in 設定 → 「定期の仕事」 (owner memo 「4b-4 挟む部分」 S11 #4, OD2 withdrawn): a meeting finds its attendee by the
 * Google address the invitation went to, so another address means the job never runs — and, on purpose, no per-meeting notice
 * says so (it could tell of a meeting the person is not on). Always the same words, never about one meeting.
 */
export const JOB_GOOGLE_ADDRESS_NOTE =
  '会議をきっかけに動く定期の仕事は、カレンダーの招待が届く Google のアドレスと、ACB でつないでいる Google のアドレスが同じときだけ動きます。違うと会議の参加者として見つからず、何も作られません（設定 →「Google」で、つないでいるアドレスを確かめられます）。'

/** Below this confidence a judgement is marked as one the AI was unsure of (memo S2 J4). */
export const SET_WATCH_UNSURE_BELOW = 0.5

/**
 * A set watch's judgement as its responsible person reads it (memo §5-1 / S2), from the fixed kinds the server answers on
 * their own view (`report`): never a reason's free words, a quote or a customer's name — those are not on the server.
 */
export function setWatchJudgementText(report: { decision: string; confidence: number | null; updates?: number }): string {
  const unsure = report.confidence !== null && report.confidence < SET_WATCH_UNSURE_BELOW ? '（AI は迷いました：確からしさ 低）' : ''
  const updates = report.updates && report.updates > 0 ? `。更新案が ${report.updates} 件あります` : ''
  switch (report.decision) {
    case 'proceed': return `AI がたたき台を作りました${unsure}${updates}`
    case 'ask': return `AI は作るか迷ったため、たたき台を作ってから聞いています。作ってよいか確かめてください${unsure}${updates}`
    case 'decline': return `AI はたたき台を作りませんでした${unsure}${updates}`
    case 'gate_failed': return 'AI が判断できなかったため、たたき台は作っていません'
    default: return 'このアプリでは表示できない判断です'
  }
}

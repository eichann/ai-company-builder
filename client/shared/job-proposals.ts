import { JOB_PROPOSAL_SCHEMA, JOB_SET_WATCH_SCHEMA, isSetTrigger, jobSetWatchOpened, parseJobDefinition, type JobDefinition, type JobSetTrigger } from '../../shared/core/jobs'
import { isValidFolderName, isValidSkillName } from '../../shared/core/names'
import {
  JOB_PROPOSALS_PER_DAY, JOB_PROPOSALS_WAITING_MAX, JOB_PROPOSAL_STATES, isJobCandidateId, isJobProposalId, isJobProposalReturnReason,
  jobProposalReturnReasonText, type JobProposalReturnReason, type JobProposalState,
} from '../../shared/core/job-proposals'
import { jobCheckText, jobGrantLines, jobMinutesText, jobMissedText, jobRunText, jobTriggerText } from '../../shared/core/job-words'
import type { JobProposalView } from '../../shared/types/job-proposals'
import { WORK_SWITCH_NAMES } from './work-switches'

/**
 * A member proposes a time job from the AI chat (「AIへの相談」から定期の仕事, PR C: the app; `.claude/rules/jobs.md` "Member
 * proposals" "The app (PR C)"). The AI's tool makes a **candidate** on the server (`job_proposal_create`); the reply then holds
 * only a reference to it (data part `data-job-proposal`, stored with the message as `jobProposals`), and the card reads the
 * candidate by id with the member's **session** (IPC `jobProposals:candidate`) each time it is shown — never from the AI's
 * text. 「これで管理者に出す」 sends the candidate's id and the fingerprint the card shows (`jobProposals:submit`), a press of
 * the member's own: no chat-server route, AI tool or record token reaches it. 「やめる」 discards it on the server (`jobProposals:discard`,
 * session only, owner decision 2026-11-22). The card names the zone its times are in (the server's `timeZone`).
 */
export const JOB_PROPOSAL_PART_TYPE = 'data-job-proposal'

export interface JobProposalCardRef {
  /** The card's own id (one per tool call). */
  id: string
  companyId: string
  conversationId: string | null
  /** The server's candidate (`jc.` + 32 hex): what the card reads. */
  candidateId: string
  at: string
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A stored / streamed reference, validated (undefined when malformed). */
export function readJobProposalCardRef(data: unknown): JobProposalCardRef | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (!str(d.id, 200) || !str(d.companyId, 200) || !isJobCandidateId(d.candidateId) || !str(d.at, 40)) return undefined
  return {
    id: d.id, companyId: d.companyId, conversationId: typeof d.conversationId === 'string' && d.conversationId.length <= 200 ? d.conversationId : null,
    candidateId: d.candidateId, at: d.at,
  }
}

const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/
export const isJobFingerprint = (v: unknown): v is string => typeof v === 'string' && FINGERPRINT_RE.test(v)

/** The candidate as the card shows it: the server's definition, read by the one strict parser (schema 4 only). */
export interface ShownJobCandidate {
  id: string
  definition: JobDefinition
  fingerprint: string
  expiresAt: string
  /** The zone its times are in, as the server named it (null: a server before it, or a value that is not a zone id). */
  timeZone: string | null
}

const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/

/** A member's proposal of either shape: a time job from the chat (schema 4) or a set watch from the app (schema 5, 4b-4 PR6b). */
function proposalShape(d: JobDefinition): boolean {
  if (d.run.kind !== 'procedure') return false
  if (d.schema === JOB_PROPOSAL_SCHEMA) return true
  return d.schema === JOB_SET_WATCH_SCHEMA && d.run.procedure.source === 'department_skill' && isSetTrigger(d.trigger) && jobSetWatchOpened(d.trigger)
}

/**
 * `GET /me/job-candidates/:id`'s answer, checked: a definition the one parser reads as a member's proposal (schema 4 — or a
 * set watch of an opened combination, schema 5 — run as a procedure) with a fingerprint of the server's shape — anything else
 * is not shown (and so cannot be submitted).
 */
export function readShownCandidate(v: unknown, candidateId: string): ShownJobCandidate | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (c.id !== candidateId || !isJobFingerprint(c.fingerprint) || !str(c.expiresAt, 40)) return null
  const parsed = parseJobDefinition(c.definition)
  if (!parsed.ok || !proposalShape(parsed.definition)) return null
  const timeZone = typeof c.timeZone === 'string' && ZONE_RE.test(c.timeZone) ? c.timeZone : null
  return { id: candidateId, definition: parsed.definition, fingerprint: c.fingerprint, expiresAt: c.expiresAt, timeZone }
}

/** A proposal as the server answered it, checked (ids strictly; an unknown state or reason kept as unknown, never guessed). */
export function readProposalView(v: unknown): JobProposalView | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  if (!isJobProposalId(p.id) || !isJobCandidateId(p.candidateId) || !str(p.jobId, 60) || !str(p.proposerId, 200)) return null
  if (typeof p.submittedVersion !== 'number' || !Number.isInteger(p.submittedVersion) || p.submittedVersion < 1) return null
  return {
    id: p.id, jobId: p.jobId, proposerId: p.proposerId, candidateId: p.candidateId, submittedVersion: p.submittedVersion,
    // Only what the server shows (it withholds it where a place is no longer the member's to read).
    submittedFingerprint: isJobFingerprint(p.submittedFingerprint) ? p.submittedFingerprint : null,
    state: (JOB_PROPOSAL_STATES as readonly unknown[]).includes(p.state) ? p.state as JobProposalState : 'unknown' as JobProposalState,
    returnReason: isJobProposalReturnReason(p.returnReason) ? p.returnReason : p.returnReason === null || p.returnReason === undefined ? null : 'OTHER' as JobProposalReturnReason,
    decidedBy: typeof p.decidedBy === 'string' ? p.decidedBy : null,
    decidedAt: typeof p.decidedAt === 'string' ? p.decidedAt : null,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
  }
}

export type JobProposalsFailure = { success: false; offline: boolean; code: string | null; error: string }

/**
 * `jobProposals:candidate`: the candidate (null: gone — 24 hours passed, or it names a place the member no longer reads,
 * which the server answers as the same 404) and its proposal once submitted (also found by the candidate's id in the
 * member's proposals after the candidate's content is gone, so a reopened conversation still shows the state).
 */
export type JobCandidateResult = { success: true; candidate: ShownJobCandidate | null; proposal: JobProposalView | null; discarded?: boolean } | JobProposalsFailure
/** `jobProposals:discard` (「やめる」). `supported: false`: a server before it (nothing was discarded there). */
export type JobCandidateDiscardResult = { success: true; supported: boolean } | JobProposalsFailure

/** Zones by the words a member reads (owner decision 2026-11-22: 「日本時間 9:00」); any other is named by its id. */
const ZONE_WORDS: Record<string, string> = {
  'Asia/Tokyo': '日本時間', 'Asia/Seoul': '韓国時間', 'Asia/Shanghai': '中国時間', 'Asia/Taipei': '台湾時間', 'Asia/Hong_Kong': '香港時間',
  'Asia/Singapore': 'シンガポール時間', 'Asia/Bangkok': 'タイ時間', 'Asia/Ho_Chi_Minh': 'ベトナム時間', 'Asia/Kolkata': 'インド時間',
  'Australia/Sydney': 'シドニー時間', 'Europe/London': 'ロンドン時間', 'Europe/Paris': 'パリ時間', 'Europe/Berlin': 'ドイツ時間',
  'America/New_York': 'ニューヨーク時間', 'America/Chicago': 'シカゴ時間', 'America/Denver': 'デンバー時間', 'America/Los_Angeles': 'ロサンゼルス時間',
  'Pacific/Honolulu': 'ハワイ時間', UTC: '協定世界時（UTC）', 'Etc/UTC': '協定世界時（UTC）',
}

/** 「日本時間」, or 「時間帯 <id>」 for a zone without words; null: the server did not say (an older server). */
export function jobTimeZoneText(zone: string | null | undefined): string | null {
  if (!zone) return null
  return ZONE_WORDS[zone] ?? `時間帯 ${zone}`
}
/** `jobProposals:submit` / `jobProposals:withdraw`. */
export type JobProposalResult = { success: true; proposal: JobProposalView } | JobProposalsFailure
/** `jobProposals:mine`. `supported: false`: a server before member proposals (none can exist there). */
export type MyJobProposalsResult = { success: true; supported: boolean; proposals: JobProposalView[] } | JobProposalsFailure

/**
 * What the card shows before 「これで管理者に出す」 (owner memo §8-6): when it checks (company time), what makes it run, what
 * it does and on whose rights, what it may do (places, tools, the day's limit), a missed run and its deadline — and what
 * may keep it from running. Never 「必ず毎週動きます」: it runs only when its check finds something new.
 */
export function jobCandidateLines(d: JobDefinition, timeZone: string | null = null): string[] {
  const check = jobCheckText(d.check)
  const zone = jobTimeZoneText(timeZone)
  return [
    zone ? `いつ確かめるか：${jobTriggerText(d.trigger)}（${zone}）` : `いつ確かめるか（会社の時刻で）：${jobTriggerText(d.trigger)}`,
    ...(check ? [`何があったら動くか：${check}`] : []),
    `すること：${jobRunText(d.run)}（責任者はあなたです）`,
    ...jobGrantLines(d.grant, d.trigger),
    `動けなかった回：${jobMissedText(d.missed, d.trigger)}`,
    `期限：その回の時刻から${jobMinutesText(d.missed.expiresAfterMinutes)}`,
  ]
}

/** The card's fixed notes: nothing runs before two presses, what may stop it, and what an admin may still change. */
export const JOB_CANDIDATE_NOTES: readonly string[] = [
  '出しても、管理者が承認し、あなたが「定期の仕事」で「受け取る」を押すまでは何も動きません。',
  '確かめて新しいものが無い回は、AI は動きません（毎回かならず動くわけではありません）。',
  `会社の設定で AI が止められているとき、あなたの「${WORK_SWITCH_NAMES.autoRun}」がオフのとき、このアプリが開いていないときなどは、動かないことがあります。`,
  '名前・時刻・確かめ方は、管理者が直すことがあります。読む場所やできることが変わるときは、もう一度「受け取る」が要ります。',
]

/** A proposal's state in the proposer's words (the card and 「定期の仕事」). */
export function jobProposalStateLine(p: Pick<JobProposalView, 'state' | 'returnReason'>): string {
  switch (p.state) {
    case 'submitted': return '管理者の確認待ちです。まだ何も動いていません。'
    case 'approved': return '承認されました。設定の「定期の仕事」で内容を確かめて「受け取る」を押すと、動き始めます。'
    case 'returned': return `差し戻されました（理由：${jobProposalReturnReasonText(p.returnReason ?? 'OTHER')}）。`
    case 'withdrawn': return '取り下げました。'
    default: return 'この案の状態は、このアプリでは表示できません。アプリを新しくしてください。'
  }
}

/** The short badge of a proposal's state. */
export function jobProposalStateWord(state: string): string {
  switch (state) {
    case 'submitted': return '確認待ち'
    case 'approved': return '承認'
    case 'returned': return '差し戻し'
    case 'withdrawn': return '取り下げ'
    default: return '不明'
  }
}

/** What the card offers, from what the server answered — never from the AI's text. */
export type JobProposalCardState =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'gone' }
  | { kind: 'discarded' }
  | { kind: 'candidate'; candidate: ShownJobCandidate; submit: { candidateId: string; fingerprint: string } }
  | { kind: 'proposal'; candidate: ShownJobCandidate | null; proposal: JobProposalView; withdraw: boolean }

export function jobProposalCardState(r: JobCandidateResult | null): JobProposalCardState {
  if (!r) return { kind: 'loading' }
  if (!r.success) return { kind: 'error', text: r.error }
  // Submitted already: its state; 「取り下げる」 only while it waits.
  if (r.proposal) return { kind: 'proposal', candidate: r.candidate, proposal: r.proposal, withdraw: r.proposal.state === 'submitted' }
  if (r.discarded) return { kind: 'discarded' }
  if (!r.candidate) return { kind: 'gone' }
  // The press sends exactly the candidate and fingerprint shown.
  return { kind: 'candidate', candidate: r.candidate, submit: { candidateId: r.candidate.id, fingerprint: r.candidate.fingerprint } }
}

/** The card when the candidate is gone (or withheld: the same 404 — never which). */
export const JOB_CANDIDATE_GONE_TEXT = 'この案はもう見られません（作ってから24時間たったか、あなたが今は読めない場所が含まれています）。出したいときは、もう一度 AI に頼んでください。'

/** The card of a candidate its member discarded (「やめる」, kept on the server until its 24 hours; after them it is gone). */
export const JOB_CANDIDATE_DISCARDED_TEXT = 'この案はやめました。出したいときは、もう一度 AI に頼んでください。'

export const JOB_PROPOSALS_OFFLINE_TEXT = 'サーバーに接続できないため、いまは定期の仕事の案を読み込めません（オフラインの可能性があります）。'

/**
 * The refusals of member proposals (#751's codes) in fixed plain Japanese: never a place, a name or a fingerprint, and
 * never the server's text for a code this app does not know (a generic sentence instead).
 */
const REFUSAL_TEXT: Record<string, string> = {
  JOB_CANDIDATE_NOT_FOUND: JOB_CANDIDATE_GONE_TEXT,
  JOB_CANDIDATE_DISCARDED: JOB_CANDIDATE_DISCARDED_TEXT,
  JOB_CANDIDATE_SUBMITTED: 'この案はもう管理者に出しました。やめるときは「取り下げる」を押してください。',
  JOB_CANDIDATE_PLACE: 'この案には、あなたが今は使えない場所が含まれています。出したいときは、もう一度 AI に頼んでください。',
  JOB_VERSION_FINGERPRINT: '画面に出ていた内容と、いまの案が違います。カードを読み直しました。内容を確かめてから押してください。',
  JOB_SKILL_CHANGED: 'Skill が変わったため、この案は出せません。もう一度 AI に案を作ってもらってください。',
  JOB_SKILL_MISSING: 'その Skill はもうありません。先に Skill を作ってから、もう一度 AI に頼んでください。',
  JOB_GRANT_EXCEEDS: 'あなたの今の権限では、この案の範囲に足りません。もう一度 AI に頼んでください。',
  JOB_PROPOSALS_WAITING_LIMIT: `管理者の確認を待っている案が${JOB_PROPOSALS_WAITING_MAX}つあります。どれかが決まるか、取り下げてから出してください。`,
  JOB_PROPOSALS_DAY_LIMIT: `今日はもう${JOB_PROPOSALS_PER_DAY}回出しました。あした、もう一度出してください。`,
  JOB_PROPOSAL_NOT_FOUND: '定期の仕事の案が見つかりません。',
  JOB_PROPOSAL_DECIDED: 'この案はもう決まっています（承認・差し戻しなど）。いまの状態を出しました。',
  JOB_NEEDS_NEWER_SCREEN: 'このアプリでは扱えない案です。アプリを新しくしてください。',
  JOB_NEEDS_NEWER_APP: 'このアプリでは扱えない案です。アプリを新しくしてください。',
  // A set watch from the app (4b-4 PR6b): what 「見張りを足す」 may be told.
  JOB_SET_WATCH_ONE_PER_PERSON: 'あなたには、会議のあとの見張りがもうあります。1人に1つだけです。',
  JOB_SKILL_DECISION_MISSING: 'この Skill には、AI が判断の理由を選ぶ一覧（decision.json）が無いか、書き方が正しくありません。Skill を直せる人に頼んでください。',
  JOB_SKILL_NOT_HERE: 'この会社は全社フォルダを使っていないため、会議のあとの見張りは作れません。',
  BAD_JOB_DEFINITION: 'この組み合わせでは見張りを作れません。アプリを新しくしてください。',
  BAD_JOB_CANDIDATE: '選んだ内容が正しくありません。選び直してください。',
  BAD_REQUEST: '入力が正しくありません。',
}
export const JOB_PROPOSAL_REFUSED_TEXT = 'うまくいきませんでした。少し待ってから、もう一度ためしてください。'

export function jobProposalRefusalText(code: string | null): string {
  return (code && REFUSAL_TEXT[code]) || JOB_PROPOSAL_REFUSED_TEXT
}

/** A refusal that means the proposal or candidate moved on meanwhile: the card reads it again. */
export const JOB_PROPOSAL_READ_AGAIN_CODES: readonly string[] = ['JOB_VERSION_FINGERPRINT', 'JOB_PROPOSAL_DECIDED', 'JOB_CANDIDATE_NOT_FOUND', 'JOB_CANDIDATE_PLACE', 'JOB_CANDIDATE_DISCARDED', 'JOB_CANDIDATE_SUBMITTED']


/*
 * 「見張りを足す」 (4b-4 PR6b, jobs.md "Member proposals" "A set watch from the app"): in Settings → 「定期の仕事」 the member
 * chooses one of the opened combinations, the department Skill it runs (one with its `decision.json`) and the Skills it
 * reads; main asks the server with the session for the candidate (`POST /me/job-candidates`) — the server builds everything
 * else. Then the same 「これで管理者に出す」 / 「やめる」 as a chat card (`jobProposals:submit` / `jobProposals:discard`).
 */

/** A department Skill the member reads, as the server lists it; `runs`: it has a `decision.json` (it can be what runs). */
export interface SetWatchSkill { place: string; skill: string; runs: boolean }
export type SetWatchSkillsResult = { success: true; supported: boolean; skills: SetWatchSkill[] } | JobProposalsFailure
/** What the member chose (the server takes exactly these three keys). */
export interface SetWatchChoice { trigger: JobSetTrigger; skill: { place: string; skill: string }; readSkills: Array<{ place: string; skill: string }> }
export type SetWatchCandidateResult = { success: true; candidate: ShownJobCandidate } | JobProposalsFailure

/** At most this many Skills are shown (the server lists at most 100 a department). */
export const SET_WATCH_SKILLS_SHOWN = 200
/** The Skills a set watch may read (the core's `JOB_READ_SKILLS_MAX`). */
export const SET_WATCH_READ_SKILLS_MAX = 4

/** The server's list, checked: department folder and Skill names of the right shape only, each once; anything else left out. */
export function readSetWatchSkills(v: unknown): SetWatchSkill[] {
  const list = v && typeof v === 'object' ? (v as { skills?: unknown }).skills : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: SetWatchSkill[] = []
  for (const s of list.slice(0, SET_WATCH_SKILLS_SHOWN)) {
    if (!s || typeof s !== 'object') continue
    const { place, skill, runs } = s as Record<string, unknown>
    if (typeof place !== 'string' || place.length > 100 || !isValidFolderName(place) || typeof skill !== 'string' || skill.length > 64 || !isValidSkillName(skill)) continue
    const key = `${place}/${skill}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ place, skill, runs: runs === true })
  }
  return out
}

/**
 * The choice as sent (main checks it again before any server call): an opened combination, a run Skill and up to four other
 * Skills read, each a department folder and a Skill name of the right shape, each once — else null (nothing is sent).
 */
export function readSetWatchChoice(v: unknown): SetWatchChoice | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (Object.keys(c).length !== 3 || !isSetTrigger(c.trigger) || !jobSetWatchOpened(c.trigger)) return null
  const ref = (r: unknown): { place: string; skill: string } | null => {
    if (!r || typeof r !== 'object') return null
    const { place, skill } = r as Record<string, unknown>
    return typeof place === 'string' && isValidFolderName(place) && place.length <= 100 && typeof skill === 'string' && isValidSkillName(skill) && skill.length <= 64 ? { place, skill } : null
  }
  const run = ref(c.skill)
  const reads = Array.isArray(c.readSkills) ? c.readSkills.map(ref) : null
  if (!run || !reads || reads.length > SET_WATCH_READ_SKILLS_MAX || reads.some(r => r === null)) return null
  const all = reads as Array<{ place: string; skill: string }>
  if (new Set(all.map(r => `${r.place}/${r.skill}`)).size !== all.length) return null
  return { trigger: c.trigger, skill: run, readSkills: all }
}

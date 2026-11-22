/**
 * A member proposes a time job from the AI chat (「AIへの相談」から定期の仕事, owner memo 2026-11-22 第1〜5版, `.claude/rules/jobs.md`
 * "Member proposals"). The rules every side shares: the ids, the limits, the states, the fixed reasons an owner / admin returns
 * one with, the strict shape of what the member's AI asks for (`parseJobCandidateInput`) and how the server builds the
 * definition from it (`proposalDefinition`, schema 4).
 *
 * **No free text anywhere** (owner memo §8-1 / §10-1): the AI names a Skill, a time from the lists, a check from the list
 * (`new_meetings` only without title words), places that the server checks exist and are the member's to read / write, and
 * yes / no choices. The job's name (「<Skill>（<いつ>）」) and the deliverable folder (`job-<hex>`) are the server's. The
 * responsible person is the signed-in member, never a value sent.
 *
 * Pure (server/tests/unit/core-purity.test.ts).
 */
import {
  JOB_MINUTES_ROUTE, JOB_NAME_MAX, JOB_OUTBOUND_ROUTES, JOB_PROPOSAL_ORIGIN, JOB_PROPOSAL_SCHEMA, jobPathProblem,
  type JobMissed, type JobProcedure, type JobTimeTrigger,
} from './jobs'
import { jobTriggerText } from './job-words'

/** A candidate (案の候補, before 「管理者に出す」): `jc.` + 32 hex. A proposal (a candidate submitted): `jp.` + 32 hex. */
export const JOB_CANDIDATE_ID_RE = /^jc\.[0-9a-f]{32}$/
export const JOB_PROPOSAL_ID_RE = /^jp\.[0-9a-f]{32}$/
export const isJobCandidateId = (v: unknown): v is string => typeof v === 'string' && JOB_CANDIDATE_ID_RE.test(v)
export const isJobProposalId = (v: unknown): v is string => typeof v === 'string' && JOB_PROPOSAL_ID_RE.test(v)

const HEX32_RE = /^[0-9a-f]{32}$/
export function newJobCandidateId(hex: string): string {
  if (!HEX32_RE.test(hex)) throw new Error('newJobCandidateId: needs 32 lowercase hex characters')
  return `jc.${hex}`
}
export function newJobProposalId(hex: string): string {
  if (!HEX32_RE.test(hex)) throw new Error('newJobProposalId: needs 32 lowercase hex characters')
  return `jp.${hex}`
}

/** How long a candidate's content is kept (owner memo §8-3): after it, it is gone; a submitted one's record stays. */
export const JOB_CANDIDATE_TTL_MS = 24 * 60 * 60_000
/** Live candidates per member (owner memo §8-3). */
export const JOB_CANDIDATES_PER_MEMBER = 20
/** Submitted proposals waiting for an owner / admin, per member (owner decision Q4). */
export const JOB_PROPOSALS_WAITING_MAX = 5
/** Submits per member and company day, whatever became of them (owner memo §6 #8: withdrawals count too). */
export const JOB_PROPOSALS_PER_DAY = 10

/**
 * A proposal's state (owner memo §8-4): `submitted` (waiting for an owner / admin; counts toward the five), and the ends —
 * `approved` (its first approval), `withdrawn` (by the proposer), `returned` (by an owner / admin, with a reason). Only from
 * `submitted`, and one of the three wins.
 */
export const JOB_PROPOSAL_STATES = ['submitted', 'approved', 'withdrawn', 'returned'] as const
export type JobProposalState = typeof JOB_PROPOSAL_STATES[number]

/** Why an owner / admin returned a proposal: fixed codes only, never text (a typed reason could carry a name). */
export const JOB_PROPOSAL_RETURN_REASONS = ['NOT_NEEDED', 'TOO_BROAD', 'SKILL_NOT_READY', 'TALK_FIRST', 'OTHER'] as const
export type JobProposalReturnReason = typeof JOB_PROPOSAL_RETURN_REASONS[number]
const RETURN_REASON_WORDS: Record<JobProposalReturnReason, string> = {
  NOT_NEEDED: '今は定期の仕事にしなくてよい',
  TOO_BROAD: '読む場所や置く場所、できることが広すぎる',
  SKILL_NOT_READY: '先に Skill を直したい',
  TALK_FIRST: '先に話をしたい',
  OTHER: 'そのほかの理由',
}
export function jobProposalReturnReasonText(reason: string): string {
  return (RETURN_REASON_WORDS as Record<string, string>)[reason] ?? RETURN_REASON_WORDS.OTHER
}
export function isJobProposalReturnReason(v: unknown): v is JobProposalReturnReason {
  return typeof v === 'string' && (JOB_PROPOSAL_RETURN_REASONS as readonly string[]).includes(v)
}

const STATE_WORDS: Record<JobProposalState, string> = {
  submitted: '管理者の確認待ち', approved: '承認されました', withdrawn: '取り下げました', returned: '差し戻されました',
}
export function jobProposalStateText(state: string): string {
  return (STATE_WORDS as Record<string, string>)[state] ?? '表示できない状態です'
}

/** The record read routes 「やることや記録を読む」 grants (the admin form's same four). */
export const JOB_PROPOSAL_RECORD_ROUTES: readonly string[] = ['GET /my-turn', 'POST /query', 'GET /item/:recordId', 'GET /item/:recordId/history']

/**
 * What the member's AI asks for (`POST /api/records-ai/job-candidates`): every value from a list or a place the server
 * checks. `skill`: a company Skill's folder name (a company with the shared folder) or a shelf item's id (one without).
 */
export interface JobCandidateInput {
  skill: string
  trigger: JobTimeTrigger
  check: { kind: 'new_files'; path: string } | { kind: 'new_meetings' }
  reads: string[]
  /** The place a deliverable folder (the server names it) goes in, or null: nothing is written. */
  deliverable: string | null
  readRecords: boolean
  mailDrafts: boolean
  minutes: number
  missed: JobMissed
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const SKILL_REF_RE = /^[A-Za-z0-9_-]{1,100}$/
const MAX_READS = 10

/** The candidate's input, strictly (an unknown key or value is a problem; codes only, never the values sent). */
export function parseJobCandidateInput(v: unknown): { ok: true; input: JobCandidateInput } | { ok: false; problems: string[] } {
  if (!isObj(v)) return { ok: false, problems: ['BAD'] }
  const problems: string[] = []
  const keys = ['skill', 'trigger', 'check', 'reads', 'deliverable', 'readRecords', 'mailDrafts', 'minutes', 'missed']
  if (Object.keys(v).some(k => !keys.includes(k))) problems.push('UNKNOWN_KEY')
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) problems.push(`${k}.MISSING`)
  if (problems.length > 0) return { ok: false, problems }
  if (typeof v.skill !== 'string' || !SKILL_REF_RE.test(v.skill)) problems.push('skill.BAD')
  // The trigger and the missed policy are checked by the definition's own parser (time shapes only, schema 4).
  if (!isObj(v.trigger) || 'kind' in v.trigger) problems.push('trigger.BAD')
  let check: JobCandidateInput['check'] | null = null
  if (isObj(v.check) && v.check.kind === 'new_files' && Object.keys(v.check).length === 2 && jobPathProblem(v.check.path) === null) {
    check = { kind: 'new_files', path: v.check.path as string }
  } else if (isObj(v.check) && v.check.kind === 'new_meetings' && Object.keys(v.check).length === 1) {
    // Never title words (owner memo §8-1: a meeting's title could carry what the admin must not read); an admin may add them later.
    check = { kind: 'new_meetings' }
  } else problems.push('check.BAD')
  const reads = Array.isArray(v.reads) && v.reads.length <= MAX_READS && v.reads.every(p => jobPathProblem(p) === null) && new Set(v.reads).size === v.reads.length
    ? v.reads as string[] : null
  if (!reads) problems.push('reads.BAD')
  if (!(v.deliverable === null || jobPathProblem(v.deliverable) === null)) problems.push('deliverable.BAD')
  if (typeof v.readRecords !== 'boolean') problems.push('readRecords.BAD')
  if (typeof v.mailDrafts !== 'boolean') problems.push('mailDrafts.BAD')
  if (typeof v.minutes !== 'number' || !Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > 120) problems.push('minutes.BAD')
  if (!isObj(v.missed)) problems.push('missed.BAD')
  if (problems.length > 0 || !check || !reads) return { ok: false, problems }
  return {
    ok: true,
    input: {
      skill: v.skill as string, trigger: v.trigger as unknown as JobTimeTrigger, check, reads, deliverable: v.deliverable as string | null,
      readRecords: v.readRecords as boolean, mailDrafts: v.mailDrafts as boolean, minutes: v.minutes as number, missed: v.missed as unknown as JobMissed,
    },
  }
}

/** Every place a candidate names (what the member must read; the deliverable's place they must also write). */
export function jobCandidatePlaces(input: JobCandidateInput): string[] {
  return [...new Set([...input.reads, ...(input.check.kind === 'new_files' ? [input.check.path] : []), ...(input.deliverable !== null ? [input.deliverable] : [])])]
}

/**
 * The job's name, made by the server (owner memo §8-1): 「<Skill>（<いつ>）」 — the Skill's name as the server pinned it and
 * the trigger's words, the Skill's part shortened to fit `JOB_NAME_MAX`. Nobody's typed text.
 */
export function proposalJobName(skill: string, trigger: JobTimeTrigger): string {
  const when = `（${jobTriggerText(trigger)}）`
  const room = JOB_NAME_MAX - when.length
  const name = skill.length <= room ? skill : `${skill.slice(0, Math.max(1, room - 1))}…`
  return `${name}${when}`.slice(0, JOB_NAME_MAX)
}

/** The deliverable folder's name (`grant.writes.folder`), made by the server from the candidate's id: `job-` + 8 hex. */
export function proposalDeliverableFolder(candidateId: string): string {
  return `job-${candidateId.slice(3, 11)}`
}

/**
 * The definition a candidate becomes (schema 4, not yet parsed — the server runs `parseJobDefinition` on it): the signed-in
 * member as the responsible person, the Skill the server pinned, the reads and the check's place read, the one やること it
 * creates at its end (`records`, `creates: ['task']`), the record reads / minutes / mail drafts only as chosen, at most one
 * run a day.
 */
export function proposalDefinition(input: JobCandidateInput, pinned: { actingUser: string; procedure: JobProcedure; skillName: string; candidateId: string }): Record<string, unknown> {
  const reads = [...new Set([...input.reads, ...(input.check.kind === 'new_files' ? [input.check.path] : [])])]
  const tools = ['records', ...(reads.length > 0 ? ['files_read'] : []), ...(input.deliverable !== null ? ['files_write'] : []), ...(input.mailDrafts ? ['outbound_draft'] : [])]
  const routes = [
    ...(input.readRecords ? JOB_PROPOSAL_RECORD_ROUTES : []),
    ...(input.check.kind === 'new_meetings' ? [JOB_MINUTES_ROUTE] : []),
    ...(input.mailDrafts ? JOB_OUTBOUND_ROUTES : []),
  ]
  return {
    schema: JOB_PROPOSAL_SCHEMA,
    name: proposalJobName(pinned.skillName, input.trigger),
    actingUser: pinned.actingUser,
    trigger: input.trigger,
    check: input.check.kind === 'new_files' ? input.check : { kind: 'new_meetings', titleWords: [] },
    run: { kind: 'procedure', procedure: pinned.procedure },
    placement: 'a',
    missed: input.missed,
    grant: {
      tools, creates: ['task'], routes, reads: { paths: reads, calls: [] },
      writes: input.deliverable === null ? { area: 'none' } : { area: 'deliverable', place: input.deliverable, folder: proposalDeliverableFolder(pinned.candidateId) },
      outbound: input.mailDrafts ? 'draft_only' : 'none',
      limits: { minutes: input.minutes, runsPerDay: 1 },
    },
    origin: JOB_PROPOSAL_ORIGIN,
  }
}

/**
 * 「届いた案」 (jobs.md "Member proposals", PR B: the admin console): the words an owner / admin reads about a time job a member
 * proposed from the AI chat — its state from their side, which version the member sent and which an owner / admin made after
 * it, and the fixed reasons a return may name (never typed text: a reason could carry a name the proposer must not see). The
 * server decides every move; these only say what it answered.
 */
import { ApiError } from './api'
import { JOB_PROPOSAL_RETURN_REASONS, jobProposalReturnReasonText, type JobProposalReturnReason } from '../../../shared/core/job-proposals'

/** The proposal as a job carries it (`JobView.proposal`) or as the list answers it. */
export interface ProposalLike {
  proposerId: string
  submittedVersion: number
  state: string
  returnReason: string | null
}

/** The states the list filters by, waiting first (what an owner / admin has to decide). */
export const PROPOSAL_FILTERS: Array<{ value: 'submitted' | 'approved' | 'withdrawn' | 'returned'; label: string }> = [
  { value: 'submitted', label: '確認を待っている案' },
  { value: 'approved', label: '承認した案' },
  { value: 'returned', label: '差し戻した案' },
  { value: 'withdrawn', label: '取り下げられた案' },
]

/** Where a proposal stands, as an owner / admin reads it (the proposer's own words are the app's). */
export function proposalStateText(p: Pick<ProposalLike, 'state' | 'returnReason'>): string {
  switch (p.state) {
    case 'submitted': return '確認を待っています'
    case 'approved': return '承認しました'
    case 'withdrawn': return '出した人が取り下げました'
    case 'returned': return `差し戻しました（理由：${jobProposalReturnReasonText(p.returnReason ?? 'OTHER')}）`
    default: return '表示できない状態です'
  }
}

/** Withdrawn or returned: its job is not used any more — never edited or approved (the server refuses it too). */
export function proposalClosed(p: Pick<ProposalLike, 'state'> | null | undefined): boolean {
  return !!p && (p.state === 'withdrawn' || p.state === 'returned')
}

/**
 * A refusal saying the proposal was decided by someone else meanwhile (a return or a withdrawal that came first, or an
 * approval): 409 `JOB_PROPOSAL_DECIDED` (a return) or `JOB_PROPOSAL_CLOSED` (an approval or an edit). The lists are read again.
 */
export function proposalDecidedElsewhere(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'JOB_PROPOSAL_DECIDED' || err.code === 'JOB_PROPOSAL_CLOSED')
}

/** What a closed proposal's job says instead of a form or an approval. */
export const PROPOSAL_CLOSED_TEXT = 'この案は取り下げられたか差し戻されたため、直したり承認したりできません。'

/**
 * Which hands made a version of a proposal's job: the version the member sent (`submittedVersion`), or one an owner / admin
 * made after it (only owners / admins write a new version). null: before it (a proposal's job starts at its submitted version).
 */
export function proposalVersionText(version: number, p: ProposalLike, proposerName: string): string | null {
  if (version === p.submittedVersion) return `社員が出した版（${proposerName}さんが出した内容のままです）`
  if (version > p.submittedVersion) return `管理者が直した版（${proposerName}さんが出したのは第${p.submittedVersion}版です）`
  return null
}

/** The reasons a return may name, in the order offered: the shared codes with their words. */
export const RETURN_REASON_CHOICES: Array<{ value: JobProposalReturnReason; label: string }> =
  JOB_PROPOSAL_RETURN_REASONS.map((value) => ({ value, label: jobProposalReturnReasonText(value) }))

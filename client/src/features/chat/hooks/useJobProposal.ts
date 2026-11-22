import { useCallback, useSyncExternalStore } from 'react'
import { getJobCandidate, type JobProposalCardPort } from '../api'
import { jobProposalEntry, jobProposalKey, subscribeJobProposal } from '../../../shared/lib/jobProposalStore'

/** One job proposal candidate as the server last answered it (loaded with the member's session when first shown). */
export function useJobProposal(companyId: string, candidateId: string, port?: JobProposalCardPort) {
  const key = jobProposalKey(companyId, candidateId)
  const subscribe = useCallback(
    (listener: () => void) => subscribeJobProposal(key, () => (port ? getJobCandidate(companyId, candidateId, port) : getJobCandidate(companyId, candidateId)), listener),
    [key, companyId, candidateId, port],
  )
  return { key, result: useSyncExternalStore(subscribe, () => jobProposalEntry(key), () => jobProposalEntry(key)) }
}

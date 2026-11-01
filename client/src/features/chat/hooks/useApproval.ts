import { useCallback, useSyncExternalStore } from 'react'
import { getApproval, type ApprovalOutbound } from '../api'
import { approvalEntry, approvalKey, subscribeApproval } from '../approvalStore'

/** One approval request as the server last answered it (loaded with the member's session when first shown). */
export function useApproval(companyId: string, approvalId: string, outbound?: ApprovalOutbound) {
  const key = approvalKey(companyId, approvalId)
  const subscribe = useCallback(
    (listener: () => void) => subscribeApproval(key, () => (outbound ? getApproval(companyId, approvalId, outbound) : getApproval(companyId, approvalId)), listener),
    [key, companyId, approvalId, outbound],
  )
  return { key, ...useSyncExternalStore(subscribe, () => approvalEntry(key), () => approvalEntry(key)) }
}

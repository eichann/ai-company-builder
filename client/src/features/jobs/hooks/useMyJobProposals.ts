// 「出した案」: the member's own proposals as the server answers them, and their 「取り下げる」.
import { useCallback, useRef, useState } from 'react'
import type { JobProposalView } from '../../../../../shared/types/job-proposals'
import { getMyJobProposals, withdrawMyJobProposal } from '../api'
import { jobCandidateChanged } from '../../../shared/lib/jobProposalStore'

export function useMyJobProposals(companyId: string, onChanged?: () => void) {
  const [proposals, setProposals] = useState<JobProposalView[] | null>(null)
  const [supported, setSupported] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await getMyJobProposals(companyId)
    if (r.success) { setProposals(r.proposals); setSupported(r.supported); setError(null) } else setError(r.error)
  }, [companyId])

  // The first load starts when the list's element mounts (a callback ref, not an effect: renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  const withdraw = useCallback(async (proposalId: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await withdrawMyJobProposal(companyId, proposalId)
      setMessage(r.success ? '取り下げました。この案は動きません。' : r.error)
      // A chat card showing this proposal reads it again (it said 確認待ち with 「取り下げる」 until now).
      const candidateId = proposals?.find(p => p.id === proposalId)?.candidateId
      if (candidateId) jobCandidateChanged(companyId, candidateId)
      await reload()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }, [companyId, reload, onChanged, proposals])

  return { loadRef, proposals, supported, error, message, busy, withdraw }
}

import { useCallback, useState } from 'react'
import type { TaskProposalsResult } from '../../../../shared/tasks'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getTaskProposals } from '../api'

/** A meeting's proposals (案), read when shown and again on `reload` (null while loading). */
export function useTaskProposals(companyId: string, meetingId: string): { result: TaskProposalsResult | null; reload: () => void } {
  const [result, setResult] = useState<TaskProposalsResult | null>(null)
  const [rev, setRev] = useState(0)
  // A read through useIpcEvent with nothing to listen to (the renderer's effect count is capped); a new `rev` reads again.
  const once = useCallback((listener: (payload: number) => void) => { listener(rev) }, [rev])
  useIpcEvent(once, () => {
    const failed = { success: false as const, offline: true, error: '表示できませんでした。' }
    void getTaskProposals(companyId, meetingId).then(r => setResult(r ?? failed), () => setResult(failed))
  })
  return { result, reload: () => setRev(v => v + 1) }
}

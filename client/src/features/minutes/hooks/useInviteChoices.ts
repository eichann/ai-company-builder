import { useCallback, useState } from 'react'
import type { MeetingInviteChoicesResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getInviteChoices } from '../api'

/**
 * What ［招待する］ may offer besides people (groups, departments — only when the server says the member
 * may add them) and the groups / departments on the list now; null while loading or when it failed
 * (then only people are offered, as before).
 */
export function useInviteChoices(companyId: string, meetingId: string): Extract<MeetingInviteChoicesResult, { success: true }> | null {
  const [result, setResult] = useState<Extract<MeetingInviteChoicesResult, { success: true }> | null>(null)
  // Read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (id: string) => void) => { listener(meetingId) }, [meetingId])
  useIpcEvent(once, id => {
    void getInviteChoices(companyId, id).then(r => setResult(r.success ? r : null), () => setResult(null))
  })
  return result
}

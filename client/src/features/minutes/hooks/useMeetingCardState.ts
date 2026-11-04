import { useCallback, useState } from 'react'
import type { MeetingCardStateResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getMeetingCardState, onMeetingsMayHaveChanged } from '../api'

/** One meeting for its card: read when shown, when the meetings may have changed and on `reload` (null while loading). */
export function useMeetingCardState(companyId: string, meetingId: string): { result: MeetingCardStateResult | null; reload: () => void } {
  const [result, setResult] = useState<MeetingCardStateResult | null>(null)
  const reload = useCallback(() => {
    void getMeetingCardState(companyId, meetingId).then(setResult, () => {})
  }, [companyId, meetingId])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    listener(undefined)
    return onMeetingsMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload)
  return { result, reload }
}

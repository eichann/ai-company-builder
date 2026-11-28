import { useCallback, useRef, useState } from 'react'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getMeetingCardState, onMeetingsMayHaveChanged } from '../api'
import { nextMeetingCardLoad, type MeetingCardLoad } from '../model'

/**
 * One meeting for its card: read when shown, when the meetings may have changed and on `reload`.
 * Only the latest read counts; reading again keeps what was shown (`reloading` while it runs).
 */
export function useMeetingCardState(companyId: string, meetingId: string): { load: MeetingCardLoad; reloading: boolean; reload: () => void } {
  const [load, setLoad] = useState<MeetingCardLoad>({ kind: 'loading' })
  const [reloading, setReloading] = useState(false)
  const latest = useRef(0)
  const reload = useCallback(() => {
    const call = ++latest.current
    setReloading(true)
    const settle = (answer: Parameters<typeof nextMeetingCardLoad>[1]) => {
      if (call !== latest.current) return
      setReloading(false)
      setLoad(prev => nextMeetingCardLoad(prev, answer))
    }
    getMeetingCardState(companyId, meetingId).then(settle, () => settle('threw'))
  }, [companyId, meetingId])
  const subscribe = useCallback((listener: (payload: undefined) => void) => {
    listener(undefined)
    return onMeetingsMayHaveChanged(companyId, () => listener(undefined))
  }, [companyId])
  useIpcEvent(subscribe, reload)
  return { load, reloading, reload }
}

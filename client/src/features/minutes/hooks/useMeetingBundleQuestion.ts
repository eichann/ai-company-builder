import { useCallback, useState } from 'react'
import type { MeetingBundleQuestionResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getMeetingBundleQuestion } from '../api'

/**
 * A meeting card's 「どのまとまりの会議ですか？」 (null while loading, or for what is no meeting), read
 * when the card opens and when its まとまり changes (`linkedId`): one taken off makes it askable again.
 */
export function useMeetingBundleQuestion(companyId: string, meetingId: string | null, linkedId: string | null): MeetingBundleQuestionResult | null {
  const [result, setResult] = useState<MeetingBundleQuestionResult | null>(null)
  // Read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (at: { meetingId: string | null; linkedId: string | null }) => void) => { listener({ meetingId, linkedId }) }, [meetingId, linkedId])
  useIpcEvent(once, at => {
    if (!at.meetingId) return
    void getMeetingBundleQuestion(companyId, at.meetingId).then(setResult, () => setResult({ success: false, error: '表示できませんでした。' }))
  })
  return result
}

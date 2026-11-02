import { useCallback, useState } from 'react'
import type { MeetingBundleQuestionResult } from '../../../../shared/minutes-app'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getMeetingBundleQuestion } from '../api'

/** A meeting card's 「どのまとまりの会議ですか？」, read once when the card opens (null while loading). */
export function useMeetingBundleQuestion(companyId: string, meetingId: string): MeetingBundleQuestionResult | null {
  const [result, setResult] = useState<MeetingBundleQuestionResult | null>(null)
  // Read once through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, () => {
    void getMeetingBundleQuestion(companyId, meetingId).then(setResult, () => setResult({ success: false, error: '表示できませんでした。' }))
  })
  return result
}

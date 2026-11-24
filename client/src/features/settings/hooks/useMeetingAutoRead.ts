import { useCallback, useRef, useState } from 'react'
import type { MeetingAutoReadMode } from '../../../../../shared/core/minutes'
import { MEETING_AUTO_READ_CHANGED_EVENT, type MeetingAutoReadResult } from '../../../../shared/minutes-app'
import { getMeetingAutoReadSetting, setMeetingAutoReadSetting } from '../api'

/**
 * 「届いた議事録を AI が自動で読む」 as the server holds it, read when the part mounts (`loadRef`, a
 * callback ref: the renderer's effects are capped); a change shows what the server answered.
 */
export function useMeetingAutoRead(companyId: string) {
  const [result, setResult] = useState<MeetingAutoReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void getMeetingAutoReadSetting(companyId).then(setResult, () => setResult({ success: false, error: '' }))
  }, [companyId])
  const choose = useCallback(async (mode: MeetingAutoReadMode): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const r = await setMeetingAutoReadSetting(companyId, mode)
      if (r.success) {
        setResult(r)
        window.dispatchEvent(new CustomEvent(MEETING_AUTO_READ_CHANGED_EVENT, { detail: companyId }))
        return true
      }
      setError(r.error || 'できませんでした。')
      return false
    } catch {
      setError('うまくいきませんでした。少し待ってから、もう一度選んでください')
      return false
    } finally {
      setBusy(false)
    }
  }, [companyId])
  return { loadRef, setting: result?.success ? result.setting : null, error, busy, choose }
}

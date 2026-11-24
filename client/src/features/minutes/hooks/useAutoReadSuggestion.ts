import { useCallback, useRef, useState } from 'react'
import { MEETING_AUTO_READ_CHANGED_EVENT, suggestsAutoRead, type MeetingAutoReadResult } from '../../../../shared/minutes-app'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { getMeetingAutoRead } from '../api'

const dismissedKey = (companyId: string) => `meeting-auto-read-suggested:${companyId}`
function readDismissed(companyId: string): boolean {
  try { return localStorage.getItem(dismissedKey(companyId)) === '1' } catch { return false }
}

/**
 * Whether the 「議事録が届きました」 block suggests 「社外の人がいる会議だけ」 (owner decision D1-1):
 * the member's setting, read once when the block mounts (`loadRef`, a callback ref: the renderer's
 * effects are capped) and again when Settings changed it, unless they closed the suggestion on this PC.
 */
export function useAutoReadSuggestion(companyId: string) {
  const [setting, setSetting] = useState<MeetingAutoReadResult | null>(null)
  const [dismissed, setDismissed] = useState(() => readDismissed(companyId))
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void getMeetingAutoRead(companyId).then(setSetting, () => {})
  }, [companyId])
  const reread = useCallback(() => { void getMeetingAutoRead(companyId).then(setSetting, () => {}) }, [companyId])
  useEventListener<CustomEvent<string>>(window, MEETING_AUTO_READ_CHANGED_EVENT, e => { if (e.detail === companyId) reread() })
  /** Read the setting again just before acting on the suggestion: true while the member still never chose. */
  const stillNeverChose = useCallback(async () => {
    const now = await getMeetingAutoRead(companyId).catch(() => null)
    if (now) setSetting(now)
    return !!now?.success && suggestsAutoRead(now.setting)
  }, [companyId])
  const dismiss = useCallback(() => {
    setDismissed(true)
    try { localStorage.setItem(dismissedKey(companyId), '1') } catch { /* memory only */ }
  }, [companyId])
  return {
    loadRef,
    suggest: !dismissed && setting?.success === true && suggestsAutoRead(setting.setting),
    /** What the server answered after a change (the member chose: no suggestion any more). */
    answered: setSetting,
    stillNeverChose,
    dismiss,
  }
}

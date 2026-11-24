import { useCallback, useRef, useState } from 'react'
import { suggestsAutoRead, type MeetingAutoReadResult } from '../../../../shared/minutes-app'
import { getMeetingAutoRead } from '../api'

const dismissedKey = (companyId: string) => `meeting-auto-read-suggested:${companyId}`
function readDismissed(companyId: string): boolean {
  try { return localStorage.getItem(dismissedKey(companyId)) === '1' } catch { return false }
}

/**
 * Whether the 「議事録が届きました」 block suggests 「社外の人がいる会議だけ」 (owner decision D1-1):
 * the member's setting, read once when the block mounts (`loadRef`, a callback ref: the renderer's
 * effects are capped), unless they closed the suggestion on this PC.
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
  const dismiss = useCallback(() => {
    setDismissed(true)
    try { localStorage.setItem(dismissedKey(companyId), '1') } catch { /* memory only */ }
  }, [companyId])
  return {
    loadRef,
    suggest: !dismissed && setting?.success === true && suggestsAutoRead(setting.setting),
    /** What the server answered after a change (the member chose: no suggestion any more). */
    answered: setSetting,
    dismiss,
  }
}

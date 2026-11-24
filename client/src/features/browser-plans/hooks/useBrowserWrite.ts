import { useCallback, useSyncExternalStore } from 'react'
import { getBrowserWriteCard, type BrowserWriteReads } from '../api'
import { subscribeWrite, writeEntry, writeKey } from '../writeStore'
import { useAuthStore } from '../../../stores/authStore'

export const WRITE_CARD_UNREADABLE = 'この書き込みのカードを読み込めませんでした。'

/** One write card as main holds it, loaded when first shown (per signed-in member); its key for a press's answer. */
export function useBrowserWrite(companyId: string, cardId: string, reads?: BrowserWriteReads) {
  const userId = useAuthStore(s => s.user?.id ?? '')
  const key = writeKey(userId, companyId, cardId)
  const load = useCallback(() => (reads ? getBrowserWriteCard(companyId, cardId, reads) : getBrowserWriteCard(companyId, cardId)), [companyId, cardId, reads])
  const subscribe = useCallback((listener: () => void) => subscribeWrite(key, load, WRITE_CARD_UNREADABLE, listener), [key, load])
  return { ...useSyncExternalStore(subscribe, () => writeEntry(key), () => writeEntry(key)), key }
}

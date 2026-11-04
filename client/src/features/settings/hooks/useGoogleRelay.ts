// 「スプレッドシートを中継で使う」 (google-connector.md "The relay"): the member's relay view and own
// records from the server, and 「やめる」 / back on. Allowing it the first time is a Google consent
// (useGoogle's connect); the card is remounted when the permission changes, so it reads again.
import { useCallback, useRef, useState } from 'react'
import type { MyGoogleRelay } from '../../../../shared/google'
import { getGoogleRelay, setGoogleRelay } from '../api'

export function useGoogleRelay(companyId: string) {
  const [data, setData] = useState<MyGoogleRelay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await getGoogleRelay(companyId)
    if (r.success) { setData(r.data); setError(null) } else setError(r.error)
  }, [companyId])

  // The first load runs from a callback ref (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  const setOn = useCallback(async (on: boolean) => {
    setBusy(true)
    try {
      const r = await setGoogleRelay(companyId, on)
      if (r.success) { setData(r.data); setError(null) } else setError(r.error)
    } finally {
      setBusy(false)
    }
  }, [companyId])

  return { loadRef, data, error, busy, setOn, reload }
}

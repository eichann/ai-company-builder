// 「Google」: the member's permission as the server sees it, and the wait after
// 「Google で許可」 (the browser does the rest; we ask again every 3 s for 2 min).
import { useCallback, useRef, useState } from 'react'
import { GOOGLE_OPENED_TEXT, type GoogleFeature, type MyGoogle } from '../../../../shared/google'
import { useInterval } from '../../../shared/hooks/useInterval'
import { connectGoogle, disconnectGoogle, getGoogleStatus } from '../api'

const POLL_MS = 3000
const WAIT_MS = 2 * 60 * 1000

const sameState = (a: MyGoogle | null, b: MyGoogle) =>
  !!a && a.connected === b.connected && a.status === b.status && a.features.join() === b.features.join()

export function useGoogle(companyId: string) {
  const [data, setData] = useState<MyGoogle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** While waiting for the browser: the state before, and when to give up. */
  const [waiting, setWaiting] = useState<{ before: MyGoogle | null; until: number } | null>(null)

  const reload = useCallback(async () => {
    const r = await getGoogleStatus(companyId)
    if (r.success) { setData(r.data); setError(null) } else setError(r.error)
    return r
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  useInterval(() => {
    if (!waiting) return
    if (Date.now() > waiting.until) { setWaiting(null); setMessage(null); return }
    void reload().then(r => {
      if (r.success && !sameState(waiting.before, r.data)) { setWaiting(null); setMessage(null) }
    })
  }, waiting ? POLL_MS : null)

  const connect = useCallback(async (features: GoogleFeature[]) => {
    setBusy(true)
    try {
      const r = await connectGoogle(companyId, features)
      if (!r.success) { setMessage(r.error); return }
      setMessage(GOOGLE_OPENED_TEXT)
      setWaiting({ before: data, until: Date.now() + WAIT_MS })
    } finally {
      setBusy(false)
    }
  }, [companyId, data])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      const r = await disconnectGoogle(companyId)
      if (r.success) { setData(r.data); setMessage(null); setWaiting(null) } else setMessage(r.error)
    } finally {
      setBusy(false)
    }
  }, [companyId])

  return { loadRef, data, error, message, busy, waiting: waiting !== null, connect, disconnect }
}

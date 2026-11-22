// 「AI が動いた回」 (stage 4b-2, owner memo 「段4b 設計メモ」 §4-3 / D11): the event occurrences this PC's AI ran for the member,
// and their 「もう一度」 / 「後始末」 — the server decides who may and when; this only shows its answers and refusals.
import { useCallback, useRef, useState } from 'react'
import type { JobActionResult, MyJobOccurrence } from '../../../../shared/jobs'
import { getMyJobOccurrences, reconcileJobOccurrence, retryJobOccurrence } from '../api'

export function useMyJobOccurrences(companyId: string) {
  const [occurrences, setOccurrences] = useState<MyJobOccurrence[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const r = await getMyJobOccurrences(companyId)
    if (r.success) { setOccurrences(r.occurrences); setError(null) } else setError(r.error)
  }, [companyId])

  // Loaded when the list's element mounts (a callback ref: the renderer's effect count is capped).
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  const run = useCallback(async (act: () => Promise<JobActionResult>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await act()
      await reload()
      // A refusal is said in the server's own words (plain Japanese: why 「もう一度」 cannot be pressed now, …).
      setMessage(r.success ? done : r.error)
    } finally {
      setBusy(false)
    }
  }, [reload])

  const retry = useCallback((o: MyJobOccurrence) => run(() => retryJobOccurrence(companyId, o.jobId, o.id),
    'もう一度動かすようにしました。このアプリが開いていて「自動で進める」が入っているときに動きます。'), [companyId, run])
  const reconcile = useCallback((o: MyJobOccurrence, key: string, done: boolean) => run(() => reconcileJobOccurrence(companyId, o.jobId, o.id, key, done),
    '記録しました。この回はこれだけでは動き出しません。'), [companyId, run])

  return { loadRef, occurrences, error, message, busy, retry, reconcile }
}

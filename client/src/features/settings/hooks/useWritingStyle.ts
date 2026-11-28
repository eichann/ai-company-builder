// 「返事の下書きを、わたしの書き方に合わせる」: the member's check and summaries as main keeps them on this PC, read when the
// section mounts and every 2 s while a summary is being made.
import { useCallback, useRef, useState } from 'react'
import type { WritingAudience, WritingStyle } from '../../../../../shared/core/writing-style'
import type { WritingStyleResult, WritingStyleStatus } from '../../../../shared/writing-style'
import { useInterval } from '../../../shared/hooks/useInterval'
import { getWritingStyle, writingStyleCalls } from '../api'

const POLL_MS = 2000
const calls = () => writingStyleCalls()

export function useWritingStyle(companyId: string) {
  const [status, setStatus] = useState<WritingStyleStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Takes an answer; a refusal's sentence is shown, the last status stays. */
  const take = useCallback((r: WritingStyleResult | undefined): string | null => {
    if (!r) return null
    if (r.success) { setStatus(r.data); setError(null); return null }
    setError(r.error)
    return r.error
  }, [])

  const reload = useCallback(async () => take(await getWritingStyle(companyId)), [companyId, take])

  // Loaded when the section's element mounts (a callback ref: the renderer's effect count is capped).
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  useInterval(() => { void reload() }, status?.building ? POLL_MS : null)

  const run = useCallback(async (call: () => Promise<WritingStyleResult>) => {
    setBusy(true)
    try {
      const failure = take(await call())
      // A making started in the background shows as 「まとめています」 at the next look.
      if (failure === null) void reload()
      return failure
    } finally { setBusy(false) }
  }, [take, reload])

  return {
    loadRef, status, error, busy,
    setEnabled: (on: boolean) => run(() => calls().setEnabled(companyId, on)),
    rebuild: () => run(() => calls().rebuild(companyId)),
    update: (connectorId: string, audience: WritingAudience, style: WritingStyle) => run(() => calls().update(companyId, connectorId, audience, style)),
    remove: (connectorId?: string, audience?: WritingAudience) => run(() => calls().remove(companyId, connectorId, audience)),
    /** A tool was just connected: while the check is on, the summaries are made again with what can be read now. */
    afterConnect: async () => {
      const r = await getWritingStyle(companyId)
      take(r)
      if (r?.success && r.data.enabled) await run(() => calls().rebuild(companyId))
    },
  }
}

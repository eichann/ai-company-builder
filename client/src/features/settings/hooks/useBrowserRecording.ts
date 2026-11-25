// 「記録する」 (Settings › ブラウザ操作; agent-browser.md "Recording"): the member's recording as main holds it — loaded when
// the section mounts, replaced by the answer of each press, and read again when main says it changed by itself (the
// site's window closed and the recording was discarded).
import { useCallback, useRef, useState } from 'react'
import type { BrowserRecordingEdit, BrowserRecordingResult, BrowserRecordingView } from '../../../../shared/browser-recorder'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { browserRecordingCalls, onBrowserChanged } from '../api'

export function useBrowserRecording(companyId: string) {
  const [view, setView] = useState<BrowserRecordingView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const asked = useRef(0)
  const calls = useRef(browserRecordingCalls()).current

  const run = useCallback(async (call: () => Promise<BrowserRecordingResult>) => {
    const n = ++asked.current
    setBusy(true)
    try {
      const r = await call()
      if (n !== asked.current) return
      if (r.ok) { setView(r.view); setMessage(null) } else setMessage(r.message)
    } catch {
      if (n === asked.current) setMessage(null)
    } finally {
      if (n === asked.current) setBusy(false)
    }
  }, [])

  // The first load starts when the element mounts (a callback ref): the renderer's effect count is capped.
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void run(() => calls.get(companyId))
  }, [companyId, run, calls])

  useIpcEvent(onBrowserChanged, change => { if (change.companyId === companyId) void run(() => calls.get(companyId)) })

  return {
    loadRef, view, message, busy,
    start: (host: string) => run(() => calls.start(companyId, host)),
    stop: () => run(() => calls.stop(companyId)),
    edit: (change: BrowserRecordingEdit) => run(() => calls.edit(companyId, change)),
    send: () => run(() => calls.send(companyId)),
    discard: () => run(() => calls.discard(companyId)),
  }
}

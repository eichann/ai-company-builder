// 「この PC」 (Settings › ブラウザ操作): this PC's registration as main reports it — a state, a name and the usable
// combinations, never the PC's key — loaded when the section mounts and replaced by the answer of each press.
import { useCallback, useRef, useState } from 'react'
import type { BrowserPcResult, BrowserPcView } from '../../../../shared/browser-device'
import { getBrowserPc, registerBrowserPc, withdrawBrowserPc } from '../api'

export function useBrowserPc(companyId: string) {
  const [view, setView] = useState<BrowserPcView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const asked = useRef(0)

  const take = useCallback((n: number, r: BrowserPcResult) => {
    if (n !== asked.current) return
    if (r.ok) { setView(r.view); setMessage(null) } else setMessage(r.message)
  }, [])

  const run = useCallback(async (call: () => Promise<BrowserPcResult>) => {
    const n = ++asked.current
    setBusy(true)
    try {
      take(n, await call())
    } catch {
      if (n === asked.current) setMessage(null)
    } finally {
      if (n === asked.current) setBusy(false)
    }
  }, [take])

  // The first load starts when the element mounts (a callback ref): the renderer's effect count is capped.
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void run(() => getBrowserPc(companyId))
  }, [companyId, run])

  return {
    loadRef, view, message, busy,
    register: (label: string) => run(() => registerBrowserPc(companyId, label)),
    withdraw: () => run(() => withdrawBrowserPc(companyId)),
  }
}

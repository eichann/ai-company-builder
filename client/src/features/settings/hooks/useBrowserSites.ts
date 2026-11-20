// 「ブラウザ操作」: the sites the member may open now (empty when the company has it off), read again
// when main says they changed.
import { useCallback, useRef, useState } from 'react'
import type { BrowserSiteView } from '../../../../shared/browser-operation'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getBrowserSites, onBrowserChanged } from '../api'

export function useBrowserSites(companyId: string | undefined) {
  const [sites, setSites] = useState<BrowserSiteView[]>([])
  const asked = useRef(0)

  const reload = useCallback(async () => {
    if (!companyId) return
    const n = ++asked.current
    try {
      const r = await getBrowserSites(companyId)
      if (n === asked.current) setSites(r.sites)
    } catch {
      if (n === asked.current) setSites([])
    }
  }, [companyId])

  // The first load starts when the element mounts (a callback ref): the renderer's effect count is capped.
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || !companyId || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  useIpcEvent(onBrowserChanged, change => { if (change.companyId === companyId) void reload() })

  return { loadRef, sites }
}

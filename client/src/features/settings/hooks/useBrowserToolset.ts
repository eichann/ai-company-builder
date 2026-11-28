// 「係の道具」 (Settings › ブラウザ操作): this PC's tool set for the operator, loaded when the section mounts and saved on a
// choice (agent-browser.md "The operator's tool sets").
import { useCallback, useRef, useState } from 'react'
import type { BrowserOperatorToolset } from '../../../../shared/browser-operator-toolsets'
import { getBrowserOperatorToolset, setBrowserOperatorToolset } from '../api'

export function useBrowserToolset() {
  const [toolset, setToolset] = useState<BrowserOperatorToolset | null>(null)
  const [failed, setFailed] = useState(false)

  // The first load starts when the element mounts (a callback ref): the renderer's effect count is capped.
  const loaded = useRef(false)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loaded.current) return
    loaded.current = true
    getBrowserOperatorToolset().then(setToolset, () => setFailed(true))
  }, [])

  const choose = useCallback(async (next: BrowserOperatorToolset) => {
    setFailed(false)
    try {
      if (await setBrowserOperatorToolset(next)) setToolset(next)
      else setFailed(true)
    } catch {
      setFailed(true)
    }
  }, [])

  return { loadRef, toolset, failed, choose }
}

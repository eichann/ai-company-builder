import { useCallback, useState } from 'react'
import type { PluginScreens } from '../../../../shared/plugin-screens'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getPluginScreens, onPluginsChanged } from '../api'

export interface PluginScreensState {
  screens: PluginScreens[]
  /** The list could not be read (the slots stay empty; a tab already open says so calmly). */
  failed: boolean
}

const NONE: PluginScreensState = { screens: [], failed: false }

/** The company's plugin screens for the four slots (plugin-frame.md), read again when its kept packages change. */
export function usePluginScreens(companyId: string | undefined): PluginScreensState {
  const [state, setState] = useState<{ companyId: string; value: PluginScreensState } | null>(null)
  const load = useCallback((id: string) => {
    void getPluginScreens(id).then(
      // No answer (an older main, a preview without plugins): no slots, not a failure.
      r => setState({ companyId: id, value: !r ? NONE : r.success ? { screens: r.screens, failed: false } : { screens: [], failed: true } }),
      () => setState({ companyId: id, value: { screens: [], failed: true } }),
    )
  }, [])
  // Once per company (a new id re-subscribes); holds nothing to clean up.
  const once = useCallback((listener: (id: string) => void) => { if (companyId) listener(companyId) }, [companyId])
  useIpcEvent(once, load)
  useIpcEvent(onPluginsChanged, change => { if (change.companyId === companyId) load(change.companyId) }, !!companyId)
  return state && state.companyId === companyId ? state.value : NONE
}

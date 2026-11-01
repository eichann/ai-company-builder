import { useCallback, useState } from 'react'
import type { PluginStepButton } from '../../../../shared/ai-turn-steps/plugin'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { listPersonSteps } from '../api'

/** The business plugins' `start: person` steps at a record's state (plugin-steps.md), read when shown. */
export function usePersonSteps(companyId: string, recordId: string): PluginStepButton[] {
  const [state, setState] = useState<{ key: string; steps: PluginStepButton[] }>({ key: '', steps: [] })
  const key = `${companyId}\n${recordId}`
  // Fires once per company and record (a new key re-subscribes); holds nothing to clean up.
  const subscribe = useCallback((listener: (payload: string) => void) => { listener(key) }, [key])
  useIpcEvent(subscribe, (k: string) => {
    const [c, r] = k.split('\n')
    void listPersonSteps(c, r).then(steps => setState({ key: k, steps: Array.isArray(steps) ? steps : [] }), () => {})
  })
  return state.key === key ? state.steps : []
}

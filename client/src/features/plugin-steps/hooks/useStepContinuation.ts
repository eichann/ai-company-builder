import { useCallback, useState } from 'react'
import type { PluginStepContinuation } from '../../../../shared/ai-turn-steps/plugin'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { onRecordsMayHaveChanged, readStepContinuation } from '../api'

/**
 * Where an automatic run of a person's step prepared something for this record (「続きをする」), read
 * when shown and again on every records signal (the run may hand over while the card is open).
 */
export function useStepContinuation(companyId: string, recordId: string): PluginStepContinuation | null {
  const [state, setState] = useState<{ key: string; value: PluginStepContinuation | null }>({ key: '', value: null })
  const key = `${companyId}\n${recordId}`
  const subscribe = useCallback((listener: (payload: string) => void) => {
    listener(key)
    return onRecordsMayHaveChanged(companyId, () => listener(key))
  }, [companyId, key])
  useIpcEvent(subscribe, (k: string) => {
    const [c, r] = k.split('\n')
    void readStepContinuation(c, r).then(value => setState({ key: k, value: value ?? null }), () => {})
  })
  return state.key === key ? state.value : null
}

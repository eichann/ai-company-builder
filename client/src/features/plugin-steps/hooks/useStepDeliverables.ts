import { useCallback, useState } from 'react'
import type { StepDeliverablesView } from '../../../../shared/step-deliverables'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { onRecordsMayHaveChanged, readStepDeliverables } from '../api'

/**
 * What a business plugin's step made for a record (plugin-steps.md "What the step made"), read when
 * the card is shown and again whenever records change (the AI may hand it over while the card is open).
 */
export function useStepDeliverables(companyId: string, recordId: string): StepDeliverablesView | null {
  const [state, setState] = useState<{ key: string; view: StepDeliverablesView | null }>({ key: '', view: null })
  const key = `${companyId}\n${recordId}`
  // Once when shown (a new key re-subscribes), then on every records signal of this company.
  const subscribe = useCallback((listener: (payload: string) => void) => {
    listener(key)
    return onRecordsMayHaveChanged(companyId, () => listener(key))
  }, [companyId, key])
  useIpcEvent(subscribe, (k: string) => {
    const [c, r] = k.split('\n')
    void readStepDeliverables(c, r).then(view => setState({ key: k, view: view ?? null }), () => {})
  })
  return state.key === key ? state.view : null
}

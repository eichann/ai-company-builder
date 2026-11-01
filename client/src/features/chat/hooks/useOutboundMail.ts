import { useCallback, useState } from 'react'
import type { OutboundMailResult } from '../../../../shared/outbound-mail'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getOutboundMail } from '../api'

/** One mail draft as the server holds it now (null while loading). The caller keys the component by id. */
export function useOutboundMail(companyId: string, messageId: string): OutboundMailResult | null {
  const [result, setResult] = useState<OutboundMailResult | null>(null)
  // The one read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, () => {
    void getOutboundMail(companyId, messageId).then(setResult, () => setResult({ success: false, offline: true, code: null, error: '表示できませんでした。' }))
  })
  return result
}

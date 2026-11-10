import { useCallback, useState } from 'react'
import { driveLinkView } from '../../../../shared/google'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { getDriveSetup } from '../api'

/**
 * Whether the card's ［Google Drive のファイルをつなぐ］ can work now (Google set up for the company,
 * Drive offered, allowed yet), read when the card opens and again after each press (`reload`).
 * Only for a company without the shared folder (`enabled`); until known it is offered.
 */
export function useDriveLinkSetup(companyId: string, enabled: boolean) {
  const [view, setView] = useState(() => driveLinkView(null))
  const reload = useCallback(() => {
    if (!enabled) return
    void Promise.resolve().then(() => getDriveSetup(companyId)).then(r => setView(driveLinkView(r ?? null)), () => setView(driveLinkView(null)))
  }, [companyId, enabled])
  // The one read through useIpcEvent with nothing to listen to: the renderer's effect count is capped.
  const once = useCallback((listener: (payload: undefined) => void) => { listener(undefined) }, [])
  useIpcEvent(once, reload)
  return { ...view, reload }
}

// The member's own-key state for one service, from the company server (last 4 only),
// for the chat's "no key" card. Read once when the card appears.
import { useEffect, useState } from 'react'
import type { MyBrokerService } from '../../../../shared/broker-keys'
import { listOwnBrokerKeys } from '../api'

export type OwnKeyServiceState =
  | { kind: 'loading' }
  /** The server could not be asked (offline, older server): the card still offers the settings. */
  | { kind: 'unknown' }
  | { kind: 'known'; enabled: boolean; service: MyBrokerService | null }

export function useOwnKeyService(companyId: string | undefined, service: string): OwnKeyServiceState {
  const [state, setState] = useState<OwnKeyServiceState>({ kind: 'loading' })
  useEffect(() => {
    if (!companyId) { setState({ kind: 'unknown' }); return }
    let live = true
    void Promise.resolve()
      .then(() => listOwnBrokerKeys(companyId))
      .then(r => {
        if (!live) return
        setState(r?.success ? { kind: 'known', enabled: r.data.enabled, service: r.data.services.find(s => s.service === service) ?? null } : { kind: 'unknown' })
      })
      .catch(() => { if (live) setState({ kind: 'unknown' }) })
    return () => { live = false }
  }, [companyId, service])
  return state
}

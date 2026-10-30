// 「自分の鍵」: the member's view from the server, and registering / deleting
// one's own key. The pasted value lives only in the form until it is sent.
import { useCallback, useEffect, useState } from 'react'
import type { MyBrokerKeys } from '../../../../shared/broker-keys'
import { deleteOwnKey, listOwnKeys, saveOwnKey } from '../api'

export function useOwnKeys(companyId: string) {
  const [data, setData] = useState<MyBrokerKeys | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const r = await listOwnKeys(companyId)
    setLoading(false)
    if (r.success) { setData(r.data); setError(null) } else setError(r.error)
  }, [companyId])

  useEffect(() => { void reload() }, [reload])

  /** Sends the key; resolves to an error sentence, or null when saved. */
  const save = useCallback(async (service: string, secret: string, displayName?: string): Promise<string | null> => {
    setBusy(service)
    try {
      const r = await saveOwnKey(companyId, service, secret, displayName)
      if (!r.success) return r.error
      setData(r.data)
      return null
    } finally {
      setBusy(null)
    }
  }, [companyId])

  const remove = useCallback(async (service: string): Promise<string | null> => {
    setBusy(service)
    try {
      const r = await deleteOwnKey(companyId, service)
      if (!r.success) return r.error
      setData(r.data)
      return null
    } finally {
      setBusy(null)
    }
  }, [companyId])

  return { data, error, loading, busy, reload, save, remove }
}

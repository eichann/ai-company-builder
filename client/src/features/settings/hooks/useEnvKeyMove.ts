// 「この鍵をサーバーに移す」: the member's own-key view (to know where the server
// would take a key) and moving one .env key there. Main does the move; the value
// never comes here, only the server's view and a sentence.
import { useCallback, useEffect, useState } from 'react'
import { KEY_CHECK_TEXT, type MyBrokerKeys } from '../../../../shared/broker-keys'
import { listOwnKeys, moveEnvKeyToServer } from '../api'

export function useEnvKeyMove(companyId: string, rootPath: string, onMoved: () => void) {
  const [data, setData] = useState<MyBrokerKeys | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, { text: string; failed: boolean }>>({})

  useEffect(() => {
    let live = true
    // Not reachable (an older main, offline): nothing is offered for moving.
    void Promise.resolve()
      .then(() => listOwnKeys(companyId))
      .then(r => { if (live) setData(r?.success ? r.data : null) })
      .catch(() => { if (live) setData(null) })
    return () => { live = false }
  }, [companyId])

  const move = useCallback(async (name: string) => {
    setBusy(name)
    try {
      const r = await moveEnvKeyToServer(companyId, rootPath, name)
      if (!r.success) {
        setMessages(m => ({ ...m, [name]: { text: r.error, failed: true } }))
        return
      }
      setData(r.data)
      const check = r.data.check ? KEY_CHECK_TEXT[r.data.check.result] : ''
      const local = r.removed
        ? 'サーバーに移し、この PC の .env から消しました。'
        : 'サーバーに移しました。この PC の .env が途中で変わったため、.env からは消していません。'
      setMessages(m => ({ ...m, [name]: { text: `${local}${check}`, failed: false } }))
      onMoved()
    } finally {
      setBusy(null)
    }
  }, [companyId, rootPath, onMoved])

  return { data, busy, messages, move }
}

import { useEffect, useMemo, useState } from 'react'
import type { ChatServerInfo } from '../../../../shared/ipc-contract'
import { createChatServerClient, type ChatServerClient } from '../chatServerClient'

/**
 * The chat server's client, once main has told the renderer where it listens
 * (asked on mount, and pushed again when the page has loaded). Null until then.
 *
 * Main answers both with a fresh copy of the same address; the client is
 * keyed by its values, so every tab keeps one stable client (its identity is a
 * dependency of the chat transport, the unmount clean-up and the requests).
 */
export function useChatServer(): ChatServerClient | null {
  const [info, setInfo] = useState<ChatServerInfo | null>(null)

  useEffect(() => {
    window.electronAPI.getChatServerInfo().then(result => {
      if (result) setInfo(result)
    })
    return window.electronAPI.onChatServerInfo(serverInfo => {
      setInfo(serverInfo)
    })
  }, [])

  const port = info?.port
  const authToken = info?.authToken
  return useMemo(
    () => port !== undefined && authToken !== undefined ? createChatServerClient({ port, authToken }) : null,
    [port, authToken],
  )
}

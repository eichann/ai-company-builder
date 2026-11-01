// 「Slack」: the member's permission as the server sees it, the wait after
// 「Slack で許可」 (the browser does the rest; we ask again every 3 s for 2 min),
// and the 知らせの DM switch.
import { useCallback, useRef, useState } from 'react'
import { SLACK_OPENED_TEXT, type MySlack, type SlackFeature } from '../../../../shared/slack'
import { useInterval } from '../../../shared/hooks/useInterval'
import { connectSlack, disconnectSlack, getSlackStatus, setSlackFeature } from '../api'

const POLL_MS = 3000
const WAIT_MS = 2 * 60 * 1000

const sameState = (a: MySlack | null, b: MySlack) =>
  !!a && a.connected === b.connected && a.status === b.status && a.features.join() === b.features.join()

export function useSlack(companyId: string) {
  const [data, setData] = useState<MySlack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** While waiting for the browser: the state before, and when to give up. */
  const [waiting, setWaiting] = useState<{ before: MySlack | null; until: number } | null>(null)

  const reload = useCallback(async () => {
    const r = await getSlackStatus(companyId)
    if (r.success) { setData(r.data); setError(null) } else setError(r.error)
    return r
  }, [companyId])

  // The first load starts when the section's element mounts (a callback ref, committed like an
  // effect): the renderer's effect count is capped (renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])

  useInterval(() => {
    if (!waiting) return
    if (Date.now() > waiting.until) { setWaiting(null); setMessage(null); return }
    void reload().then(r => {
      if (r.success && !sameState(waiting.before, r.data)) { setWaiting(null); setMessage(null) }
    })
  }, waiting ? POLL_MS : null)

  const connect = useCallback(async (features: SlackFeature[]) => {
    setBusy(true)
    try {
      const r = await connectSlack(companyId, features)
      if (!r.success) { setMessage(r.error); return }
      setMessage(SLACK_OPENED_TEXT)
      setWaiting({ before: data, until: Date.now() + WAIT_MS })
    } finally {
      setBusy(false)
    }
  }, [companyId, data])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      const r = await disconnectSlack(companyId)
      if (r.success) { setData(r.data); setMessage(null); setWaiting(null) } else setMessage(r.error)
    } finally {
      setBusy(false)
    }
  }, [companyId])

  /** 「あなたの番」 as a Slack DM: on / off (the Slack permission's `notices`). */
  const setNotices = useCallback(async (on: boolean) => {
    setBusy(true)
    try {
      const r = await setSlackFeature(companyId, 'notices', on)
      if (r.success) { setData(r.data); setMessage(null) } else setMessage(r.error)
    } finally {
      setBusy(false)
    }
  }, [companyId])

  return { loadRef, data, error, message, busy, waiting: waiting !== null, connect, disconnect, setNotices }
}

// 「仕事の道具をつなぐ」: the member's Google and Slack state, the one Google consent and the wait
// after it (the browser does the rest; asked again every 3 s for up to 2 min), and 「あとで」.
import { useCallback, useRef, useState } from 'react'
import { GOOGLE_OPENED_TEXT, type GoogleFeature, type MyGoogle } from '../../../../shared/google'
import { SLACK_OPENED_TEXT, type MySlack } from '../../../../shared/slack'
import { SLACK_SETUP_FEATURES } from '../../../../../shared/core/slack'
import { useInterval } from '../../../shared/hooks/useInterval'
import { connectGoogleAll, connectSlack, getGoogleStatus, getSlackStatus, markGoogleSeen, markSlackSeen } from '../api'
import { googleDeclined, googleDeclinedText } from '../connectTools'

const POLL_MS = 3000
const WAIT_MS = 2 * 60 * 1000

type Waiting =
  | { service: 'google'; asked: GoogleFeature[]; before: string; until: number }
  | { service: 'slack'; before: string; until: number }

const googleKey = (g: MyGoogle | null) => (g ? `${g.connected}|${g.status}|${g.features.join()}` : '')
const slackKey = (s: MySlack | null) => (s ? `${s.connected}|${s.status}|${s.features.join()}` : '')

export function useConnectTools(companyId: string) {
  const [google, setGoogle] = useState<MyGoogle | null>(null)
  const [slack, setSlack] = useState<MySlack | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState<Waiting | null>(null)

  const reload = useCallback(async () => {
    const [g, s] = await Promise.all([getGoogleStatus(companyId), getSlackStatus(companyId)])
    const nextG = g.success ? g.data : null
    const nextS = s.success ? s.data : null
    setGoogle(nextG)
    setSlack(nextS)
    setLoaded(true)
    return { google: nextG, slack: nextS }
  }, [companyId])

  // The first load starts when the screen's element mounts (a callback ref, committed like an
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
    void reload().then(now => {
      if (waiting.service === 'google' && now.google && googleKey(now.google) !== waiting.before) {
        setWaiting(null)
        setMessage(googleDeclinedText(googleDeclined(waiting.asked, now.google)))
      }
      if (waiting.service === 'slack' && now.slack && slackKey(now.slack) !== waiting.before) {
        setWaiting(null)
        setMessage(null)
      }
    })
  }, waiting ? POLL_MS : null)

  /** 「Google でつなぐ」: every feature the company offers, in one consent (the server marks them shown). */
  const connectGoogle = useCallback(async () => {
    if (!google) return
    setBusy(true)
    try {
      const r = await connectGoogleAll(companyId)
      if (!r.success) { setMessage(r.error); return }
      setMessage(GOOGLE_OPENED_TEXT)
      setWaiting({ service: 'google', asked: [...(google.companyFeatures ?? [])], before: googleKey(google), until: Date.now() + WAIT_MS })
    } finally {
      setBusy(false)
    }
  }, [companyId, google])

  const connectSlackNow = useCallback(async () => {
    setBusy(true)
    try {
      await markSlackSeen(companyId)
      const r = await connectSlack(companyId, [...SLACK_SETUP_FEATURES])
      if (!r.success) { setMessage(r.error); return }
      setMessage(SLACK_OPENED_TEXT)
      setWaiting({ service: 'slack', before: slackKey(slack), until: Date.now() + WAIT_MS })
    } finally {
      setBusy(false)
    }
  }, [companyId, slack])

  /** 「あとで」 / closing the first-run screen: what is offered now is not offered by itself again. */
  const later = useCallback(async () => {
    await Promise.all([
      google?.available ? markGoogleSeen(companyId) : null,
      slack?.available ? markSlackSeen(companyId) : null,
    ])
  }, [companyId, google, slack])

  return { loadRef, loaded, google, slack, message, busy, waiting: waiting !== null, connectGoogle, connectSlack: connectSlackNow, later }
}

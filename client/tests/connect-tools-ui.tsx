/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for 「仕事の道具をつなぐ」 (src/features/settings/components/ConnectToolsScreen.tsx).
// `?state=first` (a new member: Google and Slack offered), `new` (shown before; the company
// turned 受信 on since), `seen` (nothing new: the screen stays closed), `noslack` (the company
// has no Slack), `settings` (opened from 設定). 「Google でつなぐ」 here grants everything but
// メール (the member unticked it on Google's page). `&theme=dark` for the dark look. `&calendar=1`
// also mounts the task list's today's-calendar hook (one meeting once Google is allowed). `&minutes=1` mounts the
// title bar's 「議事録を確かめる」 as the minutes slot shows it (only while main says minutes are available). `&manual=1`: the user
// manual's company (検証A社's domain and 山田さん's address, client/tests/manual/scenes.ts chapter 28).
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { ConnectToolsScreen } from '../src/features/settings/components/ConnectToolsScreen'
import { useCalendarToday } from '../src/features/tasks/hooks/useCalendarToday'
import { MinutesCheckButton } from '../src/features/minutes/components/MinutesCheckButton'
import { useMinutesNotices } from '../src/features/minutes/hooks/useMinutesNotices'
import type { MyGoogle } from '../shared/google'
import type { MySlack } from '../shared/slack'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'first'
const MANUAL = params.get('manual') === '1'
const DOMAIN = MANUAL ? 'kensho-a.example' : 'div.example'
const EMAIL = MANUAL ? 'yamada@kensho-a.example' : 'sato@div.example'
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

let google: MyGoogle = {
  available: true, reason: null, connected: false, status: null, googleEmail: null, features: [], featuresOff: [],
  domain: DOMAIN, practice: false, companyFeatures: ['minutes', 'mail', 'drive', 'inbox'], seen: [],
}
let slack: MySlack = { available: state !== 'noslack', reason: state === 'noslack' ? 'not-configured' : null, connected: false, status: null, features: [], featuresOff: [], practice: false, seen: [] }
if (state === 'new' || state === 'seen') {
  google = { ...google, connected: true, status: 'active', googleEmail: EMAIL, features: ['minutes', 'mail', 'drive'], seen: ['minutes', 'mail', 'drive', ...(state === 'seen' ? ['inbox' as const] : [])] }
  slack = { ...slack, connected: true, status: 'active', features: ['read', 'notices'], seen: ['read', 'notices'] }
}

const calls: string[] = []
const minutesListeners = new Set<(change: { companyId: string }) => void>()
;(window as unknown as { __connectToolsCalls: string[] }).__connectToolsCalls = calls

installElectronAPI({
  getGoogleStatus: async () => ({ success: true, data: google }),
  getSlackStatus: async () => ({ success: true, data: slack }),
  connectGoogleAll: async () => {
    calls.push('connectGoogleAll')
    // The member unticked メールを送る on Google's page.
    google = { ...google, connected: true, status: 'active', googleEmail: EMAIL, features: google.companyFeatures.filter(f => f !== 'mail'), seen: [...google.companyFeatures] }
    return { success: true }
  },
  connectSlack: async (_companyId, features) => { calls.push(`connectSlack:${features.join(',')}`); return { success: true } },
  markGoogleSeen: async () => { calls.push('markGoogleSeen'); google = { ...google, seen: [...google.companyFeatures] }; return { success: true, data: google } },
  // The server answers from the grant: not-connected until Google is allowed.
  getCalendarToday: async () => {
    calls.push('getCalendarToday')
    return { success: true, data: { date: '2026-11-04', timeZone: 'Asia/Tokyo', reason: google.connected ? null : 'not-connected', events: google.connected ? [{ id: 'ev-1', title: 'B社 打ち合わせ', start: '2026-11-04T05:00:00.000Z', end: '2026-11-04T06:00:00.000Z', allDay: false, online: true, attendeeCount: 3, hasExternalAttendees: true }] : [] } }
  },
  // Main's received-minutes checker, as it answers: available once the grant includes minutes, told after each check.
  watchMinutes: async () => { calls.push('watchMinutes') },
  checkMinutes: async () => { calls.push('checkMinutes'); for (const l of minutesListeners) l({ companyId: 'co-preview' }); return { success: true } },
  getMinutesNotices: async () => ({ available: google.connected && google.features.includes('minutes'), notices: [] }),
  onMinutesChanged: (callback) => { minutesListeners.add(callback); return () => { minutesListeners.delete(callback) } },
  markSlackSeen: async () => { calls.push('markSlackSeen'); slack = { ...slack, seen: ['read', 'notices'] }; return { success: true, data: slack } },
})

function CalendarProbe() {
  const today = useCalendarToday('co-preview')
  return <output data-testid="calendar">{today ? (today.reason ?? today.events.map(e => e.title).join(',')) : 'loading'}</output>
}

function MinutesProbe() {
  const minutes = useMinutesNotices('co-preview')
  return minutes.available ? <MinutesCheckButton companyId="co-preview" /> : null
}

function Preview() {
  const [log] = useState(calls)
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <p className="p-4 text-xs text-zinc-500">表示確認用の人工データ。本番のサーバーや Google には接続しません。</p>
      <ConnectToolsScreen companyId="co-preview" firstRun={state !== 'settings'} />
      <output data-testid="calls" hidden>{log.length}</output>
      {params.get('calendar') && <CalendarProbe />}
      {params.get('minutes') && <MinutesProbe />}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

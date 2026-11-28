/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for 「仕事の道具をつなぐ」 (src/features/settings/components/ConnectToolsScreen.tsx).
// `?state=first` (a new member: Google and Slack offered), `new` (shown before; the company
// turned 受信 on since), `seen` (nothing new: the screen stays closed), `noslack` (the company
// has no Slack), `settings` (opened from 設定). 「Google でつなぐ」 here grants everything but
// メール (the member unticked it on Google's page). `&theme=dark` for the dark look. `&calendar=1`
// also mounts the task list's today's-calendar hook (one meeting once Google is allowed). `&minutes=1` mounts the
// minutes slot's hook and says whether main reports minutes as available. `&manual=1`: the user
// manual's company (検証A社's domain and 山田さん's address, client/tests/manual/scenes.ts chapter 28).
// 「返事の下書きを、わたしの書き方に合わせる」: off at first; `&writing=on` starts with the check on and two summaries.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { ConnectToolsScreen } from '../src/features/settings/components/ConnectToolsScreen'
import { useCalendarToday } from '../src/features/tasks/hooks/useCalendarToday'
import { useMinutesNotices } from '../src/features/minutes/hooks/useMinutesNotices'
import type { MyGoogle } from '../shared/google'
import type { MySlack } from '../shared/slack'
import type { WritingStyleStatus } from '../shared/writing-style'
import { parseWritingStyle, type WritingStyle } from '../../shared/core/writing-style'
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

const STYLE: WritingStyle = { greeting: 'お疲れさまです。', closing: 'よろしくお願いします。', sentenceLength: 'short', politeness: 'polite', phrases: ['承知しました', '助かります'], emoji: 'sometimes', notes: '改行を多めに使う' }
const kept = (style: WritingStyle, sampleCount: number) => ({ style, madeAt: '2026-11-27T00:00:00.000Z', sampleCount, edited: false })
const madeStyles = (): WritingStyleStatus['styles'] => [
  { connectorId: 'google', label: 'Google Workspace', audience: 'outside', kept: kept({ ...STYLE, greeting: 'いつもお世話になっております。', politeness: 'formal', emoji: 'none' }, 12) },
  { connectorId: 'slack', label: 'Slack', audience: 'inside', kept: kept(STYLE, 20) },
]
let writing: WritingStyleStatus = {
  available: true, enabled: params.get('writing') === 'on', building: false,
  sources: [{ connectorId: 'google', label: 'Google Workspace', readable: true }, { connectorId: 'slack', label: 'Slack', readable: true }],
  styles: params.get('writing') === 'on' ? madeStyles() : [], note: null,
}
const writingAnswer = () => ({ success: true as const, data: writing })
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
  getWritingStyle: async () => writingAnswer(),
  setWritingStyleEnabled: async (_companyId, on) => {
    calls.push(`writing:${on ? 'on' : 'off'}`)
    writing = { ...writing, enabled: on, styles: on ? madeStyles() : writing.styles }
    return writingAnswer()
  },
  rebuildWritingStyle: async () => { calls.push('writing:rebuild'); return writingAnswer() },
  // Main checks the member's correction like the AI's (parseWritingStyle) and keeps it as theirs.
  updateWritingStyle: async (_companyId, connectorId, audience, style) => {
    calls.push(`writing:update:${connectorId}:${audience}:${JSON.stringify(style)}`)
    const checked = parseWritingStyle(style)
    if (!checked) return { success: false, offline: false, error: '入力が正しくありません。' }
    writing = { ...writing, styles: writing.styles.map(e => e.connectorId === connectorId && e.audience === audience ? { ...e, kept: { ...e.kept, style: checked, edited: true } } : e) }
    return writingAnswer()
  },
  removeWritingStyle: async (_companyId, connectorId, audience) => {
    calls.push(`writing:remove:${connectorId ?? 'all'}:${audience ?? 'all'}`)
    writing = connectorId ? { ...writing, styles: writing.styles.filter(e => !(e.connectorId === connectorId && e.audience === audience)) } : { ...writing, enabled: false, styles: [] }
    return writingAnswer()
  },
  markSlackSeen: async () => { calls.push('markSlackSeen'); slack = { ...slack, seen: ['read', 'notices'] }; return { success: true, data: slack } },
})

function CalendarProbe() {
  const today = useCalendarToday('co-preview')
  return <output data-testid="calendar">{today ? (today.reason ?? today.events.map(e => e.title).join(',')) : 'loading'}</output>
}

function MinutesProbe() {
  const minutes = useMinutesNotices('co-preview')
  return <output data-testid="minutes">{minutes.available ? 'available' : 'off'}</output>
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

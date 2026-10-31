import { useRef } from 'react'
import { commandArea, useKeybindings } from '../src/shared/commands/commands'
import { createRoot } from 'react-dom/client'
import { VoiceInputControl, type VoiceEditor } from '../src/features/chat/components/VoiceInputControl'
import '../src/index.css'
import type { VoiceCapabilities, VoiceDeviceList } from '../shared/voice-input'

// Preview of the voice input's availability states (served by Vite:
// /tests/voice-input-ui.html?scenario=…). Each scenario scripts what the probe
// and the device list answer on the first call and on 「もう一度確認」.
// `?panes=2`: two chat panes (左 / 右), each a `chat` focus area with its own
// voice control, to check that the voice key reaches only the pane used last.
const mic: VoiceDeviceList = { ok: true, devices: [{ id: 'builtin', name: 'MacBook Proのマイク', isDefault: true }] }
const timeoutCaps: VoiceCapabilities = { available: false, reason: '日本語の音声認識の確認が30秒以内に終わりませんでした。Macの負荷が高いと時間がかかることがあります', retryable: true }
const scenarios: Record<string, { label: string; caps: VoiceCapabilities[]; devices: VoiceDeviceList[] }> = {
  'loaded-mac': { label: '負荷の高いMac（確認・一覧ともタイムアウト → もう一度確認で回復）', caps: [timeoutCaps, { available: true }], devices: [{ ok: false, error: 'timeout' }, mic] },
  'devices-timeout': { label: '音声認識は利用可・マイク一覧だけタイムアウト', caps: [{ available: true }], devices: [{ ok: false, error: 'timeout' }, mic] },
  'devices-failed': { label: 'マイク一覧の取得に失敗', caps: [{ available: true }], devices: [{ ok: false, error: 'failed' }] },
  'no-devices': { label: 'マイクが1つもない', caps: [{ available: true }], devices: [{ ok: true, devices: [] }, mic] },
  'model-missing': { label: '日本語モデル未インストール（再試行可）', caps: [{ available: false, reason: '日本語の音声認識モデルが未インストールです。macOSの音声入力設定で日本語を追加してください', retryable: true }], devices: [mic] },
  'unsupported': { label: 'macOS 26未満（再試行なし）', caps: [{ available: false, reason: '音声入力にはmacOS 26以降が必要です' }], devices: [mic] },
  healthy: { label: '正常', caps: [{ available: true }], devices: [mic] },
}
const params = new URLSearchParams(location.search)
const twoPanes = params.get('panes') === '2'
const name = params.get('scenario') ?? (twoPanes ? 'healthy' : 'loaded-mac')
const scenario = scenarios[name] ?? scenarios['loaded-mac']
const answer = <T,>(list: T[], calls: { n: number }) => new Promise<T>(resolve => setTimeout(() => resolve(list[Math.min(calls.n++, list.length - 1)]), 1200))
const capsCalls = { n: 0 }
const deviceCalls = { n: 0 }
Object.assign(window, { electronAPI: { voiceInput: {
  capabilities: () => answer(scenario.caps, capsCalls),
  devices: () => answer(scenario.devices, deviceCalls),
  start: async () => {}, stop: async () => {}, cancel: async () => {},
  onEvent: () => () => {},
} } })

function Pane({ id, label }: { id: string; label: string }) {
  const editor = useRef<VoiceEditor | null>({ captureInsertion: () => () => true })
  return <section aria-label={label} className="flex-1 rounded-lg border" {...commandArea('chat', id)}>
    <VoiceInputControl editor={editor} active pane={id} disabled={false} scope={id} onBusy={() => {}} />
    <textarea aria-label={`${label}の入力欄`} className="block w-full border-t p-3 text-sm bg-transparent" placeholder="メッセージを入力…" />
  </section>
}

function TwoPanes() {
  useKeybindings()
  return <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-900 dark:text-zinc-100 p-4 flex gap-4">
    <Pane id="chat" label="左の相談" />
    <Pane id="right" label="右の相談" />
  </main>
}

export function Preview() {
  const editor = useRef<VoiceEditor | null>({ captureInsertion: () => () => true })
  if (twoPanes) return <TwoPanes />
  return <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-900 dark:text-zinc-100">
    <div className="px-4 py-2 text-xs bg-amber-50 text-amber-900">表示確認用の人工データです。音声認識やマイクには接続しません。</div>
    <nav className="flex flex-wrap gap-2 p-4 text-xs">{Object.entries(scenarios).map(([key, s]) => <a key={key} href={`?scenario=${key}`} className={`rounded border px-2 py-1 ${key === name ? 'font-bold underline' : ''}`}>{s.label}</a>)}</nav>
    <section className="mx-4 max-w-xl rounded-lg border"><VoiceInputControl editor={editor} active pane="chat" disabled={false} scope="preview" onBusy={() => {}} /><div className="border-t p-3 text-sm opacity-50">メッセージを入力…</div></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)

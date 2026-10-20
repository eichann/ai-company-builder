import { voiceShortcut, formatVoiceShortcut, matchesVoiceShortcut } from '../../lib/voiceShortcut'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Microphone, Stop, X, CaretDown } from '@phosphor-icons/react'
import type { VoiceCapabilities } from '../../../shared/voice-input'

import { microphoneSelection } from '../../lib/microphoneSelection'

export interface VoiceEditor {
  focus?: () => void
  captureInsertion: () => (text: string) => boolean
}

export function VoiceInputControl({ editor, active, disabled, scope, onBusy }: {
  editor: React.MutableRefObject<VoiceEditor | null>
  active: boolean
  disabled: boolean
  scope: string
  onBusy: (busy: boolean) => void
}) {
  const shortcut = useSyncExternalStore(voiceShortcut.subscribe, voiceShortcut.getSnapshot)
  const { devices, deviceError, selectedDevice, configured } = useSyncExternalStore(microphoneSelection.subscribe, microphoneSelection.getSnapshot)
  const [showDevices, setShowDevices] = useState(false)
  const [recordingDevice, setRecordingDevice] = useState('')
  const [level, setLevel] = useState(0)
  const [clipping, setClipping] = useState(false)
  const lastSample = useRef(0)
  const lastAudible = useRef(0)
  const refreshDevices = microphoneSelection.refresh
  useEffect(() => {
    if (!microphoneSelection.getSnapshot().devices) void refreshDevices()
  }, [refreshDevices])
  useEffect(() => {
    if (!active || !showDevices) return
    const timer = setInterval(() => { void refreshDevices() }, 3000)
    return () => clearInterval(timer)
  }, [active, showDevices, refreshDevices])
  const deviceMissing = Boolean(selectedDevice && devices && !devices.some(d => d.id === selectedDevice))
  const deviceLabel = selectedDevice ? devices?.find(d => d.id === selectedDevice)?.name ?? '未接続のマイク' : `システムの既定：${devices?.find(d => d.isDefault)?.name ?? '未接続'}`
  const [caps, setCaps] = useState<VoiceCapabilities>()
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [rawText, setRawText] = useState('')
  const [seconds, setSeconds] = useState(0)
  const operation = useRef<{ id: string; insert: (text: string) => boolean; scope: string }>()
  const current = useRef({ active, scope })
  current.current = { active, scope }
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const busy = phase !== 'idle'
  const cancel = useCallback(() => {
    const previous = operation.current
    operation.current = undefined
    if (previous) void window.electronAPI.voiceInput.cancel(previous.id).catch(() => {})
    setPhase('idle')
    setLevel(0); setClipping(false)
    onBusy(false)
    setRawText('')
  }, [onBusy])

  useEffect(() => {
    void window.electronAPI.voiceInput.capabilities().then(setCaps).catch(() => setCaps({ available: false, reason: '音声入力を利用できません。アプリを再起動してください' }))
  }, [])
  useEffect(() => window.electronAPI.voiceInput.onEvent(event => {
    const op = operation.current
    if (!op || op.id !== event.requestId || !current.current.active || op.scope !== current.current.scope) return
    if (event.type === 'level') {
      lastSample.current = Date.now()
      if (event.level > 0.08) lastAudible.current = Date.now()
      setLevel(event.level); setClipping(event.clipping)
      return
    }
    if (event.type === 'result') {
      if (!op.insert(event.text)) { setRawText(event.text); setError('入力欄が変わったため自動挿入しませんでした。下の文章をコピーできます') }
      else { operation.current = undefined; setRawText(''); setError('') }
      setPhase('idle'); onBusy(false)
    } else if (event.type === 'error') {
      setError(event.message); setRawText(event.rawText ?? ''); setPhase('idle'); onBusy(false)
      if (!event.rawText) operation.current = undefined
    } else {
      setPhase(event.type)
      if (event.type === 'listening') { editor.current?.focus?.(); setSeconds(0); setRecordingDevice(event.deviceName ?? 'マイク'); lastSample.current = 0; lastAudible.current = Date.now() }
    }
  }), [onBusy, editor])
  useEffect(() => { if (!active || disabled) cancel(); return cancel }, [active, scope, disabled, cancel])
  useEffect(() => {
    if (phase !== 'listening') return
    const timer = setInterval(() => { setSeconds(value => value + 1); if (Date.now() - lastSample.current > 500) { setLevel(0); setClipping(false) } }, 1000)
    return () => clearInterval(timer)
  }, [phase])
  const startOrStop = useCallback(async () => {
    if (phaseRef.current === 'listening' && operation.current) {
      phaseRef.current = 'finalizing'
      setPhase('finalizing')
      await window.electronAPI.voiceInput.stop(operation.current.id).catch(() => { cancel(); setError('録音を停止できませんでした') })
      return
    }
    if (phaseRef.current !== 'idle' || disabled || !active || !caps?.available || deviceMissing || !devices?.length || !editor.current) return
    const id = crypto.randomUUID()
    operation.current = { id, insert: editor.current.captureInsertion(), scope }
    phaseRef.current = 'preparing'
    setError(''); setRawText(''); setLevel(0); setClipping(false); setShowDevices(false); setPhase('preparing'); onBusy(true)
    try { await window.electronAPI.voiceInput.start(id, selectedDevice || undefined) }
    catch { if (operation.current?.id === id) { cancel(); setError('音声入力を開始できませんでした。別の録音が動作していないかご確認ください') } }
  }, [active, caps, disabled, editor, scope, onBusy, cancel, selectedDevice, devices, deviceMissing])
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || document.querySelector('[role="dialog"]')) return
      if (matchesVoiceShortcut(event, shortcut)) { event.preventDefault(); event.stopPropagation(); void startOrStop() }
      if (event.key === 'Escape' && operation.current) { event.preventDefault(); cancel() }
    }
    const blur = () => { if (phaseRef.current !== 'preparing') cancel() }
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', blur) }
  }, [active, startOrStop, cancel, shortcut])
  return <div className="px-2 pt-2 text-xs" aria-live="polite">
    <div className="flex items-center gap-2 flex-wrap">
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void startOrStop()}
        disabled={phase !== 'listening' && (busy || disabled || !caps?.available || !devices?.length || deviceMissing)}
        title={caps?.reason ?? `音声入力（${formatVoiceShortcut(shortcut)}：開始／停止）`}
        aria-label={phase === 'listening' ? '録音を停止して文章を整える' : '音声入力を開始'}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 disabled:opacity-40 ${phase === 'listening' ? 'text-red-600 bg-red-50 dark:bg-red-950' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
        {phase === 'listening' ? <Stop size={16} weight="fill" /> : <Microphone size={16} />}
        {phase === 'listening' ? `録音中 ${seconds}秒・停止` : phase === 'preparing' ? 'マイクを準備中…' : phase === 'finalizing' ? '音声を認識中…' : phase === 'polishing' ? '文章を整えています…' : '音声入力'}
      </button>
      <kbd className="shrink-0 whitespace-nowrap rounded border border-gray-200 dark:border-zinc-700 px-1.5 py-0.5 font-sans text-xs leading-5 text-gray-600 dark:text-zinc-300" title="もう一度押すと停止">{formatVoiceShortcut(shortcut)}</kbd>
      <span className="text-gray-500 dark:text-zinc-400">{phase === 'listening' ? 'もう1回押すと停止・整文' : '1回押すと開始・もう1回で停止'}</span>
      <button type="button" disabled={busy || !caps?.available} aria-label="マイクを選択" aria-expanded={showDevices}
        onClick={() => { setShowDevices(value => !value); void refreshDevices() }} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"><CaretDown size={14} /></button>
      {busy && <button type="button" onClick={cancel} aria-label="音声入力をキャンセル" className="p-1"><X size={16} /></button>}
      {!busy && caps?.available && !rawText && <span className="opacity-50">話した内容をAIで整えて入力します</span>}
      {caps && !caps.available && <span className="opacity-60">{caps.reason}</span>}
    </div>
    {caps?.available && <div className="mt-1 mb-2 text-[11px] text-gray-500 dark:text-zinc-400 truncate" title={phase === 'listening' ? recordingDevice : deviceLabel}>
      {phase === 'listening' ? recordingDevice : deviceLabel}
    </div>}
    {caps?.available && !configured && !busy && <div className="my-2 flex items-center gap-2 flex-wrap rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-amber-800 dark:text-amber-200">
      <span>はじめに、自分の使うマイクを設定してください。</span>
      <button type="button" className="underline font-medium" onClick={() => { setShowDevices(true); void refreshDevices() }}>マイクを設定</button>
    </div>}
    {showDevices && <div className="my-2 rounded-lg border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">マイク設定</span>
        <button type="button" onClick={() => setShowDevices(false)} aria-label="マイク選択を閉じる"
          className="flex items-center gap-1 rounded px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-800">
          <X size={14} /><span>閉じる</span>
        </button>
      </div>
      <label className="block">使用するマイク
        <select aria-label="使用するマイク" value={selectedDevice} disabled={busy} className="mt-1 block w-full rounded border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 p-2"
          onChange={event => {
            const value = event.target.value
            microphoneSelection.select(value)
          }}>
          <option value="">システムの既定：{devices?.find(d => d.isDefault)?.name ?? '未接続'}</option>
          {deviceMissing && <option value={selectedDevice}>前回選んだマイク（未接続）</option>}
          {devices?.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
        </select>
      </label>
      {!configured && <button type="button" disabled={busy || !devices?.length || deviceMissing} className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-40"
        onClick={() => { microphoneSelection.select(selectedDevice); setShowDevices(false) }}>このマイクを使う</button>}
      <div className="flex justify-between gap-2"><span className="opacity-60">選択はこのPCに保存します。録音中は変更できません。</span><button type="button" onClick={() => void refreshDevices()} className="underline shrink-0">再取得</button></div>
    </div>}
    {deviceError && <p className="my-1 text-amber-700 dark:text-amber-400">{deviceError}</p>}
    {deviceMissing && <p className="my-1 text-amber-700 dark:text-amber-400">選択したマイクが未接続です。⌄からマイクを選び直してください。</p>}
    {devices?.length === 0 && caps?.available && <p className="my-1 text-amber-700 dark:text-amber-400">利用できるマイクが見つかりません。接続後に一覧を再取得してください。</p>}
    {phase === 'listening' && <div className="mb-2 space-y-1" aria-live="off">
      <div className="flex items-center gap-2">
        <span className="shrink-0">入力レベル</span>
        <div role="meter" aria-label="マイク入力レベル" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="flex gap-1 h-3 flex-1 max-w-56">
          {Array.from({ length: 16 }, (_, i) => <span key={i} className={`flex-1 rounded-sm transition-colors duration-100 ${level * 16 > i ? clipping ? 'bg-red-500' : i >= 13 ? 'bg-amber-400' : 'bg-emerald-500' : 'bg-gray-200 dark:bg-zinc-700'}`} />)}
        </div>
        <span className="shrink-0">{clipping ? '音が大きすぎます' : level > 0.08 ? '音を検出' : '静かです'}</span>
      </div>
      {seconds >= 5 && Date.now() - lastSample.current > 3000 && <p className="text-amber-600">マイクから音声データが届いていません。停止して別のマイクをお試しください。</p>}
      {seconds >= 5 && Date.now() - lastSample.current <= 3000 && Date.now() - lastAudible.current > 5000 && <p className="text-amber-600">音が小さいようです。マイクの選択・ミュート・入力音量をご確認ください。</p>}
    </div>}
    {error && <p className="my-1 text-amber-700 dark:text-amber-400">{error}</p>}
    {rawText && <div className="my-2 rounded border p-2">
      <p className="mb-2 whitespace-pre-wrap select-text max-h-40 overflow-auto">{rawText}</p>
      <button type="button" className="mr-3 underline" onClick={() => {
        const op = operation.current
        if (op && current.current.active && op.scope === current.current.scope && op.insert(rawText)) { setRawText(''); setError(''); operation.current = undefined }
        else setError('入力欄が変わっています。文章をコピーして貼り付けてください')
      }}>この文章を挿入</button>
      <button type="button" className="underline" onClick={() => void navigator.clipboard.writeText(rawText).catch(() => setError('コピーできませんでした。文章を選択してコピーしてください'))}>コピー</button>
      <button type="button" className="ml-3 underline" onClick={() => { cancel(); setError('') }}>閉じる</button>
    </div>}
  </div>
}

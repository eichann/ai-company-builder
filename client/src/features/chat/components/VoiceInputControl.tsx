import { voiceShortcut, formatVoiceShortcut } from '../../voice/voiceShortcut'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useCommandHandler } from '../../../shared/commands/commands'
import { useEventListener } from '../../../shared/hooks/useEventListener'
import { useInterval } from '../../../shared/hooks/useInterval'
import { useIpcEvent } from '../../../shared/hooks/useIpcEvent'
import { useVoiceShortcut } from '../hooks/useVoiceShortcut'
import { Microphone, Stop, X, CaretDown } from '@phosphor-icons/react'
import { microphoneSelection, deviceFailureMessage } from '../../voice/microphoneSelection'
import { voiceAvailability, recheckView } from '../../voice/voiceAvailability'
import { cancelRecording, onVoiceEvent, startRecording, stopRecording } from '../../voice/api'
import { PRIMARY_ACTION } from '../../../shared/ui/buttonStyles'

export interface VoiceEditor {
  focus?: () => void
  captureInsertion: () => (text: string) => boolean
}

/** Registers the voice key's command for this pane while its composer is shown. */
function VoiceInputCommand({ pane, onToggle }: { pane: string; onToggle: () => void }) {
  useCommandHandler('chat.toggleVoiceInput', () => onToggle(), { target: pane })
  return null
}

/**
 * Voice input: a microphone button (and the microphone choice beside it) in the composer's row, with
 * its explanation in the button's tooltip only (owner FB 2026-11-27: the 10 px hints on every
 * composer were noise). What needs the member's eyes — recording, the level, the microphone settings,
 * a problem, text that could not be inserted — opens above the input (`panelHost`).
 */
export function VoiceInputControl({ editor, active, pane, disabled, scope, onBusy, panelHost }: {
  editor: React.MutableRefObject<VoiceEditor | null>
  /** Its composer is the shown tab of its pane. */
  active: boolean
  /** The chat pane: the voice key reaches the pane used last (useVoiceShortcut). */
  pane: string
  disabled: boolean
  scope: string
  onBusy: (busy: boolean) => void
  /** Where the panel above the input is drawn (absent: right after the buttons). */
  panelHost?: HTMLElement | null
}) {
  const shortcut = useSyncExternalStore(voiceShortcut.subscribe, voiceShortcut.getSnapshot)
  const { devices, deviceError, deviceFailure, refreshing, selectedDevice, configured } = useSyncExternalStore(microphoneSelection.subscribe, microphoneSelection.getSnapshot)
  const { caps, checking } = useSyncExternalStore(voiceAvailability.subscribe, voiceAvailability.getSnapshot)
  const recheck = recheckView({ caps, checking, devices, deviceFailure, refreshing })
  const [showDevices, setShowDevices] = useState(false)
  const [recordingDevice, setRecordingDevice] = useState('')
  const [level, setLevel] = useState(0)
  const [clipping, setClipping] = useState(false)
  const lastSample = useRef(0)
  const lastAudible = useRef(0)
  const refreshDevices = microphoneSelection.refresh
  useEffect(() => { void voiceAvailability.load() }, [])
  useInterval(() => { void refreshDevices() }, active && showDevices ? 3000 : null)
  const deviceMissing = Boolean(selectedDevice && devices && !devices.some(d => d.id === selectedDevice))
  const deviceLabel = selectedDevice ? devices?.find(d => d.id === selectedDevice)?.name ?? '未接続のマイク' : `システムの既定：${devices?.find(d => d.isDefault)?.name ?? '未接続'}`
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
    if (previous) void cancelRecording(previous.id).catch(() => {})
    setPhase('idle')
    setLevel(0); setClipping(false)
    onBusy(false)
    setRawText('')
  }, [onBusy])

  useIpcEvent(onVoiceEvent, event => {
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
  })
  useEffect(() => { if (!active || disabled) cancel(); return cancel }, [active, scope, disabled, cancel])
  useInterval(() => { setSeconds(value => value + 1); if (Date.now() - lastSample.current > 500) { setLevel(0); setClipping(false) } }, phase === 'listening' ? 1000 : null)
  const startOrStop = useCallback(async () => {
    if (phaseRef.current === 'listening' && operation.current) {
      phaseRef.current = 'finalizing'
      setPhase('finalizing')
      await stopRecording(operation.current.id).catch(() => { cancel(); setError('録音を停止できませんでした') })
      return
    }
    if (phaseRef.current !== 'idle' || disabled || !active || !caps?.available || deviceMissing || !devices?.length || !editor.current) return
    const id = crypto.randomUUID()
    operation.current = { id, insert: editor.current.captureInsertion(), scope }
    phaseRef.current = 'preparing'
    setError(''); setRawText(''); setLevel(0); setClipping(false); setShowDevices(false); setPhase('preparing'); onBusy(true)
    try { await startRecording(id, selectedDevice || undefined) }
    catch { if (operation.current?.id === id) { cancel(); setError('音声入力を開始できませんでした。別の録音が動作していないかご確認ください') } }
  }, [active, caps, disabled, editor, scope, onBusy, cancel, selectedDevice, devices, deviceMissing])
  // The start / stop key goes through chat.toggleVoiceInput (the pane used last);
  // Esc and leaving the window cancel this composer's own recording.
  useVoiceShortcut()
  useEventListener<KeyboardEvent>(window, 'keydown', event => {
    if (event.isComposing || event.repeat || document.querySelector('[role="dialog"]')) return
    if (event.key === 'Escape' && operation.current) { event.preventDefault(); cancel() }
  }, { capture: true, enabled: active })
  useEventListener(window, 'blur', () => { if (phaseRef.current !== 'preparing') cancel() }, { enabled: active })
  // 「もう一度確認」: re-runs both the speech probe and the microphone list.
  // Rendered next to every message that asks the user to retry.
  const recheckButton = <button type="button" disabled={recheck.running} onClick={() => void voiceAvailability.recheck()}
    className="shrink-0 rounded-small border border-current px-2 py-0.5 font-medium disabled:opacity-50">{recheck.running ? '確認中…' : 'もう一度確認'}</button>
  const shortcutText = formatVoiceShortcut(shortcut)
  const buttonTitle = caps && !caps.available
    ? caps.reason ?? '音声入力は使えません'
    : phase === 'listening'
      ? `${recordingDevice}で録音中。もう一度押すか ${shortcutText} で停止して、文章を整えます`
      : `音声入力（${shortcutText}）：1回押すと開始・もう1回で停止。話した内容を AI で整えて入力します`
  const buttons = <span className="inline-flex shrink-0 items-center">
    {active && <VoiceInputCommand pane={pane} onToggle={() => void startOrStop()} />}
    <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void startOrStop()}
      disabled={phase !== 'listening' && (busy || disabled || !caps?.available || !devices?.length || deviceMissing)}
      title={buttonTitle}
      aria-label={phase === 'listening' ? '録音を停止して文章を整える' : '音声入力を開始'}
      className={`h-control-sm inline-flex items-center gap-1.5 rounded-control px-1.5 text-small disabled:opacity-disabled ${phase === 'listening' ? 'text-danger-text bg-danger-bg' : 'text-text-muted hover:bg-surface-sunken hover:text-text'}`}>
      {phase === 'listening' ? <Stop size={16} weight="fill" /> : <Microphone size={16} />}
      {phase === 'listening' ? `録音中 ${seconds}秒・停止` : phase === 'preparing' ? 'マイクを準備中…' : phase === 'finalizing' ? '音声を認識中…' : phase === 'polishing' ? '文章を整えています…' : null}
    </button>
    {busy && <button type="button" onClick={cancel} aria-label="音声入力をキャンセル" title="音声入力をキャンセル" className="h-control-sm px-1 rounded-control text-text-muted hover:bg-surface-sunken"><X size={14} /></button>}
    {caps?.available && !busy && <button type="button" aria-label="マイクを選択" aria-expanded={showDevices}
      title={`マイク：${deviceLabel}`}
      onClick={() => { setShowDevices(value => !value); void refreshDevices() }}
      className="h-control-sm px-0.5 rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text">
      <CaretDown size={12} className={`transition-transform ${showDevices ? 'rotate-180' : ''}`} />
    </button>}
  </span>
  const panel = <div className="px-1 text-small empty:hidden" aria-live="polite">
    {!caps && checking && <p className="my-1 text-text-muted">音声入力を確認中…</p>}
    {caps && !caps.available && recheck.show && <p className="my-1 flex flex-wrap items-center gap-2 text-text-muted"><span>{caps.reason}</span>{recheckButton}</p>}
    {showDevices && <div className="my-2 rounded-control border border-gray-200 dark:border-zinc-700 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{configured ? 'マイク設定' : 'はじめに、自分の使うマイクを選んでください'}</span>
        <button type="button" onClick={() => setShowDevices(false)} aria-label="マイク選択を閉じる"
          className="flex items-center gap-1 rounded-small px-2 py-1 hover:bg-gray-100 dark:hover:bg-zinc-800">
          <X size={14} /><span>閉じる</span>
        </button>
      </div>
      <label className="block">使用するマイク
        <select aria-label="使用するマイク" value={selectedDevice} disabled={busy} className="mt-1 block w-full rounded-small border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 p-2"
          onChange={event => {
            const value = event.target.value
            microphoneSelection.select(value)
          }}>
          <option value="">システムの既定：{devices?.find(d => d.isDefault)?.name ?? '未接続'}</option>
          {deviceMissing && <option value={selectedDevice}>前回選んだマイク（未接続）</option>}
          {devices?.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
        </select>
      </label>
      {!configured && <button type="button" disabled={busy || !devices?.length || deviceMissing} className={`rounded-small px-3 py-1.5 ${PRIMARY_ACTION}`}
        onClick={() => { microphoneSelection.select(selectedDevice); setShowDevices(false) }}>このマイクを使う</button>}
      <div className="flex justify-between gap-2"><span className="opacity-60">選択はこのPCに保存します。録音中は変更できません。</span><button type="button" onClick={() => void refreshDevices()} className="underline shrink-0">再取得</button></div>
    </div>}
    {deviceError && <p className="my-1 text-amber-700 dark:text-amber-400">{deviceError}</p>}
    {deviceMissing && caps?.available && <p className="my-1 text-amber-700 dark:text-amber-400">選択したマイクが未接続です。⌄からマイクを選び直してください。</p>}
    {caps?.available && !devices && !deviceFailure && <p className="my-1 opacity-60">マイク一覧を取得中…</p>}
    {recheck.deviceProblem && <p className="my-1 flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-400">
      <span>{recheck.deviceProblem === 'none-found' ? '利用できるマイクが見つかりません。マイクを接続してから「もう一度確認」を押してください' : deviceFailureMessage(recheck.deviceProblem)}</span>
      {recheckButton}
    </p>}
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
    {rawText && <div className="my-2 rounded-small border p-2">
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
  return <>
    {buttons}
    {panelHost ? createPortal(panel, panelHost) : panel}
  </>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Microphone, Stop, X } from '@phosphor-icons/react'
import type { VoiceCapabilities } from '../../../shared/voice-input'

export interface VoiceEditor {
  captureInsertion: () => (text: string) => boolean
}

export function VoiceInputControl({ editor, active, disabled, scope, onBusy }: {
  editor: React.MutableRefObject<VoiceEditor | null>
  active: boolean
  disabled: boolean
  scope: string
  onBusy: (busy: boolean) => void
}) {
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
    onBusy(false)
    setRawText('')
  }, [onBusy])

  useEffect(() => {
    void window.electronAPI.voiceInput.capabilities().then(setCaps).catch(() => setCaps({ available: false, reason: '音声入力を利用できません。アプリを再起動してください' }))
  }, [])
  useEffect(() => window.electronAPI.voiceInput.onEvent(event => {
    const op = operation.current
    if (!op || op.id !== event.requestId || !current.current.active || op.scope !== current.current.scope) return
    if (event.type === 'result') {
      if (!op.insert(event.text)) { setRawText(event.text); setError('入力欄が変わったため自動挿入しませんでした。下の文章をコピーできます') }
      else { operation.current = undefined; setRawText(''); setError('') }
      setPhase('idle'); onBusy(false)
    } else if (event.type === 'error') {
      setError(event.message); setRawText(event.rawText ?? ''); setPhase('idle'); onBusy(false)
      if (!event.rawText) operation.current = undefined
    } else {
      setPhase(event.type)
      if (event.type === 'listening') setSeconds(0)
    }
  }), [onBusy])
  useEffect(() => { if (!active || disabled) cancel(); return cancel }, [active, scope, disabled, cancel])
  useEffect(() => {
    if (phase !== 'listening') return
    const timer = setInterval(() => setSeconds(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [phase])
  const startOrStop = useCallback(async () => {
    if (phaseRef.current === 'listening' && operation.current) {
      setPhase('finalizing')
      await window.electronAPI.voiceInput.stop(operation.current.id).catch(() => { cancel(); setError('録音を停止できませんでした') })
      return
    }
    if (phaseRef.current !== 'idle' || disabled || !active || !caps?.available || !editor.current) return
    const id = crypto.randomUUID()
    operation.current = { id, insert: editor.current.captureInsertion(), scope }
    phaseRef.current = 'preparing'
    setError(''); setRawText(''); setPhase('preparing'); onBusy(true)
    try { await window.electronAPI.voiceInput.start(id) }
    catch { if (operation.current?.id === id) { cancel(); setError('音声入力を開始できませんでした。別の録音が動作していないかご確認ください') } }
  }, [active, caps, disabled, editor, scope, onBusy, cancel])
  useEffect(() => {
    if (!active) return
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyM') { event.preventDefault(); void startOrStop() }
      if (event.key === 'Escape' && operation.current) { event.preventDefault(); cancel() }
    }
    const blur = () => { if (phaseRef.current !== 'preparing') cancel() }
    window.addEventListener('keydown', keydown)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('blur', blur) }
  }, [active, startOrStop, cancel])
  return <div className="px-2 pt-2 text-xs" aria-live="polite">
    <div className="flex items-center gap-2">
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => void startOrStop()}
        disabled={phase !== 'listening' && (busy || disabled || !caps?.available)}
        title={caps?.reason ?? '音声入力（⌘⇧M / Ctrl+Shift+M）'}
        aria-label={phase === 'listening' ? '録音を停止して文章を整える' : '音声入力を開始'}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 disabled:opacity-40 ${phase === 'listening' ? 'text-red-600 bg-red-50 dark:bg-red-950' : 'hover:bg-gray-100 dark:hover:bg-zinc-800'}`}>
        {phase === 'listening' ? <Stop size={16} weight="fill" /> : <Microphone size={16} />}
        {phase === 'listening' ? `録音中 ${seconds}秒・停止` : phase === 'preparing' ? 'マイクを準備中…' : phase === 'finalizing' ? '音声を認識中…' : phase === 'polishing' ? '文章を整えています…' : '音声入力'}
      </button>
      {busy && <button type="button" onClick={cancel} aria-label="音声入力をキャンセル" className="p-1"><X size={16} /></button>}
      {!busy && caps?.available && !rawText && <span className="opacity-50">話した内容をClaudeで整えて入力します</span>}
      {caps && !caps.available && <span className="opacity-60">{caps.reason}</span>}
    </div>
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

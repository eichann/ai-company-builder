import { useState, useSyncExternalStore } from 'react'
import { defaultVoiceShortcut, formatVoiceShortcut, shortcutFromEvent, validShortcut, voiceShortcut } from '../../lib/voiceShortcut'

export function VoiceShortcutSettings() {
  const shortcut = useSyncExternalStore(voiceShortcut.subscribe, voiceShortcut.getSnapshot)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  return <div className="space-y-4 text-sm text-gray-700 dark:text-zinc-200">
    <h3 className="font-medium">音声入力のショートカット</h3>
    <p className="text-gray-500 dark:text-zinc-400">相談画面で1回押すと録音開始、もう1回押すと録音を終了して文章を整えます。</p>
    <button type="button" data-shortcut-recorder aria-label="音声入力ショートカットを変更"
      className="rounded-lg border border-zinc-600 px-4 py-3 focus:ring-2 focus:ring-amber-500"
      onClick={() => { setCapturing(true); setError('') }} onBlur={() => setCapturing(false)}
      onKeyDown={event => {
        if (!capturing) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Escape') { setCapturing(false); return }
        if (event.repeat || event.nativeEvent.isComposing || ['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return
        const next = shortcutFromEvent(event.nativeEvent)
        if (!validShortcut(next)) { setError('⌘またはCtrlと、英数字キーを組み合わせてください'); return }
        try { voiceShortcut.set(next); setCapturing(false); setError('') }
        catch { setError('保存できませんでした。もう一度お試しください') }
      }}>{capturing ? '希望のキーを押してください（Escで取消）' : `${formatVoiceShortcut(shortcut)} — クリックして変更`}</button>
    <div><button className="underline text-gray-500 dark:text-zinc-400" onClick={() => {
      try { voiceShortcut.set(defaultVoiceShortcut); setError(''); setCapturing(false) } catch { setError('保存できませんでした') }
    }}>初期設定に戻す</button></div>
    <p className="text-gray-500 dark:text-zinc-400">変更はこのPCに自動保存されます。ACBの相談画面でのみ有効です。</p>
    <p className="text-gray-500 dark:text-zinc-400">⌘MはMacの最小化、⌘Qは終了などと重なります。OSや他のアプリが使用する組み合わせは避けてください。</p>
    {error && <p role="alert" className="text-amber-400">{error}</p>}
  </div>
}

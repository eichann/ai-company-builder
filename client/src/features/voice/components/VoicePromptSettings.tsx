import { useEffect, useState } from 'react'
import { Check, LockSimple, SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, SubHeading } from '../../../shared/ui/primitives'
import { DEFAULT_VOICE_INSTRUCTIONS, VOICE_FIXED_PROMPT, VOICE_INSTRUCTIONS_MAX_LENGTH } from '../../../../shared/voice-prompt'
import { getVoicePrompt, resetVoicePrompt, setVoicePrompt } from '../api'

// Settings → 音声入力 → 整え方の指示. The fixed part is shown read-only; the
// member edits only the instructions after it. Saved on this PC (userData),
// read when the next voice input starts.

const ipcMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : ''
  // ipcRenderer.invoke prefixes "Error invoking remote method '…': Error: ".
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
}

export function VoicePromptSettings() {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getVoicePrompt()
      .then(settings => { if (!cancelled) { setSaved(settings.instructions); setDraft(settings.instructions) } })
      .catch(() => { if (!cancelled) { setSaved(DEFAULT_VOICE_INSTRUCTIONS); setDraft(DEFAULT_VOICE_INSTRUCTIONS); setError('保存済みの指示を読み込めませんでした。初期値を表示しています') } })
    return () => { cancelled = true }
  }, [])

  if (saved === null) {
    return <div className="flex items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400"><SpinnerGap size={14} className="animate-spin" />読み込み中…</div>
  }

  const tooLong = draft.length > VOICE_INSTRUCTIONS_MAX_LENGTH
  const dirty = draft !== saved
  const isDefaultDraft = draft === DEFAULT_VOICE_INSTRUCTIONS

  const run = async (action: () => Promise<{ instructions: string }>) => {
    setBusy(true); setError(''); setJustSaved(false)
    try {
      const next = await action()
      setSaved(next.instructions); setDraft(next.instructions)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    } catch (e) {
      setError(ipcMessage(e, '保存できませんでした。もう一度お試しください'))
    } finally {
      setBusy(false)
    }
  }
  const save = () => run(() => setVoicePrompt(draft))
  const reset = () => {
    if (!isDefaultDraft && !window.confirm('整え方の指示を初期値に戻しますか？\n編集した内容は消えます。')) return
    void run(() => resetVoicePrompt())
  }

  return (
    <div className="space-y-4">
      <div>
        <SubHeading>整え方の指示</SubHeading>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          話した内容をAIが文章に整えるときの指示です。口癖の消し方や箇条書きのルールを、自分の話し方に合わせて変えられます。
        </p>
      </div>

      <div data-voice-fixed className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.02]">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
          <LockSimple size={12} weight="bold" />この部分は変更できません
        </p>
        <p className="mt-1.5 select-text text-[13px] leading-relaxed text-zinc-400 dark:text-zinc-500">{VOICE_FIXED_PROMPT}</p>
      </div>

      <div>
        <textarea
          value={draft}
          onChange={e => { setDraft(e.target.value); setJustSaved(false); setError('') }}
          maxLength={VOICE_INSTRUCTIONS_MAX_LENGTH}
          aria-label="整え方の指示"
          aria-describedby="voice-prompt-count"
          spellCheck={false}
          placeholder="例: 「えー」「あの」などの口癖は消してください。"
          className="h-72 w-full resize-y rounded-lg border border-zinc-200 bg-white px-4 py-3 text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <div className="mt-1.5 flex items-center justify-between gap-4 text-xs">
          <span className="text-zinc-500 dark:text-zinc-400">{dirty ? '未保存の変更があります' : isDefaultDraft ? '初期値を使用中' : '編集した指示を使用中'}</span>
          <span id="voice-prompt-count" className={`tabular-nums ${tooLong ? 'text-red-600 dark:text-red-300' : 'text-zinc-400 dark:text-zinc-500'}`}>
            {draft.length.toLocaleString('ja-JP')} / {VOICE_INSTRUCTIONS_MAX_LENGTH.toLocaleString('ja-JP')}文字
          </span>
        </div>
      </div>

      {!draft.trim() && (
        <Callout tone="info">指示が空のときは、上の変更できない部分だけで整えます。口癖の削除や箇条書きの指示は使われません。</Callout>
      )}
      {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-300">{error}</p>}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">このPCにだけ保存され、チームとは同期されません。次の音声入力から反映されます。</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={reset} disabled={busy || (isDefaultDraft && !dirty)}>初期値に戻す</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty || tooLong}>
            {busy ? <><SpinnerGap size={14} className="animate-spin" />保存中…</> : justSaved ? <><Check size={14} />保存しました</> : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

import { useId, useState, useSyncExternalStore } from 'react'
import { SubHeading } from './ui'
import { promptSuggestionSetting } from '../../lib/promptSuggestionSetting'

// Settings → 入力候補: whether the chat offers the next instruction as ghost
// text after each reply (Claude Code makes it: one extra short request per
// reply, so off also saves usage).
export function PromptSuggestionSettings() {
  const enabled = useSyncExternalStore(promptSuggestionSetting.subscribe, promptSuggestionSetting.getSnapshot)
  const [error, setError] = useState('')
  const descriptionId = useId()
  const toggle = () => {
    try { promptSuggestionSetting.set(!enabled); setError('') } catch { setError('保存できませんでした。もう一度お試しください') }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <SubHeading>次の質問の候補を表示する</SubHeading>
          <p id={descriptionId} className="mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            AIの返答のあと、次に送りそうな指示を入力欄に薄く表示します。→キーまたはTabキーで入力欄に入れ、Escキーで消せます。
            候補はClaude Codeが返答ごとに作ります（会話の2回目の返答から。思いつかないときは出ません）。そのぶんClaudeの利用枠を少し使うので、不要ならオフにしてください。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="次の質問の候補を表示する"
          aria-describedby={descriptionId}
          onClick={toggle}
          className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900 ${enabled ? 'bg-indigo-600 dark:bg-indigo-500' : 'bg-zinc-300 dark:bg-white/20'}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
        </button>
      </div>
      <p className="text-[12px] text-zinc-500 dark:text-zinc-400">このPCに自動保存されます。Claude Code接続のときだけ表示されます（Codex・APIキー接続では出ません）。</p>
      {error && <p role="alert" className="text-[13px] text-amber-600 dark:text-amber-400">{error}</p>}
    </div>
  )
}

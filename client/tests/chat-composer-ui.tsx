/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import i18n from '../src/i18n'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { ChatInput } from '../src/features/chat/components/ChatComposer'
import type { SlashCommandItem } from '../src/features/chat/components/SlashCommandDropdown'
import { STEER_PART_TYPE } from '../shared/steer'

// Preview page for the composer: the next-prompt suggestion as ghost text in
// the input (→ / Tab accepts, Esc or other text dismisses), and an extra
// instruction sent while the AI worked, in the transcript. Synthetic data
// only; no Electron API is used. `?theme=dark` for dark mode,
// `?suggestion=<text>` to change the suggestion, `?disabled=1` to start with
// the input locked (「入力を有効にする」 unlocks it). Three skills answer `/`;
// what was sent and how many attachments wait are shown under the input.

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
void i18n.changeLanguage('ja')

const parts: UIMessage['parts'] = [
  { type: 'text', text: '営業部/提案書/ の資料を確認して、A社向けの提案書の骨子を作ります。' },
  { type: 'dynamic-tool', toolName: 'Read', toolCallId: 'read-1', state: 'output-available', input: { file_path: '営業部/提案書/2025_実績.md' }, output: '…' } as UIMessage['parts'][number],
  { type: STEER_PART_TYPE, id: 'steer-preview', data: { id: 'preview', text: '価格表は10月改定版を使ってください' } } as UIMessage['parts'][number],
  { type: 'dynamic-tool', toolName: 'Read', toolCallId: 'read-2', state: 'output-available', input: { file_path: '営業部/価格表/2026-10.xlsx' }, output: '…' } as UIMessage['parts'][number],
  { type: 'text', text: '承知しました。価格は10月改定版の価格表に合わせました。骨子は次のとおりです。\n\n1. 課題の整理\n2. 導入効果（昨年度実績から）\n3. 価格とスケジュール\n\nこのまま本文まで書き進めますか？' },
]

const slashCommands: SlashCommandItem[] = [
  { command: 'monthly-report', name: '月次レポート', description: '売上と経費をまとめる' },
  { command: 'proposal', name: '提案書', description: '提案書の骨子を作る' },
  { command: 'press-release', name: 'プレスリリース' },
]

function Preview() {
  const [suggestion, setSuggestion] = useState<string | null>(params.get('suggestion') ?? 'はい、本文まで書いてください')
  const [sent, setSent] = useState<string | null>(null)
  const [sentWith, setSentWith] = useState('')
  const [attachments, setAttachments] = useState(0)
  const [disabled, setDisabled] = useState(params.get('disabled') === '1')
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-900 text-gray-900 dark:text-zinc-100 flex flex-col">
      <p className="text-xs text-gray-500 dark:text-zinc-400 px-4 pt-3">表示確認用の人工データ。本番の相談には接続しません。</p>
      <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-4 space-y-6">
        <div className="flex justify-end"><div className="rounded-2xl rounded-br-md px-4 py-3 text-[14px] bg-accent text-white">A社向けの提案書の骨子を作ってください</div></div>
        <div className="max-w-[85%]"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></div>
        {sent && <div className="flex justify-end"><div className="rounded-2xl rounded-br-md px-4 py-3 text-[14px] bg-accent text-white">{sent}</div></div>}
      </div>
      <div className="max-w-3xl w-full mx-auto border-t border-gray-200 dark:border-zinc-800">
        <div className="p-4 pb-7">
          <ChatInput
            onSend={(text, images, paths) => {
              setSent(text)
              setSuggestion(null)
              setSentWith(`画像 ${images?.length ?? 0} 件、ファイル ${(paths ?? []).join(', ') || 'なし'}`)
            }}
            disabled={disabled}
            placeholder={i18n.t('chat.inputPlaceholder')}
            hint={suggestion ? i18n.t('chat.suggestionHint') : i18n.t('chat.inputHint')}
            suggestion={suggestion}
            onSuggestionCleared={() => setSuggestion(null)}
            slashCommands={slashCommands}
            onAttachmentsChange={setAttachments}
          />
          <p className="mt-6 text-xs text-gray-500 dark:text-zinc-400" data-testid="composer-state">
            添付 {attachments} 件{sentWith && `／送信：${sentWith}`}
          </p>
          {disabled && <button type="button" className="text-xs underline" onClick={() => setDisabled(false)}>入力を有効にする</button>}
        </div>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

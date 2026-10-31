/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { AgentInteractionCard } from '../src/features/chat/components/AgentInteractionCard'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../shared/agent-interaction'
import { CHOICE_PART_TYPE, parseChoiceQuestions, type ChoicePromptRecord } from '../shared/choice-prompt'

// Preview page for choice prompts (AskUserQuestion / ask_user): the pending
// card above the composer and the answered / closed states in the transcript.
// Synthetic data only; no Electron API is used. `?theme=dark` for dark mode,
// `?state=answered` to start with the card already answered.

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const questions = parseChoiceQuestions([
  { question: '提案書はどの形式で作成しますか？', header: '出力形式', multiSelect: false, options: [
    { label: 'PowerPoint', description: '営業がそのまま編集・投影できます' },
    { label: 'PDF', description: '配布用。レイアウトが崩れません' },
    { label: 'Markdown', description: '社内のフォルダで差分を追いやすい形式です' },
  ] },
  { question: '盛り込む資料を選んでください（複数可）', header: '参考資料', multiSelect: true, options: [
    { label: '昨年度の実績', description: '営業部/実績/2025.xlsx' },
    { label: '価格表', description: '最新版（10月改定）' },
    { label: '導入事例', description: '同業種の3社分' },
  ] },
])

const request: AgentInteractionRequest = { id: 'preview', appSessionId: 'preview', kind: 'choices', agent: 'claude-code', toolCallId: 'toolu_preview', questions }

function Preview() {
  const [record, setRecord] = useState<ChoicePromptRecord | undefined>(params.get('state') === 'answered'
    ? { id: 'toolu_preview', questions, answers: [{ selected: ['PowerPoint'] }, { selected: ['価格表', '導入事例'], other: '競合比較も' }] }
    : undefined)
  const parts: UIMessage['parts'] = [
    { type: 'text', text: '提案書を作る前に、2点だけ確認させてください。' },
    { type: 'dynamic-tool', toolName: 'AskUserQuestion', toolCallId: 'toolu_preview', state: record ? 'output-available' : 'input-available', input: { questions }, ...(record ? { output: 'The user answered: …' } : {}) } as UIMessage['parts'][number],
    ...(record ? [
      { type: CHOICE_PART_TYPE, id: 'choice-toolu_preview', data: record } as UIMessage['parts'][number],
      { type: 'text', text: 'ありがとうございます。選んでいただいた内容で作成します。' } as UIMessage['parts'][number],
    ] : []),
  ]
  const closed: UIMessage['parts'] = [
    { type: 'text', text: '保存先を確認させてください。' },
    { type: CHOICE_PART_TYPE, id: 'choice-old', data: { id: 'old', questions: questions.slice(0, 1), cancelled: 'timeout' } } as UIMessage['parts'][number],
  ]
  const respond = async (response: AgentInteractionResponse) => {
    if ('choices' in response) setRecord({ id: 'toolu_preview', questions, answers: response.choices })
    else setRecord({ id: 'toolu_preview', questions, cancelled: 'cancelled' })
    return true
  }
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-900 text-gray-900 dark:text-zinc-100 flex flex-col">
      <p className="text-xs text-gray-500 dark:text-zinc-400 px-4 pt-3">表示確認用の人工データ。本番の相談には接続しません。</p>
      <div className="flex-1 max-w-3xl w-full mx-auto px-4 py-4 space-y-6">
        <div className="max-w-[85%]"><AssistantMessageParts parts={closed} isStreaming={false} markdown /></div>
        <div className="flex justify-end"><div className="rounded-2xl rounded-br-md px-4 py-3 text-[14px] bg-accent text-white">来週の A社向け提案書を作ってください</div></div>
        <div className="max-w-[85%]"><AssistantMessageParts parts={parts} isStreaming={!record} markdown /></div>
      </div>
      <div className="max-w-3xl w-full mx-auto">
        {!record && <AgentInteractionCard request={request} onRespond={respond} />}
        <div className="border-t border-gray-200 dark:border-zinc-800 p-4 pb-7">
          <div className="rounded-xl border border-gray-200 dark:border-zinc-700 px-3 py-3 text-sm text-gray-400 dark:text-zinc-500">メッセージを入力…</div>
        </div>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

import { memo, useEffect, useId, useRef, useState } from 'react'
import { CheckCircle, ListChecks, XCircle } from '@phosphor-icons/react'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../../../shared/agent-interaction'
import { agentShortLabel } from '../../../shared/agents/registry'
import { MAX_OTHER_LENGTH, choiceAnswerText, choiceCancelLabel, type ChoicePromptRecord, type ChoiceQuestion } from '../../../shared/choice-prompt'
import { buildChoiceAnswers, choiceAnswerLines, emptyDraft, toggleOption, toggleOther, type ChoiceDraft } from './choicePromptState'

type ChoiceRequest = Extract<AgentInteractionRequest, { kind: 'choices' }>

function HeaderChip({ text, multiSelect }: { text: string; multiSelect: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      {text && <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-accent/10 text-accent dark:bg-accent/25 dark:text-sky-200 border border-accent/20">{text}</span>}
      {multiSelect && <span className="text-[11px] text-gray-500 dark:text-zinc-400">複数選択可</span>}
    </span>
  )
}

const optionClass = (checked: boolean) => `flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${checked
  ? 'border-accent/60 bg-accent/5 dark:bg-accent/15'
  : 'border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800/60'}`

function QuestionFields({ name, index, total, question, draft, disabled, onChange }: {
  name: string; index: number; total: number; question: ChoiceQuestion; draft: ChoiceDraft; disabled: boolean; onChange: (draft: ChoiceDraft) => void
}) {
  const type = question.multiSelect ? 'checkbox' : 'radio'
  const otherRef = useRef<HTMLInputElement>(null)
  return (
    <fieldset disabled={disabled} className="space-y-1.5">
      <legend className="mb-2 w-full">
        <span className="flex items-center gap-2 mb-1">
          {total > 1 && <span className="text-[11px] text-gray-400 dark:text-zinc-500">{index + 1}/{total}</span>}
          <HeaderChip text={question.header} multiSelect={question.multiSelect} />
        </span>
        <span className="block text-[14px] font-medium text-gray-900 dark:text-zinc-100 whitespace-pre-wrap">{question.question}</span>
      </legend>
      {question.options.map(option => {
        const checked = draft.selected.includes(option.label)
        return (
          <label key={option.label} className={optionClass(checked)}>
            <input type={type} name={name} checked={checked} onChange={() => onChange(toggleOption(question, draft, option.label))} className="mt-1 accent-[#1264a3]" />
            <span className="min-w-0">
              <span className="block text-sm text-gray-900 dark:text-zinc-100">{option.label}</span>
              {option.description && <span className="block text-xs text-gray-500 dark:text-zinc-400">{option.description}</span>}
            </span>
          </label>
        )
      })}
      <label className={optionClass(draft.otherOn)}>
        <input type={type} name={name} checked={draft.otherOn} onChange={() => { onChange(toggleOther(question, draft)); setTimeout(() => otherRef.current?.focus(), 0) }} className="mt-1 accent-[#1264a3]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-gray-900 dark:text-zinc-100">その他</span>
          {draft.otherOn && (
            <input ref={otherRef} type="text" aria-label={`${question.header || question.question}：その他の回答`} maxLength={MAX_OTHER_LENGTH} autoComplete="off"
              value={draft.otherText} placeholder="自由に入力してください" onChange={e => onChange({ ...draft, otherText: e.target.value })}
              className="mt-1.5 w-full rounded-md border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm text-gray-900 dark:text-zinc-100 outline-none focus:border-accent" />
          )}
        </span>
      </label>
    </fieldset>
  )
}

/** The pending choice prompt above the composer: the member picks and presses 「回答する」. */
export function ChoicePromptCard({ request, onRespond }: { request: ChoiceRequest; onRespond: (response: AgentInteractionResponse) => Promise<boolean> }) {
  const [drafts, setDrafts] = useState<ChoiceDraft[]>(() => request.questions.map(emptyDraft))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const name = useId()
  useEffect(() => { setDrafts(request.questions.map(emptyDraft)); setSending(false); setError('') }, [request.id, request.questions])
  const answers = buildChoiceAnswers(request.questions, drafts)
  const respond = async (response: AgentInteractionResponse) => {
    setSending(true); setError('')
    try { if (!await onRespond(response)) setError('この質問は終了しています。回答は送信されませんでした。') }
    catch { setError('回答を送信できませんでした。もう一度お試しください。') }
    finally { setSending(false) }
  }
  const agent = agentShortLabel(request.agent)
  return (
    <section aria-label={`${agent}からの質問`} className="flex-shrink-0 mx-4 mb-3 rounded-xl border border-accent/30 bg-white dark:bg-zinc-900 shadow-sm p-4 text-sm max-h-[55vh] overflow-y-auto animate-fade-in"
      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answers && !sending) { e.preventDefault(); void respond({ choices: answers }) } }}>
      <div className="flex items-center gap-2 mb-3 text-gray-700 dark:text-zinc-200">
        <ListChecks size={16} weight="bold" className="text-accent flex-shrink-0" />
        <span className="font-medium" aria-live="polite">{agent}からの質問 · 回答待ち</span>
      </div>
      <div className="space-y-4">
        {request.questions.map((q, i) => (
          <QuestionFields key={`${i}-${q.question}`} name={`${name}-${i}`} index={i} total={request.questions.length} question={q} draft={drafts[i] ?? emptyDraft()} disabled={sending}
            onChange={draft => setDrafts(list => list.map((d, j) => j === i ? draft : d))} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-gray-400 dark:text-zinc-500">別の相談に切り替えても、戻って回答できます。10分間回答がない場合は質問を終了します。</p>
      {error && <p role="alert" className="mt-3 text-red-500">{error}</p>}
      <div className="sticky -bottom-4 -mx-4 -mb-4 mt-4 px-4 pt-3 pb-4 flex items-center gap-3 bg-white dark:bg-zinc-900 border-t border-gray-100 dark:border-zinc-800">
        <button type="button" disabled={sending} onClick={() => void respond({ cancelled: true })}
          className="px-3 py-1.5 text-xs rounded-lg text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-50">回答せずに閉じる</button>
        <span className="ml-auto text-[11px] text-gray-400 dark:text-zinc-500 hidden sm:inline">⌘/Ctrl + Enter で回答</span>
        <button type="button" disabled={sending || !answers} onClick={() => answers && void respond({ choices: answers })}
          className="px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed">回答する</button>
      </div>
    </section>
  )
}

/** In the transcript (live and restored): the collapsed question and the member's answer as their message. */
export const ChoicePromptRecordView = memo(function ChoicePromptRecordView({ record }: { record: ChoicePromptRecord }) {
  const answered = !!record.answers
  return (
    <div className="my-2 animate-fade-in">
      <div className="rounded-xl border border-gray-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 text-gray-500 dark:text-zinc-400 mb-1">
          {answered ? <CheckCircle size={13} weight="fill" className="text-green-500" /> : <XCircle size={13} weight="fill" className="text-gray-400" />}
          <span>{answered ? '選択肢の質問 · 回答済み' : `選択肢の質問 · ${choiceCancelLabel(record.cancelled ?? 'cancelled')}`}</span>
        </div>
        <ul className="space-y-1">
          {record.questions.map((q, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <HeaderChip text={q.header} multiSelect={false} />
              <span className="text-gray-700 dark:text-zinc-300">{q.question}</span>
              {record.answers && <span className="text-gray-900 dark:text-zinc-100 font-medium">→ {choiceAnswerText(record.answers[i])}</span>}
            </li>
          ))}
        </ul>
      </div>
      {answered && (
        <div className="mt-2 flex justify-end">
          <div aria-label="あなたの回答" className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[14px] leading-relaxed bg-accent text-white whitespace-pre-wrap">
            {choiceAnswerLines(record).join('\n')}
          </div>
        </div>
      )}
    </div>
  )
}, (a, b) => JSON.stringify(a.record) === JSON.stringify(b.record))

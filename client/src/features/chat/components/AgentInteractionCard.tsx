import { useEffect, useState } from 'react'
import type { AgentInteractionRequest, AgentInteractionResponse } from '../../../../shared/agent-interaction'
import { ChoicePromptCard } from './ChoicePrompt'

export function AgentInteractionCard({ request, onRespond }: { request: AgentInteractionRequest; onRespond: (response: AgentInteractionResponse) => Promise<boolean> }) {
  if (request.kind === 'choices') return <ChoicePromptCard request={request} onRespond={onRespond} />
  return <CodexInteractionCard request={request} onRespond={onRespond} />
}

function CodexInteractionCard({ request, onRespond }: { request: Exclude<AgentInteractionRequest, { kind: 'choices' }>; onRespond: (response: AgentInteractionResponse) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setAnswers({}); setOther({}); setSending(false); setError('') }, [request.id])
  const respond = async (response: AgentInteractionResponse) => {
    setSending(true); setError('')
    try { if (!await onRespond(response)) setError('この確認は終了しています。回答は送信されませんでした。') }
    catch { setError('回答を送信できませんでした。もう一度お試しください。') }
    finally { setSending(false) }
  }
  return <section aria-label="Codexからの確認" className="mx-4 mb-3 rounded-xl border border-accent/30 bg-surface-elevated p-4 text-sm max-h-[50vh] overflow-y-auto">
    <div className="font-medium text-ink mb-3">{request.kind === 'questions' ? 'Codexからの質問 · 回答待ち' : 'Codexからの追加権限の確認 · 回答待ち'}</div>
    {request.kind === 'questions' ? <>
      {request.questions.map(q => <fieldset key={q.id} disabled={sending} className="mb-4 space-y-2">
        <legend className="text-ink mb-2">{q.question}</legend>
        {q.options?.map((option, index) => <label key={index} className="flex items-start gap-2 rounded-lg border border-white/10 p-2 cursor-pointer">
          <input type="radio" name={`${request.id}-${q.id}`} checked={!other[q.id] && answers[q.id] === option.label} onChange={() => { setOther(v => ({ ...v, [q.id]: false })); setAnswers(v => ({ ...v, [q.id]: option.label })) }} />
          <span><span className="text-ink">{option.label}</span><span className="block text-xs text-ink-muted">{option.description}</span></span>
        </label>)}
        {!!q.options?.length && q.isOther && <label className="flex gap-2 text-ink"><input type="radio" name={`${request.id}-${q.id}`} checked={!!other[q.id]} onChange={() => { setOther(v => ({ ...v, [q.id]: true })); setAnswers(v => ({ ...v, [q.id]: '' })) }} />自由に回答する</label>}
        {(!q.options?.length || other[q.id]) && <input aria-label={`${q.header}の回答`} type={q.isSecret ? 'password' : 'text'} autoComplete="off" maxLength={10000} value={answers[q.id] || ''} onChange={e => setAnswers(v => ({ ...v, [q.id]: e.target.value }))} className="w-full rounded-lg border border-white/10 bg-surface p-2 text-ink" />}
        {q.isSecret && <p className="text-xs text-ink-muted">入力はCodexに送信されます。ACBの相談履歴には保存しません。</p>}
      </fieldset>)}
      <div className="flex gap-3"><button disabled={sending} onClick={() => void respond({ cancelled: true })} className="text-ink-muted">回答せず停止</button><button disabled={sending || request.questions.some(q => !answers[q.id]?.trim())} onClick={() => void respond({ answers })} className="ml-auto rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40">回答を送信</button></div>
    </> : <>
      {request.reason && <p className="mb-2 text-ink">{request.reason}</p>}
      {request.cwd && <p className="text-xs text-ink-muted break-all mb-2">作業フォルダ: {request.cwd}</p>}
      <ul className="space-y-2 text-ink">{request.entries.map((entry, i) => <li key={i} className="break-all">{entry.access === 'write' ? '書き込み' : entry.access === 'read' ? '読み取り' : 'アクセス禁止'}: {entry.label}</li>)}</ul>
      {request.network && <p className="mt-2 text-ink">ネットワークへの接続（接続先を限定しない許可）</p>}
      <p className="my-3 text-xs text-ink-muted">許可は今回の応答が終わるまで有効です。以後の相談には引き継ぎません。</p>
      {!request.supported && <p className="my-2 text-red-500">この形式の権限要求はまだ確認できないため、許可できません。対象を具体的なフォルダで指定するよう依頼してください。</p>}
      <div className="flex gap-3"><button disabled={sending} onClick={() => void respond({ approved: false })} className="text-ink-muted">許可しない</button><button disabled={sending || !request.supported} onClick={() => void respond({ approved: true })} className="ml-auto rounded-lg bg-accent px-4 py-2 text-white disabled:opacity-40">今回だけ許可</button></div>
    </>}
    {error && <p role="alert" className="text-red-500 mt-2">{error}</p>}
    <p className="mt-3 text-xs text-ink-muted">別の相談に切り替えても、この相談に戻って回答できます。5分間未回答の場合は確認を終了します。</p>
  </section>
}

// Stage 4a ① (jobs.md "Event-triggered jobs"): the responsible person of an event job whose chain stopped chooses the next
// watched やること — one of their own open ones, found by name. The server checks the record again and makes the change.
import { useState } from 'react'
import { Button } from '../../../shared/ui/primitives'
import { getWatchChoices } from '../api'

export function RewatchPicker({ companyId, busy, onPick }: { companyId: string; busy: boolean; onPick: (recordId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [choices, setChoices] = useState<Array<{ id: string; title: string }> | null>(null)
  const [total, setTotal] = useState(0)
  const [chosen, setChosen] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const look = async (words: string) => {
    const r = await getWatchChoices(companyId, words)
    if (!r.success) { setProblem(r.error); return }
    setProblem(null)
    setChoices(r.choices)
    setTotal(r.total)
    setChosen(r.choices[0]?.id ?? '')
  }

  if (!open) {
    return <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(true); void look('') }}>見張るやることを選び直す</Button>
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2 text-small">
      <input aria-label="見張るやることを名前で探す" className="rounded-small border px-2 py-1" value={text} placeholder="名前で探す"
        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void look(text) }} />
      <Button size="sm" variant="ghost" onClick={() => void look(text)}>探す</Button>
      {choices && choices.length === 0 && <span className="text-zinc-500">あなたが担当の、まだ終わっていないやることがありません</span>}
      {choices && choices.length > 0 && (
        <>
          <select aria-label="見張るやること" className="rounded-small border px-2 py-1" value={chosen} onChange={e => setChosen(e.target.value)}>
            {choices.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          {total > choices.length && <span className="text-zinc-500">{total}件のうち{choices.length}件（名前で絞り込めます）</span>}
          <Button size="sm" variant="primary" disabled={busy || !chosen} onClick={() => onPick(chosen)}>これを見張る</Button>
        </>
      )}
      {problem && <span role="alert" className="text-red-600">{problem}</span>}
    </div>
  )
}

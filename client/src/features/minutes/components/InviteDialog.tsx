// ［招待する］ on a meeting (records.md "Members-only records"): the member chooses people and is told
// first what they will see — and that it cannot be taken back. The server checks the member is on
// the meeting's list and adds only members.
import { useState } from 'react'
import { UserPlus, X } from '@phosphor-icons/react'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { inviteToMeeting } from '../api'

export const INVITE_NOTE = '招待した人は会議の記録と要約・決めたこと・やることを見られます。Google の議事録そのものは、Google で共有されていないと読めません。一度招待すると、取り消すことはできません。'

interface Props {
  companyId: string
  meetingId: string
  version: number
  members: ReadonlyArray<{ id: string; name: string }>
  /** Closed: what to tell the member (null = nothing was done). */
  onDone: (said: string | null) => void
}

export function InviteDialog({ companyId, meetingId, version, members, onDone }: Props) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invite = async () => {
    setBusy(true)
    setError(null)
    const r = await inviteToMeeting(companyId, meetingId, [...chosen], version)
    setBusy(false)
    if (!r.success) { setError(r.error); return }
    const names = r.added.map(id => members.find(p => p.id === id)?.name ?? '').filter(Boolean)
    onDone(names.length > 0 ? `${names.map(n => `${n}さん`).join('、')}を招待しました。` : '選んだ人は、もうこの会議を見られます。')
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) onDone(null) }}>
      <div role="dialog" aria-label="会議に人を招待する" className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-800">
        <div className="mb-2 flex items-center">
          <h2 className="flex-1 text-[15px] font-semibold">会議に人を招待する</h2>
          <button type="button" aria-label="閉じる" onClick={() => onDone(null)} className="text-gray-400"><X size={14} /></button>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-gray-600 dark:text-zinc-300">{INVITE_NOTE}</p>
        <ul className="max-h-[240px] space-y-1 overflow-auto">
          {members.map(p => (
            <li key={p.id}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-gray-50 dark:hover:bg-zinc-700/50">
                <input type="checkbox" checked={chosen.has(p.id)} disabled={busy}
                  onChange={e => setChosen(s => { const next = new Set(s); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next })} />
                {p.name}さん
              </label>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(null)} className={SMALL_BUTTON}>やめる</button>
          <button type="button" disabled={busy || chosen.size === 0} onClick={() => void invite()} className={MAIN_BUTTON}><UserPlus size={13} />招待する</button>
        </div>
      </div>
    </div>
  )
}

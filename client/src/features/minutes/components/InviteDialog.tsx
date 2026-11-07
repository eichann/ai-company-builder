// ［招待する］ on a meeting (records.md "Members-only records"): the member chooses people — and, when the
// server says they may (the record's 責任者, a 部署の管理役, an owner / admin), groups and departments — and is
// told first what they will see, that it cannot be taken back, and that the list stays strict. The server
// checks the member is on the meeting's list, who may add a group or a department, and adds only members.
import { useState } from 'react'
import { UserPlus, X } from '@phosphor-icons/react'
import { MAIN_BUTTON, SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { INVITE_SETS_NOTE, type InviteSet } from '../../../../shared/minutes-app'
import { inviteToMeeting } from '../api'
import { useInviteChoices } from '../hooks/useInviteChoices'
import { invitedText, inviteSetLabel, offeredSets } from '../model'

export const INVITE_NOTE = '招待した人は会議の記録と要約・決めたこと・やることを見られます。Google の議事録そのものは、Google で共有されていないと読めません。一度招待すると、取り消すことはできません。'

interface Props {
  companyId: string
  meetingId: string
  version: number
  members: ReadonlyArray<{ id: string; name: string }>
  /** Closed: what to tell the member (null = nothing was done). */
  onDone: (said: string | null) => void
}

const setKey = (s: InviteSet) => `${s.type}:${s.id}`

export function InviteDialog({ companyId, meetingId, version, members, onDone }: Props) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [chosenSets, setChosenSets] = useState<ReadonlySet<string>>(new Set())
  const choices = useInviteChoices(companyId, meetingId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offered = offeredSets(choices)
  const toggle = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, key: string, on: boolean) =>
    set(s => { const next = new Set(s); if (on) next.add(key); else next.delete(key); return next })
  const invite = async () => {
    setBusy(true)
    setError(null)
    const sets = offered.filter(s => chosenSets.has(setKey(s))).map(s => ({ type: s.type, id: s.id }))
    const r = await inviteToMeeting(companyId, meetingId, [...chosen], version, sets)
    setBusy(false)
    if (!r.success) { setError(r.error); return }
    onDone(invitedText(r.added, r.addedSets, members, choices))
  }
  const listedText = (choices?.listed ?? []).filter(l => l.name !== '').map(l => inviteSetLabel(l, l.name)).join('、')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) onDone(null) }}>
      <div role="dialog" aria-label="会議に人を招待する" className="w-[420px] max-w-[calc(100vw-32px)] rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-800">
        <div className="mb-2 flex items-center">
          <h2 className="flex-1 text-[15px] font-semibold">会議に人を招待する</h2>
          <button type="button" aria-label="閉じる" onClick={() => onDone(null)} className="text-gray-400"><X size={14} /></button>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-gray-600 dark:text-zinc-300">{INVITE_NOTE}</p>
        {listedText !== '' && <p className="mb-2 text-[12px] text-gray-600 dark:text-zinc-300">いま見られる人には、{listedText}も入っています。</p>}
        <ul className="max-h-[240px] space-y-1 overflow-auto">
          {members.map(p => (
            <li key={p.id}>
              <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-gray-50 dark:hover:bg-zinc-700/50">
                <input type="checkbox" checked={chosen.has(p.id)} disabled={busy} onChange={e => toggle(setChosen, p.id, e.target.checked)} />
                {p.name}さん
              </label>
            </li>
          ))}
        </ul>
        {offered.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3 dark:border-zinc-700">
            <h3 className="mb-1 text-[13px] font-semibold">まとまりや部署で招待する</h3>
            <p className="mb-2 text-[12px] leading-relaxed text-gray-600 dark:text-zinc-300">{INVITE_SETS_NOTE}</p>
            <ul className="max-h-[180px] space-y-1 overflow-auto">
              {offered.map(s => (
                <li key={setKey(s)}>
                  <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-gray-50 dark:hover:bg-zinc-700/50">
                    <input type="checkbox" checked={chosenSets.has(setKey(s))} disabled={busy} onChange={e => toggle(setChosenSets, setKey(s), e.target.checked)} />
                    {s.label}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(null)} className={SMALL_BUTTON}>やめる</button>
          <button type="button" disabled={busy || chosen.size + chosenSets.size === 0} onClick={() => void invite()} className={MAIN_BUTTON}><UserPlus size={13} />招待する</button>
        </div>
      </div>
    </div>
  )
}

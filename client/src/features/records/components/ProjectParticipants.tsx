import { useState } from 'react'
import { LockSimple, Plus, X } from '@phosphor-icons/react'
import type { RecordCardView } from '../../../../shared/record-views'
import type { PrivateFolderMemberOption } from '../../../../shared/private-folder-ui'
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog'
import { SMALL_BUTTON } from '../../../shared/ui/RecordPage'
import { participantPorts } from '../api'
import { participantsAfter, removeWarning } from '../participants'

/**
 * 参加者 of a 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): 「見られる人：『…』の参加者（N人）」,
 * their names, and — for whoever the server gave the full list (owners / admins, the department's
 * managers) — ［参加者を足す］ and 外す, which change who reads its private folder.
 */
export function ProjectParticipants({ companyId, card, onChanged }: {
  companyId: string
  card: Required<Pick<RecordCardView, 'privateFolder' | 'participants'>> & Pick<RecordCardView, 'viewers' | 'record'>
  onChanged: () => void
}) {
  const { privateFolder, participants } = card
  const word = card.record.typeLabel || 'プロジェクト'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<PrivateFolderMemberOption[] | null>(null)
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null)
  const members = participants.members
  const named = members?.filter(m => m.via === 'rule') ?? []
  const save = async (change: { add: string } | { remove: string }) => {
    if (!members) return
    setBusy(true)
    setError(null)
    const r = await participantPorts().setMembers(companyId, privateFolder.scopeId, participantsAfter(members, change)).catch(() => null)
    setBusy(false)
    if (!r?.success) { setError(r?.error ?? 'できませんでした。'); return }
    setChoices(null)
    onChanged()
  }
  const openAdd = async () => {
    setError(null)
    const r = await participantPorts().companyMembers(companyId, privateFolder.path).catch(() => null)
    if (!r?.success) { setError(r?.error ?? '読み込めませんでした。'); return }
    const taken = new Set((members ?? []).map(m => m.userId))
    setChoices(r.context.members.filter(m => !taken.has(m.userId) && m.role !== 'owner' && m.role !== 'admin'))
  }
  return (
    <section aria-label="参加者" className="space-y-1.5 rounded-lg border border-gray-200 px-3 py-2 text-[12.5px] dark:border-zinc-700">
      <p className="flex items-center gap-1.5 text-gray-600 dark:text-zinc-300">
        <LockSimple size={12} />見られる人：{card.viewers?.text ?? `『${card.record.title}』の参加者`}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {(members ? named.map(m => ({ id: m.userId, name: m.name || m.email || 'メンバー' })) : participants.names.map((name, i) => ({ id: String(i), name }))).map(p => (
          <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 dark:bg-zinc-800">
            {p.name}
            {members && <button type="button" disabled={busy} aria-label={`${p.name}さんを外す`} onClick={() => setRemoving({ userId: p.id, name: p.name })}
              className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 disabled:opacity-50 dark:hover:bg-zinc-700"><X size={9} /></button>}
          </li>
        ))}
        {participants.admins > 0 && <li className="px-1 py-0.5 text-[11.5px] text-gray-500">ほかに管理者 {participants.admins}人</li>}
      </ul>
      {members && choices === null && (
        <button type="button" disabled={busy} onClick={() => void openAdd()} className={SMALL_BUTTON}><Plus size={10} className="mr-0.5 inline" />参加者を足す</button>
      )}
      {members && choices !== null && (
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-gray-500">足す人</span>
          <select aria-label="足す人" disabled={busy} defaultValue="" onChange={e => { if (e.target.value) void save({ add: e.target.value }) }}
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 dark:border-zinc-600 dark:bg-zinc-900">
            <option value="">選んでください</option>
            {choices.map(c => <option key={c.userId} value={c.userId}>{c.name || c.email || 'メンバー'}</option>)}
          </select>
          <button type="button" disabled={busy} onClick={() => setChoices(null)} className={SMALL_BUTTON}>やめる</button>
        </label>
      )}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      <ConfirmDialog isOpen={removing !== null} title="参加者から外す" message={removing ? removeWarning(removing.name, word) : ''}
        confirmText="外す" cancelText="やめる" danger confirmOnEnter={false}
        onConfirm={() => { const r = removing; setRemoving(null); if (r) void save({ remove: r.userId }) }} onCancel={() => setRemoving(null)} />
    </section>
  )
}

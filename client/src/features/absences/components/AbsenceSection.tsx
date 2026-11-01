// Settings → 「不在と代わりの人」: the member's own absences, each with one delegate,
// and whom the member covers today. The server decides everything; this only shows and asks.
import { useState } from 'react'
import { SpinnerGap } from '@phosphor-icons/react'
import { Button, Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import { absenceDayText, absenceRangeText } from '../../../../shared/absences'
import { useAbsences } from '../hooks/useAbsences'

const INPUT = 'h-9 rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:focus:border-indigo-400/60'

export function AbsenceSection({ companyId }: { companyId: string }) {
  const { loadRef, view, members, error, message, busy, add, remove } = useAbsences(companyId)
  const [from, setFrom] = useState('')
  const [until, setUntil] = useState('')
  const [delegateId, setDelegateId] = useState('')
  const candidates = view ? members.filter(m => m.userId !== view.userId) : []
  const canAdd = !!from && !!until && from <= until && !!delegateId && !busy

  const submit = async () => {
    if (await add({ from, until, delegateId })) { setFrom(''); setUntil(''); setDelegateId('') }
  }

  return (
    <div ref={loadRef} className="space-y-5 px-8 pb-8 pt-7">
      <SectionHeader
        title="不在と代わりの人"
        description="不在の間、あなたの番・承認・知らせが代わりの人にも出ます。代わりの人は自分の権限で動くので、見られないものは「権限が足りない」で止まります。"
      />
      {!view && !error ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500"><SpinnerGap size={16} className="animate-spin" />読み込み中…</div>
      ) : !view ? (
        <Callout tone="warning" role="alert">{error}</Callout>
      ) : (
        <>
          {view.covering.map(c => (
            <Callout key={c.userId} tone="info">
              いま代わりを受け持っている人：{c.name ?? 'メンバー'}さん（〜{absenceDayText(c.until)}）
            </Callout>
          ))}
          <Card className="space-y-3 p-5">
            <SubHeading>あなたの不在</SubHeading>
            {view.absences.length === 0 ? (
              <p className="text-[13px] text-zinc-600 dark:text-zinc-300">予定している不在はありません。</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                {view.absences.map(a => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                    <span className="font-medium">{absenceRangeText(a.from, a.until)}</span>
                    <span className="text-zinc-600 dark:text-zinc-300">代わりの人：{a.delegateName ?? 'メンバー'}さん</span>
                    {a.active && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">いま不在中</span>
                    )}
                    {view.canEdit && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void remove(a.id)}>削除</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {view.canEdit && (
            <Card className="space-y-3 p-5">
              <SubHeading>不在を追加</SubHeading>
              <div className="flex flex-wrap items-end gap-3 text-[13px]">
                <label className="flex flex-col gap-1">
                  <span className="text-zinc-500">始まりの日</span>
                  <input type="date" className={INPUT} value={from} min={view.today} onChange={e => setFrom(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-zinc-500">終わりの日</span>
                  <input type="date" className={INPUT} value={until} min={from || view.today} onChange={e => setUntil(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-zinc-500">代わりの人</span>
                  <select className={INPUT} value={delegateId} onChange={e => setDelegateId(e.target.value)}>
                    <option value="">選んでください</option>
                    {candidates.map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="primary" disabled={!canAdd} onClick={() => void submit()}>追加</Button>
              </div>
              {from && until && from > until && <p className="text-[12px] text-amber-700 dark:text-amber-300">終わりの日は始まりの日と同じか、それより後にしてください。</p>}
            </Card>
          )}
          {message && <p role="status" className="text-[12px] text-zinc-600 dark:text-zinc-300">{message}</p>}
        </>
      )}
    </div>
  )
}

import type { ReactNode } from 'react'
import { CircleNotch, Sparkle, TreeStructure } from '@phosphor-icons/react'
import type { BundleDetailView } from '../../../../shared/record-details'
import type { RecordCardView } from '../../../../shared/record-views'
import { CALM } from '../../../../shared/thing-words'
import { runCommand } from '../../../shared/commands/commands'
import { ThingIcon } from '../../../shared/ui/ThingIcon'

const shortDue = (due: string | null) => {
  const m = due?.match(/^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/)
  return m ? `${Number(m[1])}/${Number(m[2])}${m[3] ? ` ${m[3]}` : ''}` : null
}

/**
 * A 案件・プロジェクト (新しい画面のデモ E): what for, who is responsible and how far, its approval
 * requests as cards, and everyone's やること by whose turn (a row opens the task).
 */
export function BundleBody({ b, renderApproval }: { b: BundleDetailView; renderApproval?: (approvalId: string) => ReactNode }) {
  const tiles: Array<[string, string]> = [
    ['なんのため', b.purpose ?? '—'],
    ['責任者', b.owner ? `${b.owner}さん` : '—'],
    ['進み具合', b.total > 0 ? `${b.total}つのうち ${b.done}つ終わった` : 'まだやることはありません'],
  ]
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([k, v]) => (
          // `min-w-0` + `overflow-wrap: anywhere` (FB #36): a long URL in なんのため wraps inside its tile
          // instead of running into 進み具合 (tests/ui/record-card.spec.ts `&purpose=url`).
          <div key={k} className="min-w-0 rounded-lg bg-gray-50 px-3 py-2 dark:bg-zinc-800/60">
            <div className="text-[11px] text-gray-500">{k}</div>
            <div className="whitespace-pre-wrap text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]">{v}</div>
          </div>
        ))}
      </div>
      {renderApproval && b.pendingApprovals.map(id => <div key={id}>{renderApproval(id)}</div>)}
      <section aria-label="みんなのやること">
        <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-gray-700 dark:text-zinc-200"><TreeStructure size={14} className="text-accent" />みんなのやること</h2>
        {b.total > 0 && (
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-zinc-800" role="progressbar" aria-label="進み具合" aria-valuemin={0} aria-valuemax={b.total} aria-valuenow={b.done}>
            <div className="h-full bg-emerald-500" style={{ width: `${(b.done / b.total) * 100}%` }} />
          </div>
        )}
        {b.groups.length === 0
          ? <p className="text-[12px] text-gray-400">{CALM.emptyLinks}</p>
          : (
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-zinc-800 dark:border-zinc-700">
              {b.groups.map(g => (
                <section key={g.title} aria-label={g.title} className="px-3 py-2">
                  <h3 className="mb-1 text-[11px] font-semibold text-gray-500">{g.title}</h3>
                  {g.tasks.map(t => (
                    <button key={t.id} type="button" onClick={() => runCommand('record.open', { recordId: t.id })}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-gray-50 dark:hover:bg-zinc-800">
                      <ThingIcon kind="task" size={13} label="" />
                      <span className={`flex-1 truncate ${t.turn === null ? 'text-gray-400 line-through' : 'text-accent'}`}>{t.title}</span>
                      <span className="shrink-0 text-[11px] text-gray-500">{[t.turn, shortDue(t.due)].filter(Boolean).join('・')}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          )}
      </section>
    </>
  )
}

/**
 * 「AI が反映しています…（あと少し）」 while it works, 「AI が反映しました（11/2 09:56）」 after (plan I.4): one
 * line in fixed words — what it did is in 経緯 (［経緯で見る］), never the AI's own step names here.
 */
export function AiBand({ ai, onShowHistory }: { ai: NonNullable<RecordCardView['ai']>; onShowHistory?: () => void }) {
  if (ai.working) {
    return <p role="status" className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/[0.04] px-3 py-2 text-[12.5px]"><CircleNotch size={14} className="animate-spin text-accent" />{CALM.aiWorking}</p>
  }
  if (!ai.done) return null
  const at = new Date(ai.done.at)
  const time = Number.isNaN(at.getTime()) ? '' : `（${at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）`
  return (
    <p role="status" className="flex items-center gap-2 truncate rounded-lg bg-emerald-500/[0.07] px-3 py-2 text-[12.5px]">
      <Sparkle size={14} weight="fill" className="shrink-0 text-emerald-600" /><span className="min-w-0 flex-1 truncate">AI が反映しました{time}</span>
      {onShowHistory && <button type="button" onClick={onShowHistory} className="shrink-0 text-[11.5px] text-accent hover:underline">経緯で見る</button>}
    </p>
  )
}

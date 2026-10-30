'use client'

import { ChartBar } from '@phosphor-icons/react'

import { ListSkeleton } from '@/components/app/states'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { agentEventsApi, type SandboxImpact } from '@/lib/api'
import { SENSITIVE_LABELS } from '@/lib/agent-events'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

type Counts = Omit<SandboxImpact['byHost'][number], 'host'>

/**
 * 「囲うと止まる操作」: what the sandbox blocks (enforce) or would block
 * (observe) in the last 30 days, by host, by skill and by secret place —
 * the table the company tunes its host list with.
 */
export function ImpactCard() {
  const { companyId } = useCompany()
  const impact = useQuery(`agent-sandbox-impact:${companyId}`, () => agentEventsApi.sandboxImpact(companyId))
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ChartBar size={16} />
          囲うと止まる操作（直近30日）
        </CardTitle>
        <CardDescription>
          「記録だけ」のメンバーでは「囲うと止まる」、「囲う」のメンバーでは実際に止まった件数です。必要な宛先なら上の一覧に追加してください。秘密の置き場所の読み取りは、会社の Mac の管理設定で止められたものも含みます。
        </CardDescription>
      </CardHeader>
      <div className="space-y-5 border-t px-5 py-4">
        {impact.loading ? (
          <ListSkeleton rows={3} />
        ) : impact.error && !impact.data ? (
          <p className="text-sm text-destructive">{describeError(impact.error)}</p>
        ) : !impact.data || impact.data.total === 0 ? (
          <p className="text-sm text-muted-foreground">まだ記録はありません。</p>
        ) : (
          <>
            <ImpactTable title="宛先ごと" label="宛先" rows={impact.data.byHost.map((r) => ({ key: r.host, name: r.host, mono: true, counts: r }))} />
            <ImpactTable title="スキルごと" label="スキル" rows={impact.data.bySkill.map((r) => ({ key: r.skill ?? '-', name: r.skill ?? '（スキルの外）', mono: !!r.skill, counts: r }))} />
            <ImpactTable
              title="秘密の置き場所の読み取り"
              label="場所"
              rows={impact.data.byPlace.map((r) => ({ key: r.place ?? '-', name: r.place ? SENSITIVE_LABELS[r.place] ?? r.place : '会社が追加した場所など', mono: false, counts: r }))}
            />
            {impact.data.truncated && <p className="text-xs text-muted-foreground">件数が多いため、新しい {impact.data.total.toLocaleString('ja-JP')} 件だけを数えています。</p>}
          </>
        )}
      </div>
    </Card>
  )
}

function ImpactTable({ title, label, rows }: { title: string; label: string; rows: Array<{ key: string; name: string; mono: boolean; counts: Counts }> }) {
  if (rows.length === 0) return null
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-medium">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label={title}>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-normal">{label}</th>
              <th className="py-1 pr-3 text-right font-normal">囲うと止まる</th>
              <th className="py-1 pr-3 text-right font-normal">止まった</th>
              <th className="py-1 pr-3 text-right font-normal">読み取り禁止</th>
              <th className="py-1 pr-3 text-right font-normal">人数</th>
              <th className="py-1 font-normal">最後</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className={r.mono ? 'py-1.5 pr-3 font-mono text-xs break-all' : 'py-1.5 pr-3'}>{r.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.counts.wouldBlock}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.counts.blocked}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.counts.deniedReads}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.counts.members}</td>
                <td className="py-1.5 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(r.counts.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

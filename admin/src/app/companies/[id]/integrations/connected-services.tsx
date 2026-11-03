'use client'

// 「つないでいるサービス」 (stage 3 A1, `.claude/rules/connector-roles.md` "Built-in
// connectors"): the services built into ACB that every company may connect
// (Google Workspace first), whether each is on, stopped by the operator or not
// yet set up, what it does for ACB (予定を読む, メールを読む・送る, 会議の記録を読む), and —
// only when two services could do the same job — which one ACB uses. The on /
// off is the service's own switch (Google: the same as the 「Google」 card's).
// Words for non-engineers: no role, connector, OAuth or plugin on screen.
import { useState } from 'react'
import { toast } from 'sonner'
import { PlugsConnected } from '@phosphor-icons/react'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { coreConnectorsApi, type CoreConnectorStatus, type CoreConnectorView, type CoreConnectorsView, type CoreRoleView } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const STATUS_TEXT: Record<CoreConnectorStatus, string> = {
  'not-configured': 'まだつないでいません',
  off: 'オフ',
  'operator-stopped': '止まっています',
  on: '動いています',
}

export function ConnectedServicesSection({ companyId }: { companyId: string }) {
  const query = useQuery(`core-connectors:${companyId}`, () => coreConnectorsApi.get(companyId))
  const [view, setView] = useState<CoreConnectorsView | null>(null)
  const data = view ?? query.data

  return (
    <Card data-testid="connected-services">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlugsConnected size={16} />
          つないでいるサービス
        </CardTitle>
        <CardDescription>
          どの会社にもあるサービス（Google Workspace など）とつなぐと、ACB がメンバーの予定・メール・会議の記録を使えるようになります。
          何を読むか・送るかは、メンバーごとに本人が許可します。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.loading && !data ? (
          <ListSkeleton rows={1} />
        ) : query.error && !data ? (
          <ErrorState error={query.error} onRetry={query.reload} />
        ) : data ? (
          <ConnectedServicesBody companyId={companyId} view={data} onView={setView} />
        ) : null}
      </CardContent>
    </Card>
  )
}

function ConnectedServicesBody({ companyId, view, onView }: { companyId: string; view: CoreConnectorsView; onView: (v: CoreConnectorsView) => void }) {
  const [busy, setBusy] = useState(false)
  const labelOf = (id: string) => view.connectors.find((c) => c.id === id)?.label ?? id

  async function run(action: () => Promise<CoreConnectorsView>) {
    setBusy(true)
    try {
      onView(await action())
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ul className="divide-y rounded-md border">
        {view.connectors.map((c) => (
          <ConnectorRow key={c.id} connector={c} busy={busy}
            onToggle={() => run(() => coreConnectorsApi.setEnabled(companyId, c.id, !c.enabled))} />
        ))}
      </ul>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">ACB がしてもらうこと</h3>
        <ul className="divide-y rounded-md border">
          {view.roles.map((r) => (
            <RoleRow key={r.role} role={r} labelOf={labelOf} busy={busy}
              onChoose={(id) => run(() => coreConnectorsApi.chooseRole(companyId, r.role, id))} />
          ))}
        </ul>
      </section>
    </>
  )
}

function ConnectorRow({ connector: c, busy, onToggle }: { connector: CoreConnectorView; busy: boolean; onToggle: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm" data-testid={`connected-service-${c.id}`}>
      <div className="space-y-0.5">
        <div className="flex items-center gap-2 font-medium">
          {c.label}
          <Badge variant={c.status === 'on' ? 'default' : 'outline'}>{STATUS_TEXT[c.status]}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">{c.summary}</div>
        <div className="text-xs text-muted-foreground">
          できること: {[...c.roles.map((r) => r.label), ...c.capabilities.map((x) => x.label)].join('・')}
        </div>
        {c.operatorStopped && <div className="text-xs">運用担当者が止めています。止めている間は、誰も使えません。</div>}
        {c.status === 'not-configured' && <div className="text-xs text-muted-foreground">このページの下で設定すると使えるようになります。</div>}
      </div>
      {c.configured && (
        <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
          {c.enabled ? `${c.label} をオフにする` : `${c.label} をオンにする`}
        </Button>
      )}
    </li>
  )
}

function RoleRow({ role: r, labelOf, busy, onChoose }: { role: CoreRoleView; labelOf: (id: string) => string; busy: boolean; onChoose: (id: string | null) => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-testid={`connected-role-${r.role}`}>
      <span>{r.label}</span>
      {r.candidates.length > 1 ? (
        <select className="rounded-md border bg-background px-2 py-1 text-sm" aria-label={`${r.label}に使うサービス`} disabled={busy}
          value={r.choice ?? ''} onChange={(e) => onChoose(e.target.value === '' ? null : e.target.value)}>
          <option value="">どちらを使うか選んでください</option>
          {r.candidates.map((id) => <option key={id} value={id}>{labelOf(id)}</option>)}
        </select>
      ) : (
        <span className="text-muted-foreground">{r.servedBy ? labelOf(r.servedBy) : 'つないでいるサービスがありません'}</span>
      )}
    </li>
  )
}

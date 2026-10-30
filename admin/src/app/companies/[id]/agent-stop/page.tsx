'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ClockCounterClockwise, HandPalm, Key, LockSimple, Warning } from '@phosphor-icons/react'

import { useAgentStops } from '@/components/agent-stop/agent-stop-context'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { agentStopApi, keyBrokerApi, type AgentStopEntry, type AgentStopView } from '@/lib/api'
import { STOP_LIMITS, stopScopeLabel } from '@/lib/agent-stop'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'

const TITLE = 'AI の緊急停止'

export default function AgentStopPage() {
  const { isAdmin, role } = useCompany()
  const view = useAgentStops()

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }
  return (
    <>
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          事故や不審な動きがあったとき、メンバーのアプリの AI をすぐに止められます。止めるときは、どのページでも右上の
          <strong className="font-medium text-foreground">「AI を止める」</strong>を押します。
        </p>
        <p>{STOP_LIMITS}</p>
      </div>
      {!view || view.loading ? (
        <ListSkeleton rows={3} />
      ) : view.error && !view.data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : view.data ? (
        <div className="space-y-6 pb-4">
          <ActiveCard view={view.data} onChanged={(next) => view.setData(() => next)} />
          <UnsupportedCard view={view.data} />
          <KeysCard view={view.data} onChanged={view.reload} />
          <HistoryCard history={view.data.history} />
        </div>
      ) : null}
    </>
  )
}

function ActiveCard({ view, onChanged }: { view: AgentStopView; onChanged: (next: AgentStopView) => void }) {
  const { companyId } = useCompany()
  const [releasing, setReleasing] = useState<AgentStopEntry | null>(null)

  const release = async () => {
    if (!releasing) return
    try {
      const next = await agentStopApi.release(companyId, releasing.id)
      toast.success(`${stopScopeLabel(releasing)}の停止を解除しました`, { description: 'メンバーのアプリには数秒で届きます。' })
      onChanged(next)
    } catch (err) {
      toast.error('解除できませんでした', { description: describeError(err) })
      throw err
    }
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <HandPalm size={16} />
          いま止めているもの
        </CardTitle>
        <CardDescription>解除すると、その範囲の AI はすぐに使えるようになります。</CardDescription>
      </CardHeader>
      {view.active.length === 0 ? (
        <p className="border-t px-5 py-4 text-sm text-muted-foreground">止めているものはありません。</p>
      ) : (
        <ul aria-label="いま止めているもの" className="divide-y border-t">
          {view.active.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{stopScopeLabel(s)}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(s.stoppedAt)} に {s.stoppedByName ?? '管理者'} が停止{s.reason ? `・理由: ${s.reason}` : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setReleasing(s)}>
                解除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        title={releasing ? `${stopScopeLabel(releasing)}の停止を解除しますか？` : ''}
        description="解除すると、その範囲の AI はすぐに使えるようになります。"
        confirmLabel="解除する"
        destructive={false}
        onConfirm={release}
      />
    </Card>
  )
}

function UnsupportedCard({ view }: { view: AgentStopView }) {
  const [open, setOpen] = useState(false)
  const count = view.unsupported.length
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Warning size={16} />
          停止に対応していないアプリ: {count} 人
        </CardTitle>
        <CardDescription>
          {count === 0
            ? 'アプリを使っているメンバー全員に、停止が届きます。'
            : 'このメンバーのアプリは古い版のため、止めても届きません。アプリを最新の版に更新してもらってください。'}
        </CardDescription>
      </CardHeader>
      {count > 0 && (
        <div className="border-t px-5 py-3">
          <Button variant="ghost" size="sm" aria-expanded={open} aria-controls="stop-unsupported" onClick={() => setOpen(!open)}>
            {open ? '閉じる' : '一覧を表示'}
          </Button>
          {open && (
            <ul id="stop-unsupported" className="mt-2 space-y-1 text-sm">
              {view.unsupported.map((m) => (
                <li key={m.userId}>
                  {m.name || m.email || m.userId}
                  <span className="ml-2 text-xs text-muted-foreground">{m.clientVersion ?? '版は不明'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

function KeysCard({ view, onChanged }: { view: AgentStopView; onChanged: () => void }) {
  const { companyId } = useCompany()
  const [confirming, setConfirming] = useState(false)
  if (!view.keys.enabled) return null
  const stopAll = async () => {
    try {
      await keyBrokerApi.stopAll(companyId)
      toast.success('すべての API キーを止めました', { description: '再開は「API キー」のページで鍵ごとに行います。' })
      onChanged()
    } catch (err) {
      toast.error('API キーを止められませんでした', { description: describeError(err) })
      throw err
    }
  }
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Key size={16} />
          API キー
        </CardTitle>
        <CardDescription>
          AI やツールが会社の API キーで外部のサービスを使うのを止めます（AI を止めても、API キーは別に止める必要があります）。
          使える鍵 {view.keys.active} 件・止めている鍵 {view.keys.stopped} 件。
        </CardDescription>
      </CardHeader>
      <div className="flex flex-wrap gap-2 border-t px-5 py-3">
        <Button variant="destructive" size="sm" disabled={view.keys.active === 0} onClick={() => setConfirming(true)}>
          すべての鍵を止める
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/companies/${companyId}/api-keys`}>API キーのページへ</Link>
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="すべての鍵を今すぐ止めますか？"
        description="会社の鍵とメンバーの自分の鍵をすべて「停止中」にします。API の呼び出しは次の1回から止まります。再開は「API キー」のページで鍵ごとに行います。"
        confirmLabel="すべて止める"
        onConfirm={stopAll}
      />
    </Card>
  )
}

function HistoryCard({ history }: { history: AgentStopEntry[] }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ClockCounterClockwise size={16} />
          これまでの停止と解除
        </CardTitle>
      </CardHeader>
      {history.length === 0 ? (
        <p className="border-t px-5 py-4 text-sm text-muted-foreground">まだありません。</p>
      ) : (
        <ul aria-label="これまでの停止と解除" className="divide-y border-t text-sm">
          {history.map((s) => (
            <li key={s.id} className="px-5 py-3">
              <p className="font-medium">{stopScopeLabel(s)}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(s.stoppedAt)} {s.stoppedByName ?? '管理者'} が停止{s.reason ? `（理由: ${s.reason}）` : ''}
                {s.releasedAt ? ` → ${formatDateTime(s.releasedAt)} ${s.releasedByName ?? '管理者'} が解除` : ' → 停止中'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

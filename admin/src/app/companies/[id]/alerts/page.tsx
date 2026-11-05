'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Eye, LockSimple, ShieldCheck } from '@phosphor-icons/react'

import { RadioCard } from '@/components/app/radio-card'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { securityAlertsApi } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

import { SecurityAlertRow } from '@/components/security-alerts/alert-row'

const TITLE = '気になる動き'

/**
 * 「気になる動き」 (security-alerts.md): what the server noticed in the last 30 days — many wrong
 * passwords, a member downloading far more than usual, many refused changes, an AI reading far
 * more than usual, someone made owner / admin… — each with what to do, and whether owners and
 * admins also get them as a Slack DM (off at first). Owners and admins only.
 */
export default function SecurityAlertsPage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `security-alerts:${companyId}` : null, () => securityAlertsApi.get(companyId))
  const [busy, setBusy] = useState(false)

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const choose = async (slackDm: boolean) => {
    if (busy || !view.data || view.data.settings.slackDm === slackDm) return
    setBusy(true)
    try {
      const settings = await securityAlertsApi.setSlackDm(companyId, slackDm)
      view.setData((prev) => ({ items: prev?.items ?? [], settings }))
      toast.success(slackDm ? 'Slack でも知らせるようにしました' : 'Slack では知らせないようにしました')
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title={TITLE}
        description="パスワードの間違いが続いた、ふだんよりずっと多く受け取った、などをサーバーが見つけたときに出します。この30日の分です。"
      />
      {view.loading ? (
        <ListSkeleton rows={3} />
      ) : view.error && !view.data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : view.data ? (
        <div className="space-y-6 pb-4">
          {view.data.items.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="気になる動きはありません" />
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <ul aria-label={TITLE} className="divide-y">
                {view.data.items.map((a) => (
                  <SecurityAlertRow key={a.id} alert={a} />
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Eye size={16} />
                Slack でも知らせますか？
              </CardTitle>
              <CardDescription>
                オーナーと管理者のうち、Slack をつないでいる人に DM で届きます。選ぶとすぐに保存されます。
              </CardDescription>
            </CardHeader>
            <div role="radiogroup" aria-label="Slack でも知らせる" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
              <RadioCard
                checked={!view.data.settings.slackDm}
                onSelect={() => void choose(false)}
                label="管理画面だけ"
                help="ホームとこのページに出します（初めはこれ）。"
              />
              <RadioCard
                checked={view.data.settings.slackDm}
                onSelect={() => void choose(true)}
                label="Slack でも知らせる"
                help="見つけたときに DM を送ります。何件あっても、5分に1通までです。"
              />
            </div>
          </Card>
          {view.data.settings.updatedAt && (
            <p className="text-xs text-muted-foreground">最後に変えた日時: {formatDateTime(view.data.settings.updatedAt)}</p>
          )}
        </div>
      ) : null}
    </>
  )
}

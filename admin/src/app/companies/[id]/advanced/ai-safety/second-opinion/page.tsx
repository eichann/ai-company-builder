'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ChatsCircle, LockSimple } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { RadioCard } from '@/components/app/radio-card'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { secondOpinionApi } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

const TITLE = 'もう一方の AI に聞く'

/**
 * 「詳しい設定 › AI の安全 › もう一方の AI に聞く」 (owner decision 2026-11-02; chat-and-agents.md
 * "Asking the other AI"): whether a consultation may ask the other AI (Claude Code ↔ Codex).
 * Owners and admins; a choice is saved at once. The members' apps enforce it.
 */
export default function SecondOpinionPage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `second-opinion:${companyId}` : null, () => secondOpinionApi.get(companyId))
  const [busy, setBusy] = useState(false)

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety />
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const choose = async (allowed: boolean) => {
    if (busy || view.data?.allowed === allowed) return
    setBusy(true)
    try {
      const next = await secondOpinionApi.update(companyId, allowed)
      view.setData(() => next)
      toast.success(allowed ? 'もう一方の AI に聞けるようにしました' : 'もう一方の AI には聞かないようにしました')
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <AdvancedCrumb aiSafety />
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          メンバーが AI への相談の中で「Codex はどう言ってる？」のように名前を書いたときだけ、もう一方の AI（Claude Code と Codex）に読むだけで聞きます。
          <strong className="font-medium text-foreground">会社の中身がもう一方の会社にも渡ります。</strong>
        </p>
        <p>どちらか一方の AI の会社とだけ契約しているときは、「聞かない」のままにしてください。</p>
      </div>
      {view.loading ? (
        <ListSkeleton rows={2} />
      ) : view.error && !view.data ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : view.data ? (
        <div className="space-y-4 pb-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <ChatsCircle size={16} />
                相談の中で、もう一方の AI に聞いてよいですか？
              </CardTitle>
              <CardDescription>選ぶとすぐに保存され、メンバーのアプリには次の相談から効きます。</CardDescription>
            </CardHeader>
            <div role="radiogroup" aria-label={TITLE} className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
              <RadioCard
                checked={!view.data.allowed}
                onSelect={() => void choose(false)}
                label="聞かない"
                help="相談の中身は、メンバーが使っている AI の会社にだけ渡ります（初めはこれ）。"
              />
              <RadioCard
                checked={view.data.allowed}
                onSelect={() => void choose(true)}
                label="聞いてよい"
                help="名前を書いたときだけ、もう一方の AI に読むだけで聞きます。会社の中身がもう一方の会社にも渡ります。"
              />
            </div>
          </Card>
          {view.data.updatedAt && (
            <p className="text-xs text-muted-foreground">
              最後に変えた日時: {formatDateTime(view.data.updatedAt)}（{view.data.updatedByName ?? '管理者'}）
            </p>
          )}
        </div>
      ) : null}
    </>
  )
}

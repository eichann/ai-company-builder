'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { LockSimple, SignOut } from '@phosphor-icons/react'

import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { EmptyState, PageHeader } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { companiesApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDate, roleLabel } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

export default function SettingsPage() {
  const router = useRouter()
  const { user } = useAuth()
  const { companyId, company, role, isAdmin } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [leaving, setLeaving] = useState(false)

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title="会社の設定" />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const c = company.data
  const owner = members.data?.find((m) => m.role === 'owner')

  const leave = async () => {
    if (!user) return
    try {
      await companiesApi.removeMember(companyId, user.id)
      toast.success(`${c?.name ?? '会社'} から退出しました`)
      router.replace('/dashboard')
    } catch (err) {
      toast.error('退出できませんでした', { description: describeError(err) })
      throw err
    }
  }

  return (
    <>
      <PageHeader title="会社の設定" />
      <div className="space-y-6">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle>会社の情報</CardTitle>
          </CardHeader>
          <dl className="divide-y border-t text-sm">
            <Field label="会社名" value={c?.name} />
            <Field label="オーナー" value={members.data ? (owner ? owner.name || owner.email : '—') : undefined} />
            <Field label="あなたの役割" value={role ? roleLabel(role) : undefined} />
            <Field label="作成日" value={c ? formatDate(c.createdAt) : undefined} />
          </dl>
        </Card>

        {role === 'admin' && (
          <Card className="border-destructive/30">
            <CardHeader className="pb-5">
              <CardTitle className="text-destructive">危険な操作</CardTitle>
              <CardDescription>取り消せない操作です。</CardDescription>
            </CardHeader>
            <div className="flex flex-col gap-3 border-t border-destructive/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <div className="font-medium">この会社から退出</div>
                <p className="text-muted-foreground">
                  管理画面とデスクトップアプリから、この会社にアクセスできなくなります。戻るには新しい招待が必要です。
                </p>
              </div>
              <Button variant="destructive" onClick={() => setLeaving(true)} className="shrink-0">
                <SignOut />
                退出する
              </Button>
            </div>
          </Card>
        )}
      </div>

      <ConfirmByTypingDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="この会社から退出"
        description="退出すると、この会社のファイルやAIスキルを同期できなくなります。PCにあるファイルは削除されません。"
        confirmText={c?.name ?? ''}
        confirmLabel="退出する"
        onConfirm={leave}
      />
    </>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode | undefined }) {
  return (
    <div className="grid gap-1 px-5 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value === undefined ? <Skeleton className="h-4 w-40" /> : value}</dd>
    </div>
  )
}

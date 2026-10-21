'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Buildings, Plus, SignOut } from '@phosphor-icons/react'

import { RequireAuth } from '@/components/app/auth-guard'
import { AuthLayout } from '@/components/app/brand'
import { EmptyState, ErrorState, FullPageLoading } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { companiesApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { LAST_COMPANY_KEY } from '@/lib/company-context'
import { useQuery } from '@/lib/use-query'

// Entry point after sign-in: opens the company used last (or the first one),
// or offers to create one.
export default function DashboardPage() {
  return (
    <RequireAuth>
      <CompanyRedirect />
    </RequireAuth>
  )
}

function CompanyRedirect() {
  const router = useRouter()
  const { signOut } = useAuth()
  const companies = useQuery('companies', () => companiesApi.list())

  useEffect(() => {
    const list = companies.data
    if (!list || list.length === 0) return
    let last: string | null = null
    try {
      last = localStorage.getItem(LAST_COMPANY_KEY)
    } catch {
      // Storage unavailable: fall back to the first company.
    }
    const target = list.find((c) => c.id === last) ?? list[0]
    router.replace(`/companies/${target.id}`)
  }, [companies.data, router])

  if (companies.error) {
    return (
      <AuthLayout>
        <ErrorState error={companies.error} onRetry={companies.reload} className="bg-card" />
      </AuthLayout>
    )
  }

  if (!companies.data || companies.data.length > 0) return <FullPageLoading />

  return (
    <AuthLayout
      footer={
        <button
          type="button"
          className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          onClick={async () => {
            await signOut()
            router.replace('/login')
          }}
        >
          <SignOut size={12} />
          ログアウト
        </button>
      }
    >
      <EmptyState
        icon={Buildings}
        title="まだ会社がありません"
        description="会社を作成すると、メンバーを招待して部署ごとにファイルやAIスキルを共有できます。招待を受けた場合は、届いた招待リンクを開いてください。"
        action={
          <Button asChild>
            <Link href="/companies/new">
              <Plus />
              会社を作成
            </Link>
          </Button>
        }
        className="bg-card"
      />
    </AuthLayout>
  )
}

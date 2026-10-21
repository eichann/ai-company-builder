'use client'

import { use, type ReactNode } from 'react'
import Link from 'next/link'
import { Buildings } from '@phosphor-icons/react'

import { AppShell } from '@/components/app/app-shell'
import { RequireAuth } from '@/components/app/auth-guard'
import { AuthLayout } from '@/components/app/brand'
import { EmptyState, ErrorState } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'
import { CompanyProvider, useCompany } from '@/lib/company-context'

export default function CompanyLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  return (
    <RequireAuth>
      <CompanyProvider companyId={id}>
        <CompanyGate>{children}</CompanyGate>
      </CompanyProvider>
    </RequireAuth>
  )
}

function CompanyGate({ children }: { children: ReactNode }) {
  const { company } = useCompany()

  // The API answers 404 both for a missing company and for one the user does
  // not belong to.
  if (company.error instanceof ApiError && company.error.status === 404) {
    return (
      <AuthLayout>
        <EmptyState
          icon={Buildings}
          title="この会社は見つかりません"
          description="削除されたか、このアカウントがメンバーではない可能性があります。"
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard">会社の一覧へ</Link>
            </Button>
          }
          className="bg-card"
        />
      </AuthLayout>
    )
  }

  if (company.error && !company.data) {
    return (
      <AuthLayout>
        <ErrorState error={company.error} onRetry={company.reload} className="bg-card" />
      </AuthLayout>
    )
  }

  return <AppShell>{children}</AppShell>
}

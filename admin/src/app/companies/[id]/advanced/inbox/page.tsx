'use client'

import { LockSimple } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { useCompanyFeatures, WhenFeatureOn } from '@/components/advanced/feature-off'
import { IntakeSettingsSection } from '@/components/advanced/intake-settings'
import { EmptyState, PageHeader } from '@/components/app/states'
import { departmentsApi } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { useQuery } from '@/lib/use-query'

const TITLE = '来た連絡の決まり'

/** 「詳しい設定 › 来た連絡の決まり」 (was part of 「やることの一覧」; inbox.md). */
export default function InboxRulesPage() {
  const { companyId, isAdmin, role } = useCompany()
  const features = useCompanyFeatures()
  const departments = useQuery(isAdmin ? `departments:${companyId}` : null, () => departmentsApi.list(companyId))
  return (
    <>
      <AdvancedCrumb />
      <PageHeader title={TITLE} />
      {role !== null && !isAdmin ? (
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      ) : (
        <>
          <p className="-mt-2 mb-6 max-w-3xl text-sm text-muted-foreground">
            届いたメールや Slack の連絡を、だれのやることにするかの決まりです。ふだんは初期値のままで困りません。
          </p>
          {isAdmin && (
            <WhenFeatureOn feature="inbox" features={features} title={TITLE}>
              <IntakeSettingsSection departments={departments.data ?? []} />
            </WhenFeatureOn>
          )}
        </>
      )}
    </>
  )
}

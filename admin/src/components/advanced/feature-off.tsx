'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { featuresApi, type FeatureId } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { useQuery } from '@/lib/use-query'
import { FEATURE_OFF_SETTINGS_LINE, featuresFrom, type CompanyFeatures } from '../../../../shared/core/features'

/**
 * The company's 「使う機能」 for the settings pages (records.md "Features on and off"). While unknown
 * (loading, an older server without the route, an error) every feature reads as on, so a setting is
 * never hidden by mistake.
 */
export function useCompanyFeatures(): CompanyFeatures {
  const { companyId } = useCompany()
  const query = useQuery(`features:${companyId}`, () => featuresApi.get(companyId))
  return featuresFrom(query.data?.features)
}

/**
 * A settings card of a feature that is off: its title and one plain line instead of the questions
 * (owner decision 2026-11-08: one way on every page). Its stored answers are left as they are.
 */
export function FeatureOffCard({ title, icon }: { title: string; icon?: ReactNode }) {
  return (
    <Card data-testid="feature-off-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>
          <FeatureOffLine />
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

/** The one line itself, with 「使う機能」 as a link to the switches. */
export function FeatureOffLine() {
  const { companyId } = useCompany()
  const [before, after] = FEATURE_OFF_SETTINGS_LINE.split('使う機能')
  return (
    <span>
      {before}
      <Link href={`/companies/${companyId}/advanced/features`} className="underline underline-offset-4">
        使う機能
      </Link>
      {after}
    </span>
  )
}

/** `children` while `feature` is on, else its card with the one line. */
export function WhenFeatureOn({ feature, features, title, icon, children }: {
  feature: FeatureId
  features: CompanyFeatures
  title: string
  icon?: ReactNode
  children: ReactNode
}) {
  return features[feature] ? <>{children}</> : <FeatureOffCard title={title} icon={icon} />
}

'use client'

import { LockSimple } from '@phosphor-icons/react'

import { MeetingDuplicatesSection } from '@/components/advanced/meeting-duplicates'
import { EmptyState, PageHeader } from '@/components/app/states'
import { useCompany } from '@/lib/company-context'

const TITLE = '同じ会議から重複して作られたもの'

/** Not a setting but work (管理画面の見直し 2-4): opened from the home's 「対応が必要なこと」. */
export default function MeetingDuplicatesPage() {
  const { isAdmin, role } = useCompany()
  return (
    <>
      <PageHeader title={TITLE} />
      {role !== null && !isAdmin ? (
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      ) : (
        isAdmin && <MeetingDuplicatesSection />
      )}
    </>
  )
}

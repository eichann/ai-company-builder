'use client'

import { useSearchParams } from 'next/navigation'
import { FolderSimple } from '@phosphor-icons/react'

import { EmptyState, ListSkeleton, PageHeader } from '@/components/app/states'
import { FOLDERS_TITLE } from '@/components/folders/folder-tabs'

import { PermissionsView } from '@/components/folders/permissions-view'
import { PrivateFoldersView } from '@/components/folders/private-folders-view'
import { useCompany } from '@/lib/company-context'
import { NO_COMPANY_FOLDER_NOTE } from '@/lib/company-folder'

/**
 * 「フォルダ」: who may change each place (the former 「権限」) and the folders whose viewers are
 * chosen (the former 「非公開フォルダ」), one menu item with two tabs (?tab=private).
 * /permissions and /private-folders lead here.
 */
export default function FoldersPage() {
  const tab = useSearchParams().get('tab')
  // A company without the shared folder (reached by URL: the menu leaves it out) has nothing here.
  const { company, hasCompanyFolder } = useCompany()
  // Until the company is known, neither view: the folder views would ask about folders first.
  if (!company.data) return <ListSkeleton rows={5} />
  if (!hasCompanyFolder) {
    return (
      <>
        <PageHeader title={FOLDERS_TITLE} />
        <EmptyState icon={FolderSimple} title={NO_COMPANY_FOLDER_NOTE.title} description={NO_COMPANY_FOLDER_NOTE.description} />
      </>
    )
  }
  return tab === 'private' ? <PrivateFoldersView /> : <PermissionsView />
}

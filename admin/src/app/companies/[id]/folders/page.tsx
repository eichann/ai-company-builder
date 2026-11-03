'use client'

import { useSearchParams } from 'next/navigation'

import { PermissionsView } from '@/components/folders/permissions-view'
import { PrivateFoldersView } from '@/components/folders/private-folders-view'

/**
 * 「フォルダ」: who may change each place (the former 「権限」) and the folders whose viewers are
 * chosen (the former 「非公開フォルダ」), one menu item with two tabs (?tab=private).
 * /permissions and /private-folders lead here.
 */
export default function FoldersPage() {
  const tab = useSearchParams().get('tab')
  return tab === 'private' ? <PrivateFoldersView /> : <PermissionsView />
}

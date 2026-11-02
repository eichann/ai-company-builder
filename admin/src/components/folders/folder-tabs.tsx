'use client'

import Link from 'next/link'
import { LockSimple, PencilSimple } from '@phosphor-icons/react'

import { useCompany } from '@/lib/company-context'
import { cn } from '@/lib/utils'

// 「フォルダ」 (管理画面の見直し 2-3): what were the pages 「権限」 and 「非公開フォルダ」, one menu item —
// both say, place by place, who may see and who may change. Words: 「非公開」 is not said in the
// heading (言葉の決まり 5d); a folder whose viewers are chosen has the lock mark.
export const FOLDERS_TITLE = 'フォルダ'
export const FOLDERS_DESCRIPTION = '場所ごとに、だれが見られて、だれが変えられるかを決めます。'

export type FolderTab = 'edit' | 'private'

export const FOLDER_TABS: Array<{ id: FolderTab; label: string }> = [
  { id: 'edit', label: 'だれが変えられるか' },
  { id: 'private', label: '見られる人を決めたフォルダ' },
]

export function folderTabHref(companyId: string, tab: FolderTab): string {
  return tab === 'edit' ? `/companies/${companyId}/folders` : `/companies/${companyId}/folders?tab=${tab}`
}

export function FolderTabs({ current }: { current: FolderTab }) {
  const { companyId } = useCompany()
  return (
    <nav aria-label="フォルダの見方" className="-mt-2 mb-5 flex gap-1 border-b">
      {FOLDER_TABS.map((t) => {
        const Icon = t.id === 'edit' ? PencilSimple : LockSimple
        const active = t.id === current
        return (
          <Link
            key={t.id}
            href={folderTabHref(companyId, t.id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon size={15} weight={active ? 'fill' : 'regular'} />
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

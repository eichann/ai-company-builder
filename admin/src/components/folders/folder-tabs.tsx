'use client'

import Link from 'next/link'
import { Archive, LockSimple, PencilSimple } from '@phosphor-icons/react'

import { holdingApi } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { HOLDING_TAB_LABEL } from '@/lib/holding'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

// 「フォルダ」 (管理画面の見直し 2-3): what were the pages 「権限」 and 「非公開フォルダ」, one menu item —
// both say, place by place, who may see and who may change. Words: 「非公開」 is not said in the
// heading (言葉の決まり 5d); a folder whose viewers are chosen has the lock mark.
export const FOLDERS_TITLE = 'フォルダ'
export const FOLDERS_DESCRIPTION = '場所ごとに、だれが見られて、だれが変えられるかを決めます。'

export type FolderTab = 'edit' | 'private' | 'holding'

export const FOLDER_TABS: Array<{ id: FolderTab; label: string }> = [
  { id: 'edit', label: 'だれが変えられるか' },
  { id: 'private', label: '見られる人を決めたフォルダ' },
  { id: 'holding', label: HOLDING_TAB_LABEL },
]

const TAB_ICONS = { edit: PencilSimple, private: LockSimple, holding: Archive } as const

export function folderTabHref(companyId: string, tab: FolderTab): string {
  return tab === 'edit' ? `/companies/${companyId}/folders` : `/companies/${companyId}/folders?tab=${tab}`
}

/**
 * 「預かり」 is shown when the caller has something to review (the list the server answers them: an
 * item they may not review is never in it), and while it is open. An older server without it, or a
 * refusal, hides it.
 */
export function FolderTabs({ current }: { current: FolderTab }) {
  const { companyId, isAdmin, managedDepartmentIds } = useCompany()
  const mayReview = isAdmin || managedDepartmentIds.length > 0
  const holding = useQuery(mayReview ? `holding-tab:${companyId}` : null, () => holdingApi.list(companyId))
  const waiting = holding.data?.items.length ?? 0
  const tabs = FOLDER_TABS.filter((t) => t.id !== 'holding' || current === 'holding' || waiting > 0)
  return (
    <nav aria-label="フォルダの見方" className="-mt-2 mb-5 flex gap-1 border-b">
      {tabs.map((t) => {
        const Icon = TAB_ICONS[t.id]
        const active = t.id === current
        return (
          <Link
            key={t.id}
            href={folderTabHref(companyId, t.id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon size={15} weight={active ? 'fill' : 'regular'} />
            {t.label}
            {t.id === 'holding' && waiting > 0 && (
              <span className="rounded-full bg-primary px-badge-x text-small font-medium text-on-primary tabular-nums">
                {waiting}
                <span className="sr-only">件</span>
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}

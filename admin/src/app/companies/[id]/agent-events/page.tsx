'use client'

import { Suspense, useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { LockSimple } from '@phosphor-icons/react'

import { LogView } from '@/components/agent-events/log-view'
import { SettingsView } from '@/components/agent-events/settings-view'
import { EmptyState, ListSkeleton, PageHeader } from '@/components/app/states'
import { ApiError, agentEventsApi } from '@/lib/api'
import { filtersToSearch, parseFilters, type LogFilters } from '@/lib/agent-events'
import { useCompany } from '@/lib/company-context'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const TITLE = 'AI の操作の記録'

export default function AgentEventsPage() {
  return (
    <Suspense fallback={<ListSkeleton rows={5} />}>
      <AgentEventsContent />
    </Suspense>
  )
}

function AgentEventsContent() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { companyId, isAdmin, role, managedDepartmentIds } = useCompany()
  const search = params.toString()
  const filters = useMemo(() => parseFilters(new URLSearchParams(search)), [search])
  const tab = isAdmin && params.get('tab') === 'settings' ? 'settings' : 'log'

  // Filters live in the URL, so a view can be bookmarked or sent to someone.
  const navigate = useCallback(
    (next: LogFilters, nextTab: 'log' | 'settings' = 'log') => {
      const qs = filtersToSearch(next, { tab: nextTab === 'settings' ? 'settings' : undefined })
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname]
  )
  const onChange = useCallback((next: LogFilters) => navigate(next), [navigate])

  // A member (or a manager while only admins may read) gets 403: say so plainly.
  const probe = useQuery(role !== null && !isAdmin ? `agent-events-probe:${companyId}` : null, () =>
    agentEventsApi.list(companyId, { limit: 1 })
  )
  if (probe.error instanceof ApiError && probe.error.status === 403) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState
          icon={LockSimple}
          title="このページはオーナーと管理者だけが使えます"
          description="オーナーか管理者が設定で許可すると、部署の責任者も自分の部署の分を見られるようになります。"
        />
      </>
    )
  }

  return (
    <>
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>
          メンバーのデスクトップアプリで AI が道具を使うたびに、
          <strong className="font-medium text-foreground">いつ・誰が・どの AI で・どの道具を・どこに使ったか、それが許可されたか</strong>
          を記録しています。
          <strong className="font-medium text-foreground">会話の中身・ファイルの中身・コマンドの引数は記録しません</strong>
          （コマンドはプログラムの名前まで、会社フォルダの外は「会社フォルダの外」とだけ残します）。記録はアプリから1分ほどごとにまとめて届きます。
        </p>
        {!isAdmin && managedDepartmentIds.length > 0 && (
          <p>あなたが責任者の部署で行われた操作だけを表示しています。あなたが読めないフォルダは「非公開（表示できません）」と表示されます。</p>
        )}
      </div>

      {isAdmin && (
        <div role="tablist" aria-label="表示の切り替え" className="mb-6 flex gap-1 border-b">
          {(['log', 'settings'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => navigate(filters, t)}
              className={cn(
                '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                tab === t && 'border-foreground font-medium text-foreground'
              )}
            >
              {t === 'log' ? '記録' : '設定'}
            </button>
          ))}
        </div>
      )}

      {tab === 'settings' ? <SettingsView /> : <LogView filters={filters} onChange={onChange} />}
    </>
  )
}

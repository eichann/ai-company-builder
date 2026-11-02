'use client'

import Link from 'next/link'
import { CaretRight, LockSimple } from '@phosphor-icons/react'

import { EmptyState, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { agentEventsApi, agentSandboxApi, inboxSettingsApi, keyBrokerApi, taskSettingsApi } from '@/lib/api'
import { ADVANCED_SECTIONS, aiSafetyChanged, calendarChanged, inboxChanged, workChanged, type AdvancedSection } from '@/lib/advanced'
import { useCompany } from '@/lib/company-context'
import { useQuery } from '@/lib/use-query'

/**
 * 「詳しい設定」 (管理画面の見直し 2-3, owner decision 2026-11-02: shown to admins, tucked away at the
 * bottom of the menu): five headings, each with 「初期値のまま」 or 「変えています」.
 */
export default function AdvancedSettingsPage() {
  const { companyId, isAdmin, role } = useCompany()
  const on = (key: string) => (isAdmin ? `${key}:${companyId}` : null)
  const tasks = useQuery(on('task-settings'), () => taskSettingsApi.get(companyId))
  const inbox = useQuery(on('inbox-settings'), () => inboxSettingsApi.get(companyId))
  const sandbox = useQuery(on('agent-sandbox'), () => agentSandboxApi.get(companyId))
  const events = useQuery(on('agent-events-settings'), () => agentEventsApi.settings(companyId))
  const broker = useQuery(on('broker'), () => keyBrokerApi.get(companyId))

  if (role !== null && !isAdmin) {
    return (
      <>
        <PageHeader title="詳しい設定" />
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  // null while not known (loading, or a part the server cannot answer): no badge rather than a wrong one.
  const changed: Record<AdvancedSection, boolean | null> = {
    work: tasks.data ? workChanged(tasks.data.settings) : null,
    calendar: tasks.data ? calendarChanged(tasks.data.settings) : null,
    inbox: inbox.data ? inboxChanged(inbox.data.settings) : null,
    'ai-safety':
      sandbox.loading || events.loading || broker.loading
        ? null
        : aiSafetyChanged({ sandbox: sandbox.data, eventsUpdatedAt: events.data?.updatedAt ?? null, broker: broker.data }),
    info: false,
  }

  return (
    <>
      <PageHeader title="詳しい設定" description="ふだんは触らなくても困りません。変えた所には「変えています」が付きます。" />
      <ul aria-label="詳しい設定の見出し" className="divide-y overflow-hidden rounded-xl border bg-card">
        {ADVANCED_SECTIONS.map((s) => (
          <li key={s.id}>
            <Link
              href={`/companies/${companyId}/${s.path}`}
              className="flex items-center gap-3 px-5 py-4 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{s.title}</div>
                <div className="truncate text-xs text-muted-foreground">{s.description}</div>
              </div>
              {changed[s.id] === true && <Badge variant="warning">変えています</Badge>}
              {changed[s.id] === false && <Badge variant="secondary">初期値のまま</Badge>}
              <CaretRight size={14} className="shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

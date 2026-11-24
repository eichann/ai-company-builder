'use client'

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { ShieldSlash } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Callout } from '@/components/ui/callout'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  PEOPLE_CHANGED,
  PEOPLE_COMPANY_OFF,
  PEOPLE_INTRO,
  PEOPLE_NO_PC,
  PEOPLE_TITLE,
  PEOPLE_UNTICK_NOTE,
  PEOPLE_WAITING,
  changedFor,
  isTicked,
  lineKindLabel,
  nextGrantRow,
  peopleColumns,
  type PeopleColumn,
} from '@/lib/agent-browser-people'
import { agentBrowserApi, browserPcsApi, browserPeopleApi, companiesApi, type BrowserLineGrantsView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

/**
 * 「詳しい設定 › AI の安全 › ブラウザ操作 › ブラウザ操作を使える人」 (owner/admin; agent-browser.md "Per-line grants"): rows are
 * people, columns are 作業 (usable combinations); a box changes the person's grant at once.
 */
export default function BrowserPeoplePage() {
  const { companyId, role, isAdmin } = useCompany()
  const view = useQuery(isAdmin ? `browser-people:${companyId}` : null, () => browserPeopleApi.get(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  // Only for the notes (a person with no usable PC, the company's setting off): a failure just leaves them out.
  const pcs = useQuery(isAdmin ? `browser-pcs:${companyId}` : null, () => browserPcsApi.list(companyId))
  const setting = useQuery(isAdmin ? `agent-browser:${companyId}` : null, () => agentBrowserApi.get(companyId))
  const [busy, setBusy] = useState<string | null>(null)

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety browser />
        <PageHeader title={PEOPLE_TITLE} />
        <EmptyState icon={ShieldSlash} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const change = async (userId: string, name: string, column: PeopleColumn, allow: boolean) => {
    if (column.kind !== 'usable' || !view.data) return
    const cell = `${userId}:${column.key}`
    setBusy(cell)
    try {
      let current: BrowserLineGrantsView = view.data
      if (allow) {
        // Each approved row of this 作業 the person cannot use yet, oldest first (bounded by the rows there are).
        for (let i = 0; i < column.rows.length; i++) {
          const row = nextGrantRow(current, column, userId)
          if (!row) break
          current = await browserPeopleApi.set(companyId, userId, { site: row.site, line: row.line, meaningHash: row.meaningHash, mechanicsHash: row.mechanicsHash, allowed: true })
          view.setData(() => current)
        }
      } else {
        const t = column.target
        current = await browserPeopleApi.set(companyId, userId, { site: t.site, line: t.line, meaningHash: t.meaningHash, mechanicsHash: t.mechanicsHash, allowed: false })
        view.setData(() => current)
      }
      toast.success(allow ? `${name}さんが「${column.label}」を使えるようにしました` : `${name}さんの「${column.label}」を外しました`)
    } catch (err) {
      toast.error('変更できませんでした', { description: describeError(err) })
      view.reload()
    } finally {
      setBusy(null)
    }
  }

  const companyOff = setting.data ? setting.data.settings.mode === 'off' && !setting.data.overrides.some((o) => o.mode === 'on') : false
  const usablePc = new Set((pcs.data?.items ?? []).filter((pc) => pc.state === 'enabled').map((pc) => pc.userId))

  return (
    <>
      <AdvancedCrumb aiSafety browser />
      <PageHeader title={PEOPLE_TITLE} description={PEOPLE_INTRO} />
      {view.loading || members.loading ? (
        <ListSkeleton rows={4} />
      ) : (view.error && !view.data) || (members.error && !members.data) ? (
        <ErrorState error={view.error ?? members.error} onRetry={() => { view.reload(); members.reload() }} />
      ) : view.data && members.data ? (
        <div className="space-y-4 pb-4">
          {companyOff && <Callout variant="warning">{PEOPLE_COMPANY_OFF}</Callout>}
          <PeopleTable
            view={view.data}
            people={members.data.map((m) => ({ userId: m.userId, name: m.name || m.email || '名前未設定' }))}
            usablePc={pcs.data ? usablePc : null}
            pcsHref={`/companies/${companyId}/advanced/ai-safety/browser/pcs`}
            busy={busy}
            onChange={change}
          />
          <p className="text-small text-muted-foreground">{PEOPLE_UNTICK_NOTE}</p>
        </div>
      ) : null}
    </>
  )
}

function PeopleTable({
  view,
  people,
  usablePc,
  pcsHref,
  busy,
  onChange,
}: {
  view: BrowserLineGrantsView
  people: Array<{ userId: string; name: string }>
  usablePc: Set<string> | null
  pcsHref: string
  busy: string | null
  onChange: (userId: string, name: string, column: PeopleColumn, allow: boolean) => void
}) {
  const columns = peopleColumns(view)
  if (columns.length === 0) {
    return <p className="text-body text-muted-foreground">AI に任せられる作業は、まだありません。</p>
  }
  return (
    <Card className="px-5 py-2">
      <Table aria-label={PEOPLE_TITLE}>
        <TableHeader>
          <TableRow>
            <TableHead>人</TableHead>
            {columns.map((c) => (
              <TableHead key={c.key} data-column={c.key} className={cn('align-bottom whitespace-normal', c.kind === 'waiting' && 'opacity-disabled')}>
                <span className="block text-foreground">{c.label}</span>
                <span className="block">（{lineKindLabel(c.writes)}）</span>
                {c.kind === 'waiting' && <span className="block">{PEOPLE_WAITING}</span>}
                {changedFor(view, c) && <span className="block text-warning-text">{PEOPLE_CHANGED}</span>}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.map((p) => (
            <TableRow key={p.userId} data-person={p.userId}>
              <TableCell>
                <span className="block">{p.name}</span>
                {usablePc && !usablePc.has(p.userId) && (
                  <Link href={pcsHref} className="block text-small text-muted-foreground underline-offset-4 hover:underline">
                    {PEOPLE_NO_PC}
                  </Link>
                )}
              </TableCell>
              {columns.map((c) => {
                const ticked = isTicked(view, c, p.userId)
                return (
                  <TableCell key={c.key} className={cn(c.kind === 'waiting' && 'opacity-disabled')}>
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={c.kind === 'waiting' ? `${p.name}：${c.label}（${PEOPLE_WAITING}）` : `${p.name}：${c.label}`}
                      checked={ticked}
                      disabled={c.kind === 'waiting' || busy !== null}
                      onChange={(e) => onChange(p.userId, p.name, c, e.target.checked)}
                    />
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

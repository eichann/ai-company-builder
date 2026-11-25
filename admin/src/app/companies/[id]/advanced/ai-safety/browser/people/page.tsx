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
import { BROWSER_LEVEL_LABELS } from '@/lib/agent-browser'
import {
  PEOPLE_CAPPED,
  PEOPLE_CHANGE_NOTE,
  PEOPLE_COMPANY_OFF,
  PEOPLE_INTRO,
  PEOPLE_NO_PC,
  PEOPLE_NO_SITES,
  PEOPLE_SITE_READ_ONLY,
  PEOPLE_TITLE,
  PERSON_LEVELS,
  PERSON_LEVEL_LABELS,
  effectiveLevelOf,
  personLevelOf,
  writeChoosable,
} from '@/lib/agent-browser-people'
import { agentBrowserApi, browserPcsApi, browserPeopleApi, companiesApi, type BrowserPersonLevel, type BrowserSiteGrantsView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

/**
 * 「詳しい設定 › AI の安全 › ブラウザ操作 › ブラウザ操作を使える人」 (owner/admin; agent-browser.md "Who may use a site"): rows
 * are people, columns are the company's registered sites, a cell is 使わない / 見るだけ / 変えてよい (capped by the site's
 * level). A choice changes the person's level at once. Nothing of a site's jobs is shown.
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

  const change = async (userId: string, name: string, host: string, level: BrowserPersonLevel) => {
    setBusy(`${userId}:${host}`)
    try {
      const next = await browserPeopleApi.set(companyId, userId, { host, level })
      view.setData(() => next)
      toast.success(`${name}さんの「${host}」を「${PERSON_LEVEL_LABELS[level]}」にしました`)
    } catch (err) {
      toast.error('変更できませんでした', { description: describeError(err) })
      view.reload()
    } finally {
      setBusy(null)
    }
  }

  const companyOff = setting.data?.settings.mode === 'off'
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
          <p className="text-small text-muted-foreground">{PEOPLE_CHANGE_NOTE}</p>
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
  view: BrowserSiteGrantsView
  people: Array<{ userId: string; name: string }>
  usablePc: Set<string> | null
  pcsHref: string
  busy: string | null
  onChange: (userId: string, name: string, host: string, level: BrowserPersonLevel) => void
}) {
  if (view.sites.length === 0) {
    return <p className="text-body text-muted-foreground">{PEOPLE_NO_SITES}</p>
  }
  return (
    <Card className="px-5 py-2">
      <Table aria-label={PEOPLE_TITLE}>
        <TableHeader>
          <TableRow>
            <TableHead>人</TableHead>
            {view.sites.map((s) => (
              <TableHead key={s.host} data-column={s.host} className="align-bottom whitespace-normal">
                <span className="block text-foreground">{s.host}</span>
                <span className="block">（会社の設定：{BROWSER_LEVEL_LABELS[s.level]}）</span>
                {!writeChoosable(s) && <span className="block">{PEOPLE_SITE_READ_ONLY}</span>}
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
              {view.sites.map((s) => {
                const chosen = personLevelOf(view, p.userId, s.host)
                const capped = chosen !== effectiveLevelOf(view, p.userId, s)
                return (
                  <TableCell key={s.host}>
                    <select
                      aria-label={`${p.name}：${s.host}`}
                      className="rounded-control border bg-background px-2 py-1 text-body"
                      value={chosen}
                      disabled={busy !== null}
                      onChange={(e) => onChange(p.userId, p.name, s.host, e.target.value as BrowserPersonLevel)}
                    >
                      {PERSON_LEVELS.map((level) => (
                        <option key={level} value={level} disabled={level === 'write' && !writeChoosable(s) && chosen !== 'write'}>
                          {PERSON_LEVEL_LABELS[level]}
                        </option>
                      ))}
                    </select>
                    {capped && <span className="block text-small text-warning-text">{PEOPLE_CAPPED}</span>}
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

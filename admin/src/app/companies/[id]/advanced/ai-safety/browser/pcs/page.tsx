'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ClockCounterClockwise, Desktop, ShieldSlash } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  PC_ENABLE_HELP,
  PC_REVOKE_REASONS,
  PC_STATE_BADGE,
  PC_STATE_LABELS,
  PC_STOP_EFFECTS,
  PCS_INTRO,
  PCS_TITLE,
  pcEnableSentence,
  pcHistoryLine,
  pcStopTitle,
} from '@/lib/agent-browser-people'
import { browserPcsApi, companiesApi, type BrowserDevicesList } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

type Pc = BrowserDevicesList['items'][number]
type Pending = { kind: 'enable' | 'stop'; pc: Pc } | null

/** 「詳しい設定 › AI の安全 › ブラウザ操作 › ブラウザ操作に使う PC」 (owner/admin; agent-browser.md "This PC's registration"). */
export default function BrowserPcsPage() {
  const { companyId, role, isAdmin } = useCompany()
  const list = useQuery(isAdmin ? `browser-pcs:${companyId}` : null, () => browserPcsApi.list(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [pending, setPending] = useState<Pending>(null)

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety browser />
        <PageHeader title={PCS_TITLE} />
        <EmptyState icon={ShieldSlash} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const names = new Map<string, string>()
  for (const m of members.data ?? []) names.set(m.userId, m.name || m.email || '名前未設定')
  for (const pc of list.data?.items ?? []) if (pc.name && !names.has(pc.userId)) names.set(pc.userId, pc.name)
  const nameOf = (userId: string) => names.get(userId) ?? '（いまはメンバーでない人）'
  const labelOf = (deviceId: string) => list.data?.items.find((pc) => pc.id === deviceId)?.label ?? null

  const run = async (kind: 'enable' | 'stop', pc: Pc) => {
    try {
      if (kind === 'enable') await browserPcsApi.enable(companyId, pc.id)
      else await browserPcsApi.revoke(companyId, pc.id)
      toast.success(kind === 'enable' ? '使えるようにしました' : '止めました')
    } catch (err) {
      toast.error(kind === 'enable' ? '使えるようにできませんでした' : '止められませんでした', { description: describeError(err) })
      list.reload()
      throw err
    }
    list.reload()
  }

  return (
    <>
      <AdvancedCrumb aiSafety browser />
      <PageHeader title={PCS_TITLE} description={PCS_INTRO} />
      {list.loading ? (
        <ListSkeleton rows={3} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data ? (
        <div className="space-y-6 pb-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Desktop size={16} />
                登録された PC
              </CardTitle>
              <CardDescription>{PC_ENABLE_HELP}</CardDescription>
            </CardHeader>
            <div className="border-t px-5 py-2">
              {list.data.items.length === 0 ? (
                <p className="py-2 text-body text-muted-foreground">まだ登録された PC はありません。</p>
              ) : (
                <Table aria-label="登録された PC">
                  <TableHeader>
                    <TableRow>
                      <TableHead>人</TableHead>
                      <TableHead>PC の名前</TableHead>
                      <TableHead>申し込んだ日</TableHead>
                      <TableHead>状態</TableHead>
                      <TableHead>最後に使った日</TableHead>
                      <TableHead>
                        <span className="sr-only">操作</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.data.items.map((pc) => (
                      <TableRow key={pc.id} data-pc={pc.id}>
                        <TableCell>{nameOf(pc.userId)}</TableCell>
                        <TableCell className="break-all">{pc.label}</TableCell>
                        <TableCell>{formatDate(pc.requestedAt)}</TableCell>
                        <TableCell>
                          <Badge variant={PC_STATE_BADGE[pc.state]}>{PC_STATE_LABELS[pc.state]}</Badge>
                          {pc.state === 'revoked' && pc.revokeReason && (
                            <p className="mt-1 text-small text-muted-foreground">{PC_REVOKE_REASONS[pc.revokeReason]}</p>
                          )}
                        </TableCell>
                        <TableCell>{pc.lastUsedAt ? formatDate(pc.lastUsedAt) : 'まだ使っていません'}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            {pc.state === 'pending' && (
                              <Button size="sm" onClick={() => setPending({ kind: 'enable', pc })} aria-label={`${nameOf(pc.userId)}さんの「${pc.label}」を使えるようにする`}>
                                使えるようにする
                              </Button>
                            )}
                            {pc.state !== 'revoked' && (
                              <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'stop', pc })} aria-label={`${nameOf(pc.userId)}さんの「${pc.label}」を止める`}>
                                止める
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {list.data.more && <p className="py-2 text-small text-muted-foreground">古い登録は表示していません。</p>}
            </div>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <ClockCounterClockwise size={16} />
                これまでの記録
              </CardTitle>
            </CardHeader>
            <div className="border-t px-5 py-2">
              {list.data.history.length === 0 ? (
                <p className="py-2 text-body text-muted-foreground">まだ記録はありません。</p>
              ) : (
                <ul aria-label="これまでの記録" className="divide-y text-body">
                  {list.data.history.map((h, i) => (
                    <li key={`${h.deviceId}-${h.at}-${i}`} className="py-2">
                      <span className="text-muted-foreground">{formatDateTime(h.at)}・</span>
                      {pcHistoryLine(h, nameOf, labelOf)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending?.kind === 'enable'}
        onOpenChange={(o) => !o && setPending(null)}
        destructive={false}
        title="この PC を使えるようにしますか？"
        description={pending ? <p>{pcEnableSentence(nameOf(pending.pc.userId), pending.pc.label)}{PC_ENABLE_HELP}</p> : undefined}
        confirmLabel="使えるようにする"
        onConfirm={() => (pending ? run('enable', pending.pc) : Promise.resolve())}
      />
      <ConfirmDialog
        open={pending?.kind === 'stop'}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? pcStopTitle(nameOf(pending.pc.userId), pending.pc.label) : ''}
        description={
          <ul className="list-disc space-y-1 pl-5">
            {PC_STOP_EFFECTS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        }
        confirmLabel="止める"
        onConfirm={() => (pending ? run('stop', pending.pc) : Promise.resolve())}
      />
    </>
  )
}

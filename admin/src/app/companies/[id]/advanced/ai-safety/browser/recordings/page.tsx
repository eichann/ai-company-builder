'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ShieldSlash, VideoCamera } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  RECORDING_DELETE_DESCRIPTION,
  RECORDING_DELETE_TITLE,
  RECORDING_ESTIMATED_NOTE,
  RECORDINGS_EMPTY,
  RECORDINGS_INTRO,
  RECORDINGS_MORE,
  RECORDINGS_TITLE,
  recordingLines,
} from '@/lib/agent-browser-recordings'
import { browserRecordingsApi, type BrowserRecordingDetail, type BrowserRecordingSummary } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/**
 * 「詳しい設定 › AI の安全 › ブラウザ操作 › ブラウザ操作の記録」 (owner/admin; agent-browser.md "Recording"): the recordings
 * members sent — who, when, which site, how many lines —, each opened or deleted. The server checks the reader on every call.
 */
export default function BrowserRecordingsPage() {
  const { companyId, role, isAdmin } = useCompany()
  const list = useQuery(isAdmin ? `browser-recordings:${companyId}` : null, () => browserRecordingsApi.list(companyId))
  const [open, setOpen] = useState<BrowserRecordingDetail | null>(null)
  const [deleting, setDeleting] = useState<BrowserRecordingSummary | null>(null)

  if (role !== null && !isAdmin) {
    return (
      <>
        <AdvancedCrumb aiSafety browser />
        <PageHeader title={RECORDINGS_TITLE} />
        <EmptyState icon={ShieldSlash} title="このページはオーナーと管理者だけが使えます" />
      </>
    )
  }

  const show = async (r: BrowserRecordingSummary) => {
    try {
      setOpen(await browserRecordingsApi.get(companyId, r.id))
    } catch (err) {
      toast.error('記録を開けませんでした', { description: describeError(err) })
      list.reload()
    }
  }
  const remove = async (r: BrowserRecordingSummary) => {
    try {
      await browserRecordingsApi.remove(companyId, r.id)
      toast.success('記録を消しました')
      if (open?.id === r.id) setOpen(null)
    } catch (err) {
      toast.error('記録を消せませんでした', { description: describeError(err) })
      list.reload()
      throw err
    }
    list.reload()
  }

  return (
    <>
      <AdvancedCrumb aiSafety browser />
      <PageHeader title={RECORDINGS_TITLE} description={RECORDINGS_INTRO} />
      {list.loading ? (
        <ListSkeleton rows={3} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data ? (
        <div className="space-y-6 pb-4">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <VideoCamera size={16} />
                届いた記録
              </CardTitle>
              <CardDescription>30日たつと自動で消えます。</CardDescription>
            </CardHeader>
            <div className="border-t px-5 py-2">
              {list.data.items.length === 0 ? (
                <p className="py-2 text-body text-muted-foreground">{RECORDINGS_EMPTY}</p>
              ) : (
                <Table aria-label="届いた記録">
                  <TableHeader>
                    <TableRow>
                      <TableHead>送った人</TableHead>
                      <TableHead>送った日時</TableHead>
                      <TableHead>サイト</TableHead>
                      <TableHead>行数</TableHead>
                      <TableHead>消える日</TableHead>
                      <TableHead>
                        <span className="sr-only">操作</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.data.items.map((r) => (
                      <TableRow key={r.id} data-recording={r.id}>
                        <TableCell>{r.name ?? '（いまはメンバーでない人）'}</TableCell>
                        <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                        <TableCell className="break-all font-mono">{r.domain}</TableCell>
                        <TableCell>{r.lines}</TableCell>
                        <TableCell>{formatDate(r.deleteAt)}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => void show(r)}>開く</Button>
                            <Button size="sm" variant="outline" onClick={() => setDeleting(r)} aria-label={`${formatDateTime(r.createdAt)}の記録を消す`}>消す</Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {list.data.more && <p className="py-2 text-small text-muted-foreground">{RECORDINGS_MORE}</p>}
            </div>
          </Card>

          {open && (
            <Card data-recording-open={open.id}>
              <CardHeader className="pb-4">
                <CardTitle>{`${open.name ?? '（いまはメンバーでない人）'}・${formatDateTime(open.createdAt)}・${open.domain}`}</CardTitle>
                <CardDescription>{RECORDING_ESTIMATED_NOTE}</CardDescription>
              </CardHeader>
              <div className="border-t px-5 py-2">
                <ol aria-label="記録の手順" className="divide-y text-body">
                  {recordingLines(open.content).map((line) => (
                    <li key={line.id} className="flex gap-3 py-2">
                      <span className="w-8 shrink-0 text-muted-foreground">{line.id}</span>
                      <span className="w-16 shrink-0 font-semibold">{line.kind}</span>
                      <span className="min-w-0 flex-1 break-all">
                        {line.text}
                        {line.estimated && <span className="block text-small text-muted-foreground">{`（推定）${line.estimated}`}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
                {open.content.hosts.length > 0 && (
                  <div className="py-3">
                    <p className="text-small font-semibold">窓が読み込もうとした、ほかのサイト</p>
                    <ul aria-label="ほかのサイト" className="text-small text-muted-foreground">
                      {open.content.hosts.map((h) => (
                        <li key={h.host} className="font-mono">{`${h.host}${h.loaded ? '' : '（読み込めませんでした）'}`}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex justify-end py-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>閉じる</Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={RECORDING_DELETE_TITLE}
        description={<p>{RECORDING_DELETE_DESCRIPTION}</p>}
        confirmLabel="消す"
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve())}
      />
    </>
  )
}

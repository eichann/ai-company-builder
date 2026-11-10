'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, skillShelfApi, type ShelfRequestContent, type ShelfRequestView } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/** The most characters 見送る's reason may have (SHELF_REQUEST_LIMITS.reasonLength on the server). */
export const DECLINE_REASON_MAX = 200

const placeOf = (r: ShelfRequestView) => (r.department ? r.department.name : '会社全体')
const personOf = (p: { name: string | null }) => p.name || 'もういない人'

/** What 公開する says before it happens: everyone who sees the place gets it, and what it replaces. */
export function publishRequestDescription(r: ShelfRequestView): string {
  const reach = `${placeOf(r)}を見られる全員のアプリに届きます。`
  return r.currentVersion
    ? `${reach}いま配っている同じ名前の Skill を置き換えます（前の版は「これまでの版」から戻せます）。`
    : reach
}

export const OUTPUTS_QUESTION = '成果物が入っていませんか？'
export const OUTPUTS_NOTE =
  'Skill には手順・道具・参考資料・ひな形だけを入れます。作ったもの（提案書・レポートなど）は、Skill を見られる全員に届いてしまいます。次のファイルは成果物のように見えます。外して公開するか、公開せずに「見送る」で直してもらうよう伝えてください。'

/** The paths of a 400 SHELF_OUTPUTS_INSIDE answer, or null for any other error. */
function outputPathsOf(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== 'SHELF_OUTPUTS_INSIDE') return null
  const paths = err.body?.paths
  return Array.isArray(paths) && paths.every((p) => typeof p === 'string') ? paths : null
}

/**
 * 「公開のお願い」 (owner decision 2026-11-09): Skills members who may not publish sent to those who
 * may. Only pending requests the caller may decide are listed here (the server lists nothing else
 * to them: their own requests are shown in their app). Each can be looked at, published as a new
 * version (the history keeps who asked) or declined with a short reason.
 */
export function ShelfRequests({ companyId, onPublished }: { companyId: string; onPublished: () => void }) {
  const requests = useQuery(`skill-shelf-requests:${companyId}`, () => skillShelfApi.requests(companyId))
  const [viewing, setViewing] = useState<ShelfRequestView | null>(null)
  const [publishing, setPublishing] = useState<ShelfRequestView | null>(null)
  const [declining, setDeclining] = useState<ShelfRequestView | null>(null)
  const [withOutputs, setWithOutputs] = useState<{ request: ShelfRequestView; paths: string[] } | null>(null)

  const waiting = (requests.data?.requests ?? []).filter((r) => r.state === 'pending' && r.canDecide)
  // Nothing to decide (or the list could not be read): the section stays out of the way.
  if (waiting.length === 0) return null

  const settle = (id: string) =>
    requests.setData((prev) => ({ requests: (prev?.requests ?? []).filter((r) => r.id !== id) }))

  return (
    <section aria-label="公開のお願い" className="mb-8 space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">公開のお願い</h2>
      <p className="text-sm text-muted-foreground">
        自分では公開できない人から、Skill を会社に出してほしいとお願いが届いています。中身を見てから、公開するか見送るかを決めてください。
      </p>
      <Card className="p-0">
        <ul aria-label="公開のお願い" className="divide-y">
          {waiting.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.name}
                  <Badge variant="outline">{placeOf(r)}</Badge>
                  {r.currentVersion && <Badge variant="secondary">同じ名前の Skill を置き換え</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {`${personOf(r.requestedBy)}さんから ${formatDateTime(r.requestedAt)}・ファイル ${r.fileCount} 個`}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setViewing(r)}>
                  中身を見る
                </Button>
                <Button size="sm" onClick={() => setPublishing(r)}>
                  公開する
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeclining(r)}>
                  見送る
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <RequestFilesDialog
        companyId={companyId}
        request={viewing}
        onOpenChange={(o) => !o && setViewing(null)}
        // Sent again (404) or decided (409) since the list was read: the list is out of date too.
        onStale={requests.reload}
      />
      <ConfirmDialog
        open={publishing !== null}
        onOpenChange={(o) => !o && setPublishing(null)}
        title={publishing ? `「${publishing.name}」を公開しますか？` : ''}
        description={publishing ? publishRequestDescription(publishing) : ''}
        confirmLabel="公開する"
        destructive={false}
        onConfirm={async () => {
          const target = publishing!
          try {
            // The version shown in this list and in 中身を見る (one request id never changes its files).
            await skillShelfApi.publishRequest(companyId, target.id, target.version, target.currentVersion)
            settle(target.id)
            toast.success(`「${target.name}」を公開しました`)
            onPublished()
          } catch (err) {
            const paths = outputPathsOf(err)
            if (paths) {
              setWithOutputs({ request: target, paths })
            } else {
              toast.error(describeError(err))
              requests.reload()
            }
          }
          setPublishing(null)
        }}
      />
      {/* A request kept from before outputs were refused (owner decision 2026-11-10): 外して出す or not now. */}
      <ConfirmDialog
        open={withOutputs !== null}
        onOpenChange={(o) => !o && setWithOutputs(null)}
        title={OUTPUTS_QUESTION}
        description={withOutputs && (
          <>
            <p>{OUTPUTS_NOTE}</p>
            <ul aria-label="成果物のように見えるファイル" className="list-disc pl-5 break-all">
              {withOutputs.paths.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </>
        )}
        confirmLabel="外して出す"
        cancelLabel="公開しない"
        destructive={false}
        onConfirm={async () => {
          const { request } = withOutputs!
          try {
            await skillShelfApi.publishRequest(companyId, request.id, request.version, request.currentVersion, true)
            settle(request.id)
            toast.success(`「${request.name}」を、成果物を外して公開しました`)
            onPublished()
          } catch (err) {
            toast.error(describeError(err))
            requests.reload()
          }
          setWithOutputs(null)
        }}
      />
      <DeclineDialog
        request={declining}
        onOpenChange={(o) => !o && setDeclining(null)}
        onDecline={async (reason) => {
          const target = declining!
          try {
            await skillShelfApi.declineRequest(companyId, target.id, target.version, reason)
            settle(target.id)
            toast.success(`「${target.name}」のお願いを見送りました`)
          } catch (err) {
            toast.error(describeError(err))
            requests.reload()
          }
          setDeclining(null)
        }}
      />
    </section>
  )
}

/** A file's text when it reads as text (UTF-8 without NUL); null for anything else. */
export function readableText(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    if (bytes.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function RequestFilesDialog({ companyId, request, onOpenChange, onStale }: {
  companyId: string; request: ShelfRequestView | null; onOpenChange: (open: boolean) => void; onStale: () => void
}) {
  const content = useQuery<ShelfRequestContent>(request ? `skill-shelf-request-files:${companyId}:${request.id}:${request.version}` : null, () =>
    skillShelfApi.requestFiles(companyId, request!.id),
  )
  const stale = !!content.error || (!!content.data && !!request && content.data.version !== request.version)
  useEffect(() => {
    if (stale) onStale()
  }, [stale, onStale])
  // SKILL.md first, then the rest by name.
  const files = [...(content.data?.files ?? [])].sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)))
  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{request ? `「${request.name}」の中身` : ''}</DialogTitle>
          <DialogDescription>{request ? `${personOf(request.requestedBy)}さんが送った Skill のファイルです。` : ''}</DialogDescription>
        </DialogHeader>
        {content.data && request && content.data.version !== request.version ? (
          // What is there now is not what this list showed: look again from a fresh list.
          <p role="alert" className="text-sm text-destructive">お願いの中身が変わりました。もう一度中身を見てください。</p>
        ) : content.error && !content.data ? (
          <p role="alert" className="text-sm text-destructive">{describeError(content.error)}</p>
        ) : !content.data ? (
          <p className="text-sm text-muted-foreground">読み込んでいます…</p>
        ) : (
          <ul aria-label="ファイル" className="max-h-[60vh] space-y-3 overflow-y-auto">
            {files.map((f) => {
              const text = readableText(f.base64)
              return (
                <li key={f.path} className="space-y-1">
                  <p className="font-mono text-xs font-medium">{f.path}</p>
                  {text === null ? (
                    <p className="text-xs text-muted-foreground">文字ではないファイルです（中身は表示しません）。</p>
                  ) : (
                    <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{text}</pre>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeclineDialog({ request, onOpenChange, onDecline }: { request: ShelfRequestView | null; onOpenChange: (open: boolean) => void; onDecline: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const tooLong = reason.trim().length > DECLINE_REASON_MAX
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(o) => {
        if (!o) setReason('')
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request ? `「${request.name}」のお願いを見送りますか？` : ''}</DialogTitle>
          <DialogDescription>{request ? `${personOf(request.requestedBy)}さんのアプリに「見送られた」と表示されます。理由を書くと、一緒に伝わります。` : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="decline-reason">理由（なくてもかまいません）</Label>
          <Textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={tooLong} />
          <p className="text-xs text-muted-foreground">{tooLong ? `${DECLINE_REASON_MAX} 文字までです。` : `${DECLINE_REASON_MAX} 文字まで`}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            disabled={busy || tooLong}
            onClick={async () => {
              setBusy(true)
              try {
                await onDecline(reason.trim())
              } finally {
                setBusy(false)
                setReason('')
              }
            }}
          >
            見送る
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

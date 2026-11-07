'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Lightning } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { skillShelfApi, type ShelfItemView, type ShelfKind, type ShelfVersionsView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

/** What the page says at the top (plain words: no Git words). */
export const SHELF_INTRO =
  '会社のみんなの AI が使う Skill と、AI への指示です。新しく出す・中身を変えるのはアプリから行います。ここでは、いま配っている版の確認、前の版に戻すこと、配るのをやめることができます。'

/** Shown in a company that uses the shared company folder. */
export const SHELF_WITH_FOLDER_NOTE =
  'この会社では、Skill と AI への指示は全社フォルダで共有しています。このページは、全社フォルダを使わない会社で使います。'

const KIND_SECTIONS: Array<{ kind: ShelfKind; title: string; empty: string }> = [
  { kind: 'skill', title: 'Skill', empty: 'まだ Skill はありません。' },
  { kind: 'instructions', title: 'AI への指示', empty: 'まだ AI への指示はありません。' },
  { kind: 'rule', title: 'AI への決まり', empty: 'まだ AI への決まりはありません。' },
]

/** The first characters of a version, as people compare them. */
export const shortVersion = (version: string) => version.slice(0, 8)

const placeLabel = (item: ShelfItemView) => (item.department ? item.department.name : '会社全体')
const itemLabel = (item: ShelfItemView) => (item.kind === 'instructions' ? `${placeLabel(item)}の指示` : item.name)
const personLabel = (p: { id: string; name: string | null }) => p.name || 'もういない人'

export function SkillShelfPage() {
  const { companyId, hasCompanyFolder } = useCompany()
  const shelf = useQuery(hasCompanyFolder ? null : `skill-shelf:${companyId}`, () => skillShelfApi.list(companyId))
  const [viewing, setViewing] = useState<ShelfItemView | null>(null)
  const [stopping, setStopping] = useState<ShelfItemView | null>(null)

  if (hasCompanyFolder) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <PageHeader title="会社の Skill" />
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{SHELF_WITH_FOLDER_NOTE}</p>
      </div>
    )
  }

  const items = shelf.data?.items ?? []
  const replace = (item: ShelfItemView) =>
    shelf.setData((prev) => ({ items: (prev?.items ?? []).map((x) => (x.id === item.id ? item : x)) }))

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="会社の Skill" description={SHELF_INTRO} />
      {shelf.error && !shelf.data ? (
        <ErrorState error={shelf.error} onRetry={shelf.reload} />
      ) : shelf.loading || !shelf.data ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <EmptyState icon={Lightning} title="まだ何もありません" description="アプリから Skill や AI への指示を会社に出すと、ここに出ます。" />
      ) : (
        <div className="space-y-6">
          {KIND_SECTIONS.map(({ kind, title, empty }) => {
            const list = items.filter((i) => i.kind === kind)
            return (
              <section key={kind} aria-label={title} className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
                {list.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{empty}</p>
                ) : (
                  <Card className="p-0">
                    <ul aria-label={title} className="divide-y">
                      {list.map((item) => (
                        <li key={item.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="flex flex-wrap items-center gap-2 font-medium">
                              {itemLabel(item)}
                              <Badge variant="outline">{placeLabel(item)}</Badge>
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {item.version ? `配っています（版 ${shortVersion(item.version)}・ファイル ${item.fileCount} 個）` : '配るのをやめています'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {`${personLabel(item.changedBy)}さんが ${formatDateTime(item.changedAt)} に変えました`}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={() => setViewing(item)}>
                              これまでの版
                            </Button>
                            {item.version && item.canChange && (
                              <Button variant="ghost" size="sm" onClick={() => setStopping(item)}>
                                配るのをやめる
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </section>
            )
          })}
        </div>
      )}

      <VersionsDialog
        item={viewing}
        companyId={companyId}
        onOpenChange={(o) => !o && setViewing(null)}
        onChanged={(item) => {
          replace(item)
          setViewing(item)
        }}
        onConflict={shelf.reload}
      />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(o) => !o && setStopping(null)}
        title={stopping ? `「${itemLabel(stopping)}」を配るのをやめますか？` : ''}
        description="みんなのアプリから消えます。これまでの版は残るので、「これまでの版」からいつでも戻せます。"
        confirmLabel="配るのをやめる"
        destructive
        onConfirm={async () => {
          const target = stopping!
          try {
            const result = await skillShelfApi.unpublish(companyId, target.id, target.version)
            replace(result.item)
            toast.success(`「${itemLabel(target)}」を配るのをやめました`)
          } catch (err) {
            toast.error(describeError(err))
            shelf.reload()
          }
          setStopping(null)
        }}
      />
    </div>
  )
}

function VersionsDialog({
  item,
  companyId,
  onOpenChange,
  onChanged,
  onConflict,
}: {
  item: ShelfItemView | null
  companyId: string
  onOpenChange: (open: boolean) => void
  onChanged: (item: ShelfItemView) => void
  onConflict: () => void
}) {
  const versions = useQuery<ShelfVersionsView>(item ? `skill-shelf-versions:${companyId}:${item.id}:${item.version ?? ''}` : null, () =>
    skillShelfApi.versions(companyId, item!.id),
  )
  const [busy, setBusy] = useState<string | null>(null)

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? `「${itemLabel(item)}」のこれまでの版` : ''}</DialogTitle>
          <DialogDescription>前の版に戻すと、みんなのアプリにもその版が届きます。</DialogDescription>
        </DialogHeader>
        {versions.error && !versions.data ? (
          <ErrorState error={versions.error} onRetry={versions.reload} />
        ) : !versions.data ? (
          <ListSkeleton rows={2} />
        ) : (
          <ul aria-label="これまでの版" className="divide-y rounded-lg border">
            {versions.data.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {`版 ${shortVersion(v.version)}`}
                    {v.current && <Badge>いま配っている版</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">{`${personLabel(v.publishedBy)}さん・${formatDateTime(v.publishedAt)}・ファイル ${v.fileCount} 個`}</p>
                  {v.autorun && <p className="text-xs text-muted-foreground">自動で動く部分があります（戻せるのはオーナーと管理者だけです）</p>}
                </div>
                {!v.current && item?.canChange && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(v.version)
                      try {
                        const result = await skillShelfApi.restore(companyId, item.id, v.version, versions.data!.item.version)
                        toast.success(`版 ${shortVersion(v.version)} に戻しました`)
                        onChanged(result.item)
                      } catch (err) {
                        toast.error(describeError(err))
                        onConflict()
                        versions.reload()
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    この版に戻す
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

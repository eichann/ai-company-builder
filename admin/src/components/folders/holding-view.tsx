'use client'

import { useMemo, useState } from 'react'
import { Archive, ArrowClockwise, LockSimple, Tray } from '@phosphor-icons/react'

import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { FOLDERS_DESCRIPTION, FOLDERS_TITLE, FolderTabs } from '@/components/folders/folder-tabs'
import { HoldingItemDialog } from '@/components/folders/holding-item-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { departmentsApi, holdingApi, type HoldingReviewItem } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { formatDate } from '@/lib/format'
import { CAUSE_LABELS, HOLDING_EMPTY, HOLDING_HELP, countsText, expiresSoon, expiryText, personLabel } from '@/lib/holding'
import { displayPath } from '@/lib/private-folders'
import { useQuery } from '@/lib/use-query'

/**
 * 「フォルダ」 › 「預かり」 (?tab=holding; private-folders.md "Holding: review", design memo §4): what members
 * who stopped reading a private folder handed over, for the folder's managers to take in or discard.
 * Every row is what `GET /holding` answered — the server lists an item only to someone who may review
 * it, so this page shows nothing it did not get from there (no folder looked up elsewhere).
 */
export function HoldingView() {
  const { companyId } = useCompany()
  const list = useQuery(`holding:${companyId}`, () => holdingApi.list(companyId))
  // Department names only turn a folder path the API answered into its display form.
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const [open, setOpen] = useState<HoldingReviewItem | null>(null)

  const depts = useMemo(() => departments.data ?? [], [departments.data])
  const items = useMemo(
    () => [...(list.data?.items ?? [])].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
    [list.data]
  )

  return (
    <>
      <PageHeader
        title={FOLDERS_TITLE}
        description={FOLDERS_DESCRIPTION}
        actions={
          <Button variant="outline" onClick={() => list.reload()} disabled={list.fetching}>
            <ArrowClockwise />
            読み込み直す
          </Button>
        }
      />
      <FolderTabs current="holding" />
      <p className="-mt-2 mb-4 text-body text-text-muted">{HOLDING_HELP}</p>

      {list.loading ? (
        <ListSkeleton rows={3} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <EmptyState icon={Tray} title={HOLDING_EMPTY} />
      ) : (
        <Card className="overflow-hidden py-0">
          <ul aria-label="預かっているもの" className="divide-y">
            {items.map((item) => (
              <li key={item.itemId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-row-x py-3">
                <span className="flex size-icon-lg shrink-0 items-center justify-center rounded-control bg-selected-bg text-selected-icon">
                  <Archive size={18} weight="fill" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-body font-strong">
                    {personLabel(item)}・{formatDate(item.receivedAt)}・{CAUSE_LABELS[item.cause] ?? '見る権限がなくなったとき'}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 text-small text-text-muted">
                    <LockSimple size={14} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{displayPath(item.folderPath, depts)}</span>
                  </div>
                  <div className="text-small text-text-muted">{countsText(item)}</div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {item.folderGone && <Badge variant="neutral">フォルダはもうありません</Badge>}
                  {item.state === 'taking' && <Badge variant="info">フォルダに入れています</Badge>}
                  <Badge variant={expiresSoon(item.expiresAt) ? 'warning' : 'neutral'}>{expiryText(item.expiresAt)}</Badge>
                  <Button variant="outline" size="sm" onClick={() => setOpen(item)}>
                    中身を確かめる
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {open && (
        <HoldingItemDialog
          key={open.itemId}
          companyId={companyId}
          item={open}
          folderLabel={displayPath(open.folderPath, depts)}
          onOpenChange={(o) => !o && setOpen(null)}
          onChanged={list.reload}
        />
      )}
    </>
  )
}

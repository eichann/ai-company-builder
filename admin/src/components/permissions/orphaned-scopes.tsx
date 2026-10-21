'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, CaretRight, Folder, FolderSimpleDashed } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { OutdatedClientsDialog, useOutdatedClients } from '@/components/permissions/outdated-clients-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, permissionsApi, type Member, type OrphanedScope } from '@/lib/api'
import { describeRules } from '@/lib/edit-access'
import { describeError } from '@/lib/errors'
import { formatDateTime, formatRelative } from '@/lib/format'
import { isSameOrAncestorPath, parentPath, pathSegments } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

export const ORPHANED_TITLE = 'ルールが付いているフォルダが見つかりません（名前の変更・削除の可能性）'
export const ORPHANED_DESCRIPTION =
  '同期でフォルダの名前が変わったか、削除された可能性があります。このままではルールは使われず、上の階層の設定が適用されます。新しい場所に移すか、ルールを削除してください。'

/**
 * Rules whose folder no longer exists on the server (renamed or removed by a
 * sync, outside this panel). Nothing follows a rename automatically: the
 * person editing picks the new place (新しい場所に移す) or removes the rules.
 */
export function OrphanedScopesCard({
  companyId,
  orphans,
  members,
  canEdit,
  onChanged,
}: {
  companyId: string
  orphans: OrphanedScope[]
  members: Member[]
  canEdit: (path: string) => boolean
  onChanged: () => void
}) {
  const [moving, setMoving] = useState<OrphanedScope | null>(null)
  const [deleting, setDeleting] = useState<OrphanedScope | null>(null)
  const { catchOutdated, dialogProps } = useOutdatedClients()

  if (orphans.length === 0) return null

  const remove = async (o: OrphanedScope, force = false) => {
    try {
      await permissionsApi.resetScope(companyId, o.scopeId, { force })
      toast.success(`「${o.path}」のルールを削除しました`)
      onChanged()
    } catch (err) {
      if (!force && catchOutdated(err, () => remove(o, true))) return
      toast.error('ルールを削除できませんでした', { description: describeError(err) })
      throw err
    }
  }

  return (
    <Card className="gap-0 overflow-hidden border-warning/40 py-0" role="region" aria-label={ORPHANED_TITLE}>
      <div className="flex gap-3 px-5 pt-4 pb-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
          <FolderSimpleDashed size={17} weight="bold" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold">{ORPHANED_TITLE}</h2>
          <p className="text-sm text-muted-foreground">{ORPHANED_DESCRIPTION}</p>
        </div>
      </div>
      <ul className="divide-y border-t">
        {orphans.map((o) => (
          <li key={o.scopeId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm">{o.path}</div>
              <div className="text-xs text-muted-foreground">
                編集できる人：{describeRules(o.rules, members)} ·{' '}
                <time dateTime={o.since} title={formatDateTime(o.since)}>
                  {formatRelative(o.since)}から見つかりません
                </time>
              </div>
            </div>
            {canEdit(o.path) && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setMoving(o)}>
                  新しい場所に移す
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(o)}>
                  ルールを削除
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {moving && (
        <MoveRulesDialog
          companyId={companyId}
          orphan={moving}
          canEdit={canEdit}
          onClose={() => setMoving(null)}
          onMoved={onChanged}
          catchOutdated={catchOutdated}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="ルールを削除しますか？"
        description={
          <p>
            「{deleting?.path}」に付いていたルールを削除します。この場所が見つかったときは、上の階層の設定が適用されます。
          </p>
        }
        confirmLabel="ルールを削除"
        onConfirm={async () => {
          if (deleting) await remove(deleting)
        }}
      />

      <OutdatedClientsDialog {...dialogProps} />
    </Card>
  )
}

/**
 * Pick an existing folder on the server to move the rules to. Browses
 * folders with GET /permissions/folders, starting next to where the rules
 * were (going up while that place does not exist any more).
 */
function MoveRulesDialog({
  companyId,
  orphan,
  canEdit,
  onClose,
  onMoved,
  catchOutdated,
}: {
  companyId: string
  orphan: OrphanedScope
  canEdit: (path: string) => boolean
  onClose: () => void
  onMoved: () => void
  catchOutdated: (err: unknown, retry: () => Promise<void>) => boolean
}) {
  const [dir, setDir] = useState(() => parentPath(orphan.path))
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The old parent may be gone too: go up until a folder exists.
  const folders = useQuery(`move-folders:${companyId}:${dir}`, async () => {
    let at = dir
    for (;;) {
      try {
        return await permissionsApi.folders(companyId, at)
      } catch (err) {
        if (at === '' || !(err instanceof ApiError) || err.status !== 404) throw err
        at = parentPath(at)
      }
    }
  })
  const here = folders.data?.path ?? dir

  const open = (path: string) => {
    setDir(path)
    setSelected(null)
  }

  const move = async (toPath: string, force = false) => {
    setBusy(true)
    try {
      await permissionsApi.moveScope(companyId, orphan.scopeId, toPath, { force })
      toast.success(`ルールを「${toPath}」に移しました`)
      onMoved()
      onClose()
    } catch (err) {
      if (!force && catchOutdated(err, () => move(toPath, true))) {
        onClose()
        return
      }
      toast.error('ルールを移せませんでした', { description: describeError(err) })
      if (force) throw err
    } finally {
      setBusy(false)
    }
  }

  const ownSubtree = (path: string) => isSameOrAncestorPath(orphan.path, path) || isSameOrAncestorPath(path, orphan.path)
  const segments = pathSegments(here)

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新しい場所に移す</DialogTitle>
          <DialogDescription>
            「{orphan.path}」に付いていたルール（中のフォルダのルールも含む）を移すフォルダを選んでください。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={here === '' || !canEdit(parentPath(here)) || busy}
            onClick={() => open(parentPath(here))}
            aria-label="上のフォルダへ"
          >
            <ArrowUp />
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground">{segments.length ? segments.join(' / ') : '会社のフォルダ全体'}</span>
        </div>

        <div className="max-h-72 overflow-y-auto rounded-lg border">
          {folders.loading ? (
            <div className="space-y-2 p-3" aria-busy="true" aria-label="読み込み中">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : folders.error ? (
            <p className="p-3 text-sm text-muted-foreground">{describeError(folders.error)}</p>
          ) : (folders.data?.folders.length ?? 0) === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">中にフォルダがありません</p>
          ) : (
            <ul role="listbox" aria-label="移動先のフォルダ" className="divide-y">
              {folders.data!.folders.map((f) => {
                const unavailable = f.hasRules || ownSubtree(f.path) || !canEdit(f.path)
                return (
                  <li key={f.path} className={cn('flex items-center gap-1 pr-1', selected === f.path && 'bg-accent/60')}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected === f.path}
                      disabled={unavailable || busy}
                      onClick={() => setSelected(f.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm outline-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <Folder size={16} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      {f.hasRules && <span className="shrink-0 text-xs text-muted-foreground">個別ルールあり</span>}
                    </button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => open(f.path)}
                      disabled={busy}
                      aria-label={`${f.name} の中を見る`}
                    >
                      <CaretRight />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button type="button" onClick={() => selected && void move(selected)} disabled={!selected || busy}>
            {busy ? '移しています…' : 'ここに移す'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

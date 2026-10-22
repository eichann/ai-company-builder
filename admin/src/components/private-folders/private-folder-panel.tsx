'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Eye, LockSimple, PencilSimple, Users } from '@phosphor-icons/react'

import { ErrorState } from '@/components/app/states'
import { MakePublicDialog } from '@/components/private-folders/make-public-dialog'
import { PrivateFolderMembersDialog } from '@/components/private-folders/members-dialog'
import { SubfolderPicker } from '@/components/permissions/subfolder-picker'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { privateFoldersApi, type Department, type Member, type PermissionScope } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { roleLabel } from '@/lib/format'
import { displayPath } from '@/lib/private-folders'
import { useQuery } from '@/lib/use-query'

/**
 * The 権限 screen's panel for a private folder itself: who can see and edit
 * it. Its rules are changed here (見られる人を変更), never with the general
 * editor — a rule set saved there would let everyone read it.
 */
export function PrivateFolderPanel({
  scope,
  name,
  departments,
  members,
  editable,
  onChanged,
  onPickSubfolder,
}: {
  scope: PermissionScope
  name: string
  departments: Department[]
  members: Member[]
  editable: boolean
  onChanged: () => void
  onPickSubfolder: (path: string) => void
}) {
  const { companyId, isAdmin } = useCompany()
  const detail = useQuery(`private-folder:${companyId}:${scope.id}`, () => privateFoldersApi.get(companyId, scope.id))
  const [editing, setEditing] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const named = (detail.data?.members ?? []).filter((m) => m.via === 'rule')
  const admins = (detail.data?.members ?? []).filter((m) => m.via === 'role')
  const label = displayPath(scope.path, departments)

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{name} の設定</h2>
            <Badge variant="brand">
              <LockSimple weight="fill" />
              非公開
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{scope.path}</p>
        </div>
        {editable && <SubfolderPicker companyId={companyId} path={scope.path} onPick={onPickSubfolder} />}
      </div>

      <section className="space-y-4 px-5 py-4">
        <p className="text-sm text-muted-foreground">
          このフォルダとその中身は、下の人にだけ届きます。ほかの人の手元には名前も中身も届きません。
        </p>

        {detail.loading ? (
          <div className="space-y-2" aria-busy="true" aria-label="読み込み中">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : detail.error ? (
          <ErrorState error={detail.error} onRetry={detail.reload} />
        ) : (
          <>
            <div className="flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Eye size={16} className="text-muted-foreground" aria-hidden="true" />
                見られる人 <span className="font-medium tabular-nums">{detail.data?.viewerCount ?? 0}人</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PencilSimple size={16} className="text-muted-foreground" aria-hidden="true" />
                編集できる人 <span className="font-medium tabular-nums">{detail.data?.editorCount ?? 0}人</span>
              </span>
            </div>
            <ul className="divide-y rounded-lg border" aria-label="見られる人">
              {named.map((m) => {
                const n = m.name || m.email || '名前未設定'
                return (
                  <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={n} seed={m.userId} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{n}</div>
                      {m.email && <div className="truncate text-xs text-muted-foreground">{m.email}</div>}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{m.canWrite ? '編集できる' : '閲覧のみ'}</span>
                  </li>
                )
              })}
              <li className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
                <span className="flex size-7 items-center justify-center rounded-full bg-muted">
                  <Users size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {admins.length > 0
                    ? `${admins.map((a) => a.name || a.email || roleLabel(a.role)).join('、')}（オーナー・管理者は常に）`
                    : 'オーナー・管理者（常に）'}
                </span>
                <span className="shrink-0 text-xs">編集できる</span>
              </li>
            </ul>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!detail.data}>
              <Users />
              見られる人を変更
            </Button>
          )}
          {isAdmin && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setPublishing(true)}>
              公開に戻す…
            </Button>
          )}
          <Link
            href={`/companies/${companyId}/private-folders`}
            className="ml-auto inline-flex items-center gap-1 rounded text-sm font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            非公開フォルダの一覧
            <ArrowRight size={14} />
          </Link>
        </div>
      </section>

      <PrivateFolderMembersDialog
        open={editing}
        onOpenChange={setEditing}
        scopeId={scope.id}
        departments={departments}
        members={members}
        onSaved={() => {
          detail.reload()
          onChanged()
        }}
      />
      <MakePublicDialog
        folder={publishing && detail.data ? detail.data : null}
        label={label}
        onOpenChange={setPublishing}
        onDone={onChanged}
      />
    </Card>
  )
}

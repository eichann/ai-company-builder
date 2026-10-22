'use client'

import { useMemo, useState } from 'react'
import { DotsThree, Eye, Info, LockSimple, MagnifyingGlass, PencilSimple, Plus, Users } from '@phosphor-icons/react'

import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { CreatePrivateFolderDialog } from '@/components/private-folders/create-dialog'
import { MakePublicDialog } from '@/components/private-folders/make-public-dialog'
import { PrivateFolderMembersDialog } from '@/components/private-folders/members-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { companiesApi, departmentsApi, privateFoldersApi, type PrivateFolderSummary } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { isForbidden } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { displayPath } from '@/lib/private-folders'
import { compareScopePaths } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'

export default function PrivateFoldersPage() {
  const { companyId, isAdmin, managedDepartmentIds } = useCompany()
  const canUse = isAdmin || managedDepartmentIds.length > 0
  const folders = useQuery(`private-folders:${companyId}`, () => privateFoldersApi.list(companyId))
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [publishing, setPublishing] = useState<PrivateFolderSummary | null>(null)
  const [query, setQuery] = useState('')

  const depts = useMemo(() => departments.data ?? [], [departments.data])
  const label = (path: string) => displayPath(path, depts)
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...(folders.data ?? [])]
      .sort((a, b) => compareScopePaths(a.path, b.path))
      .filter((f) => !q || f.path.toLowerCase().includes(q) || displayPath(f.path, depts).toLowerCase().includes(q))
  }, [folders.data, query, depts])

  const createButton = canUse && (
    <Button onClick={() => setCreating(true)} disabled={!members.data || !departments.data}>
      <Plus />
      非公開フォルダを作成
    </Button>
  )

  return (
    <>
      <PageHeader
        title="非公開フォルダ"
        description="選んだ人だけに届くフォルダです。見られない人の手元には、名前も中身も届きません。"
        actions={createButton}
      />

      <div className="mb-6 flex gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <Info size={18} className="mt-0.5 shrink-0 text-brand" />
        <div className="space-y-1">
          <p>
            いまあるフォルダを非公開に変えることはできません。守りたいファイルは、新しく作った非公開フォルダへ移してください。
            <span className="text-muted-foreground">これまでに配られた分は各メンバーの手元に残り、過去の版は会社の履歴にも残ります。</span>
          </p>
          <p className="text-muted-foreground">
            見られる人のAIは、中身を読んで公開の場所に書くことができます。アプリでは非公開フォルダに鍵のマークが付きます。
          </p>
          {!isAdmin && <p className="text-muted-foreground">あなたが責任者を務める部署の中だけで作成・変更できます。</p>}
        </div>
      </div>

      {folders.loading ? (
        <ListSkeleton rows={3} />
      ) : isForbidden(folders.error) ? (
        <EmptyState
          icon={LockSimple}
          title="非公開フォルダを扱えるのは、オーナー・管理者と部署の責任者です"
          description="非公開のフォルダが必要なときは、管理者か部署の責任者に依頼してください。"
        />
      ) : folders.error && !folders.data ? (
        <ErrorState error={folders.error} onRetry={folders.reload} />
      ) : (folders.data ?? []).length === 0 ? (
        <EmptyState
          icon={LockSimple}
          title="非公開フォルダはまだありません"
          description="人事の評価や契約書など、一部の人だけで扱うファイルは、非公開フォルダを作ってそこに置きます。"
          action={createButton}
        />
      ) : (
        <div className="space-y-3">
          {(folders.data ?? []).length > 5 && (
            <div className="relative max-w-xs">
              <MagnifyingGlass size={16} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="フォルダを検索" aria-label="フォルダを検索" className="pl-8" />
            </div>
          )}
          <Card className="overflow-hidden py-0">
            <ul aria-label="非公開フォルダ" className="divide-y">
              {rows.map((f) => (
                <li key={f.scopeId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                    <LockSimple size={18} weight="fill" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{label(f.path)}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{f.path}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-sm">
                    <span className="inline-flex items-center gap-1.5" title="見られる人（オーナー・管理者を含む）">
                      <Eye size={16} className="text-muted-foreground" aria-hidden="true" />
                      <span className="tabular-nums">{f.viewerCount}人</span>
                      <span className="sr-only">が見られる</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5" title="編集できる人（オーナー・管理者を含む）">
                      <PencilSimple size={16} className="text-muted-foreground" aria-hidden="true" />
                      <span className="tabular-nums">{f.editorCount}人</span>
                      <span className="sr-only">が編集できる</span>
                    </span>
                  </div>
                  <div className="hidden w-40 shrink-0 text-xs text-muted-foreground md:block">
                    <div className="truncate">{f.createdByName ?? '—'}</div>
                    <div>{formatDate(f.createdAt)} 作成</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => setEditing(f.scopeId)} disabled={!members.data}>
                      <Users />
                      見られる人
                    </Button>
                    {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${label(f.path)} のその他の操作`}>
                            <DotsThree size={18} weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem variant="destructive" onSelect={() => setPublishing(f)}>
                            公開に戻す…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              ))}
              {rows.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">該当するフォルダがありません</li>}
            </ul>
          </Card>
        </div>
      )}

      <CreatePrivateFolderDialog
        open={creating}
        onOpenChange={setCreating}
        departments={depts}
        members={members.data ?? []}
        onCreated={() => folders.reload()}
      />
      <PrivateFolderMembersDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        scopeId={editing}
        departments={depts}
        members={members.data ?? []}
        onSaved={() => folders.reload()}
      />
      <MakePublicDialog
        folder={publishing}
        label={publishing ? label(publishing.path) : ''}
        onOpenChange={(o) => !o && setPublishing(null)}
        onDone={() => folders.reload()}
      />
    </>
  )
}

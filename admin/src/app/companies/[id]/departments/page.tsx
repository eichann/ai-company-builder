'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowsClockwise,
  DotsSixVertical,
  DotsThree,
  Folder,
  PencilSimple,
  Plus,
  Trash,
  TreeStructure,
  UserGear,
} from '@phosphor-icons/react'

import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { DepartmentIcon } from '@/components/app/department-icon'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { DepartmentFormDialog } from '@/components/departments/department-form-dialog'
import { ManagersDialog } from '@/components/departments/managers-dialog'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { companiesApi, departmentsApi, type Department, type DepartmentManager } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useDepartmentManagers } from '@/lib/managers'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

export default function DepartmentsPage() {
  const { companyId, isAdmin, managedDepartmentIds } = useCompany()
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const managers = useDepartmentManagers(companyId, departments.data)
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Department | null>(null)
  const [managersFor, setManagersFor] = useState<Department | null>(null)
  const [deleting, setDeleting] = useState<{ department: Department; files: number; folders: number } | null>(null)
  const [importing, setImporting] = useState(false)

  const sorted = useMemo(
    () => [...(departments.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [departments.data]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = sorted.findIndex((d) => d.id === active.id)
    const to = sorted.findIndex((d) => d.id === over.id)
    const next = arrayMove(sorted, from, to).map((d, i) => ({ ...d, sortOrder: i }))
    const previous = departments.data
    departments.setData(() => next)
    try {
      await departmentsApi.reorder(
        companyId,
        next.map((d) => ({ id: d.id, sortOrder: d.sortOrder }))
      )
      toast.success('並び順を保存しました', { description: 'デスクトップアプリにも同じ順で表示されます。' })
    } catch (err) {
      departments.setData(() => previous ?? [])
      toast.error('並び順を保存できませんでした', { description: describeError(err) })
    }
  }

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openDelete = async (d: Department) => {
    try {
      const stats = await departmentsApi.stats(companyId, d.id)
      setDeleting({ department: d, files: stats.files, folders: stats.folders })
    } catch (err) {
      toast.error('フォルダの中身を確認できませんでした', { description: describeError(err) })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const { department } = deleting
    try {
      await departmentsApi.delete(companyId, department.id)
      toast.success(`「${department.name}」を削除しました`)
      setDeleting(null)
      departments.reload()
    } catch (err) {
      toast.error('部署を削除できませんでした', { description: describeError(err) })
      throw err
    }
  }

  const importFolders = async () => {
    setImporting(true)
    try {
      const res = await departmentsApi.sync(companyId)
      if (res.added === 0 && res.removed === 0) {
        toast.success('取り込む新しいフォルダはありませんでした')
      } else {
        toast.success('フォルダを取り込みました', {
          description: [res.added > 0 && `${res.added}件を部署に追加`, res.removed > 0 && `${res.removed}件の消えた部署を整理`]
            .filter(Boolean)
            .join('、'),
        })
      }
      departments.reload()
    } catch (err) {
      toast.error('フォルダを取り込めませんでした', { description: describeError(err) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="部署"
        description={
          isAdmin
            ? '部署ごとに共有フォルダがあります。ドラッグで並べ替えると、デスクトップアプリの表示順も変わります。'
            : '部署ごとに共有フォルダがあります。'
        }
        actions={
          isAdmin && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" onClick={importFolders} disabled={importing}>
                    <ArrowsClockwise className={cn(importing && 'animate-spin')} />
                    フォルダを取り込む
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  メンバーが共有フォルダの一番上に作ったフォルダを、部署として登録します
                </TooltipContent>
              </Tooltip>
              <Button onClick={openCreate}>
                <Plus />
                部署を追加
              </Button>
            </>
          )
        }
      />

      {departments.loading ? (
        <ListSkeleton rows={5} />
      ) : departments.error && !departments.data ? (
        <ErrorState error={departments.error} onRetry={departments.reload} />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={TreeStructure}
          title="部署がありません"
          description={
            isAdmin
              ? '部署を追加すると、その部署用の共有フォルダが作られます。'
              : 'オーナーか管理者が部署を追加すると、ここに表示されます。'
          }
          action={
            isAdmin && (
              <Button onClick={openCreate}>
                <Plus />
                部署を追加
              </Button>
            )
          }
        />
      ) : (
        <Card className="overflow-hidden py-0">
          {!!managers.error && (
            <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
              責任者を読み込めませんでした。
              <Button variant="ghost" size="sm" onClick={managers.reload}>
                再読み込み
              </Button>
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={sorted.map((d) => d.id)} strategy={verticalListSortingStrategy}>
              <ul className="divide-y" aria-label="部署の一覧">
                {sorted.map((d) => (
                  <DepartmentRow
                    key={d.id}
                    department={d}
                    managers={managers.data?.[d.id]}
                    managersLoading={managers.loading}
                    editable={isAdmin}
                    isMine={managedDepartmentIds.includes(d.id)}
                    onEdit={() => {
                      setEditing(d)
                      setFormOpen(true)
                    }}
                    onManagers={() => setManagersFor(d)}
                    onDelete={() => openDelete(d)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </Card>
      )}

      {isAdmin && (
        <>
          <DepartmentFormDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            companyId={companyId}
            department={editing}
            onSaved={() => departments.reload()}
          />
          <ManagersDialog
            open={managersFor !== null}
            onOpenChange={(open) => !open && setManagersFor(null)}
            companyId={companyId}
            department={managersFor}
            current={(managersFor && managers.data?.[managersFor.id]) || []}
            members={members.data ?? []}
            onSaved={(list) =>
              managersFor && managers.setData((prev) => ({ ...(prev ?? {}), [managersFor.id]: list }))
            }
          />
          <ConfirmByTypingDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`「${deleting?.department.name ?? ''}」を削除`}
            description={
              <div className="space-y-2">
                <p>
                  共有フォルダ <span className="font-mono text-foreground">{deleting?.department.folder}</span>{' '}
                  {deleting && deleting.files + deleting.folders > 0
                    ? `と、その中のファイル${deleting.files}件・フォルダ${deleting.folders}件`
                    : '（空のフォルダ）'}
                  がサーバーから削除されます。
                </p>
                <p>
                  メンバーのPCからも次回の同期で削除されます。同期していない変更がある人の分は、その人のPCの
                  .backups フォルダに残ります。この操作は取り消せません。
                </p>
              </div>
            }
            confirmText={deleting?.department.name ?? ''}
            confirmLabel="部署を削除"
            onConfirm={confirmDelete}
          />
        </>
      )}
    </>
  )
}

function DepartmentRow({
  department: d,
  managers,
  managersLoading,
  editable,
  isMine,
  onEdit,
  onManagers,
  onDelete,
}: {
  department: Department
  managers: DepartmentManager[] | undefined
  managersLoading: boolean
  editable: boolean
  isMine: boolean
  onEdit: () => void
  onManagers: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: d.id,
    disabled: !editable,
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative flex items-center gap-3 bg-card px-4 py-3',
        isDragging && 'z-10 shadow-lg ring-1 ring-border'
      )}
    >
      {editable && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`${d.name} を並べ替え（スペースで持ち上げ、矢印キーで移動）`}
          className="-ml-1.5 flex h-8 w-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
        >
          <DotsSixVertical size={18} weight="bold" />
        </button>
      )}
      <DepartmentIcon icon={d.icon} color={d.color} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{d.name}</span>
          {d.folder !== d.name && (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" title="共有フォルダ名">
              <Folder size={12} />
              {d.folder}
            </span>
          )}
          {isMine && <Badge variant="brand">あなたが責任者</Badge>}
        </div>
        {d.description && <p className="truncate text-sm text-muted-foreground">{d.description}</p>}
      </div>

      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        {managersLoading ? (
          <span className="text-sm text-muted-foreground">…</span>
        ) : managers && managers.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-2 text-sm" tabIndex={0}>
                <span className="flex -space-x-1.5">
                  {managers.slice(0, 3).map((m) => (
                    <Avatar key={m.userId} name={m.name || m.email || '?'} seed={m.userId} className="size-6 text-[10px] ring-2 ring-card" />
                  ))}
                </span>
                <span className="max-w-40 truncate">
                  {managers.length === 1 ? managers[0].name || managers[0].email : `${managers[0].name || managers[0].email} ほか${managers.length - 1}人`}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>責任者: {managers.map((m) => m.name || m.email).join('、')}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-sm text-muted-foreground">責任者なし</span>
        )}
      </div>

      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${d.name} の操作`}>
              <DotsThree size={18} weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onEdit}>
              <PencilSimple />
              名前・表示を編集
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onManagers}>
              <UserGear />
              責任者を設定
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash />
              部署を削除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}

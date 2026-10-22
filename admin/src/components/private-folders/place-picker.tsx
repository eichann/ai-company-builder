'use client'

import { Buildings, CaretRight, Folder, LockSimple } from '@phosphor-icons/react'

import { DepartmentIcon } from '@/components/app/department-icon'
import { Skeleton } from '@/components/ui/skeleton'
import { permissionsApi, type Department } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { isSameOrAncestorPath, pathSegments } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

export interface PlaceRoot {
  /** '' = the company root. */
  path: string
  label: string
  department?: Department
}

/**
 * Where the new private folder goes: a breadcrumb from one of `roots` (the
 * company root for owners/admins, the managed departments for managers) and
 * the folders inside the current place, as the server has them. Private
 * folders are shown locked: nothing private can be created inside one.
 */
export function PlacePicker({
  companyId,
  roots,
  value,
  onChange,
  disabled,
}: {
  companyId: string
  roots: PlaceRoot[]
  /** The parent folder; null = choosing among `roots`. */
  value: string | null
  onChange: (path: string | null) => void
  disabled?: boolean
}) {
  const atChooser = value === null
  const root = atChooser ? roots[0] : roots.find((r) => isSameOrAncestorPath(r.path, value)) ?? roots[0]
  const folders = useQuery(value !== null && root ? `perm-folders:${companyId}:${value}` : null, () =>
    permissionsApi.folders(companyId, value ?? '')
  )

  if (!root) return <p className="text-sm text-muted-foreground">非公開フォルダを作れる場所がありません。</p>

  const crumbs = [
    { path: root.path, label: root.label },
    ...pathSegments(value ?? '')
      .slice(pathSegments(root.path).length)
      .map((seg, i, rest) => ({ path: [...pathSegments(root.path), ...rest.slice(0, i + 1)].join('/'), label: seg })),
  ]

  return (
    <div className="overflow-hidden rounded-lg border">
      <nav aria-label="作成する場所" className="flex min-h-10 flex-wrap items-center gap-0.5 border-b bg-muted/40 px-2 py-1.5 text-sm">
        {roots.length > 1 && (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(null)}
              className="rounded px-1.5 py-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              部署
            </button>
            {!atChooser && <CaretRight size={12} className="text-muted-foreground" aria-hidden="true" />}
          </>
        )}
        {!atChooser &&
          crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={c.path} className="flex items-center gap-0.5">
                <button
                  type="button"
                  disabled={disabled || last}
                  aria-current={last ? 'location' : undefined}
                  onClick={() => onChange(c.path)}
                  className={cn(
                    'max-w-48 truncate rounded px-1.5 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    last ? 'font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {c.label}
                </button>
                {!last && <CaretRight size={12} className="text-muted-foreground" aria-hidden="true" />}
              </span>
            )
          })}
      </nav>

      <div className="max-h-48 overflow-y-auto p-1">
        {atChooser ? (
          <ul aria-label="部署を選ぶ">
            {roots.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(r.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {r.department ? (
                    <DepartmentIcon icon={r.department.icon} color={r.department.color} size="sm" />
                  ) : (
                    <Buildings size={18} className="text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  <CaretRight size={12} className="text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : folders.loading ? (
          <div className="space-y-1.5 p-1.5" aria-busy="true" aria-label="読み込み中">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : folders.error ? (
          <p className="p-2 text-sm text-muted-foreground">{describeError(folders.error)}</p>
        ) : (folders.data?.folders ?? []).length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">この中にフォルダはありません。ここに作成できます。</p>
        ) : (
          <ul aria-label="中のフォルダ">
            {(folders.data?.folders ?? []).map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  disabled={disabled || f.private}
                  onClick={() => onChange(f.path)}
                  title={f.private ? '非公開フォルダの中には、非公開フォルダを作れません' : undefined}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  {f.private ? (
                    <LockSimple size={16} weight="fill" className="text-brand" aria-label="非公開" />
                  ) : (
                    <Folder size={16} className="text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {f.private ? (
                    <span className="text-xs text-muted-foreground">非公開</span>
                  ) : (
                    <CaretRight size={12} className="text-muted-foreground" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

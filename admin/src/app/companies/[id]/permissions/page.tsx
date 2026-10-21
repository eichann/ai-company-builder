'use client'

import { useMemo, useRef, useState } from 'react'
import { Buildings, CaretDown, CaretRight, Folder, Info, LockSimple, ShieldCheck } from '@phosphor-icons/react'

import { DepartmentIcon } from '@/components/app/department-icon'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { ScopeEditor, type EditorNode } from '@/components/permissions/scope-editor'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  companiesApi,
  departmentsApi,
  permissionsApi,
  type Department,
  type EffectiveSummary,
  type PermissionScope,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { isForbidden } from '@/lib/errors'
import { SUMMARY_LABELS } from '@/lib/permission-labels'
import { compareScopePaths, deepestAncestor, isSameOrAncestorPath, pathSegments } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const SUMMARY_BADGE: Record<EffectiveSummary, 'success' | 'warning' | 'brand'> = {
  'everyone-rw': 'success',
  'everyone-r': 'brand',
  restricted: 'warning',
}

const TREE_BADGE_LABELS: Record<EffectiveSummary, string> = {
  'everyone-rw': '全員が編集',
  'everyone-r': '一部が編集',
  restricted: '制限あり',
}

interface Node extends EditorNode {
  depth: number
  department: Department | undefined
  hasChildren: boolean
  summary: EffectiveSummary
}

function depthOf(path: string): number {
  return pathSegments(path).length
}

export default function PermissionsPage() {
  const { companyId, company, isAdmin, managedDepartmentIds } = useCompany()
  const permissions = useQuery(`permissions:${companyId}`, () => permissionsApi.get(companyId))
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Sub-folders picked in the editor that have no scope (yet). */
  const [extraPaths, setExtraPaths] = useState<string[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLUListElement>(null)

  const scopes = useMemo(() => permissions.data?.scopes ?? [], [permissions.data])

  const managedFolders = useMemo(
    () => (departments.data ?? []).filter((d) => managedDepartmentIds.includes(d.id)).map((d) => d.folder.normalize('NFC')),
    [departments.data, managedDepartmentIds]
  )

  const nodes = useMemo<Node[]>(() => {
    const byPath = new Map(scopes.map((s) => [s.path, s]))
    const deptById = new Map((departments.data ?? []).map((d) => [d.id, d]))
    const deptByFolder = new Map((departments.data ?? []).map((d) => [d.folder.normalize('NFC'), d]))
    const scopePaths = scopes.map((s) => s.path)
    const paths = [...new Set([...scopePaths, ...extraPaths])].sort(compareScopePaths)
    // Managers receive only their departments' subtrees: indent from the top
    // of what was returned rather than from the company root.
    const base = Math.min(...paths.map(depthOf))
    return paths.map((path, i) => {
      const scope: PermissionScope | undefined = byPath.get(path)
      const department = scope?.departmentId ? deptById.get(scope.departmentId) : deptByFolder.get(path)
      const nearest = byPath.get(deepestAncestor(scopePaths, path) ?? '')
      const next = paths[i + 1]
      const name =
        path === ''
          ? company.data?.name ?? '会社全体'
          : scope?.kind === 'department' || (!scope && department)
            ? department?.name ?? pathSegments(path).at(-1) ?? path
            : pathSegments(path).at(-1) ?? path
      return {
        path,
        scope,
        name,
        kind: scope?.kind ?? (path === '' ? 'company' : 'folder'),
        depth: depthOf(path) - base,
        department,
        hasChildren: !!next && isSameOrAncestorPath(path, next) && next !== path,
        summary: (scope ?? nearest)?.effectiveSummary ?? 'restricted',
      }
    })
  }, [scopes, extraPaths, departments.data, company.data])

  // Hide descendants of collapsed nodes (nodes are in tree order).
  const visible = useMemo(() => {
    const out: Node[] = []
    let hideBelow: string | null = null
    for (const n of nodes) {
      if (hideBelow !== null && isSameOrAncestorPath(hideBelow, n.path) && n.path !== hideBelow) continue
      hideBelow = collapsed.has(n.path) ? n.path : null
      out.push(n)
    }
    return out
  }, [nodes, collapsed])

  const selected = nodes.find((n) => n.path === selectedPath) ?? nodes[0]

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const select = (path: string, focusEditor = false) => {
    setSelectedPath(path)
    if (focusEditor && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }

  const canEdit = (path: string) => isAdmin || managedFolders.some((f) => isSameOrAncestorPath(f, path))

  const nameOf = (path: string) =>
    nodes.find((n) => n.path === path)?.name ?? (pathSegments(path).at(-1) || company.data?.name || '会社全体')

  const companyScope = scopes.find((s) => s.kind === 'company')
  const explicitCount = scopes.filter((s) => s.kind !== 'company' && !s.inherited).length

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const buttons = Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>('[data-tree-row]') ?? [])
    const i = buttons.findIndex((b) => b === document.activeElement)
    if (i === -1) return
    e.preventDefault()
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
    buttons[j]?.focus()
    const path = buttons[j]?.dataset.path
    if (path !== undefined) select(path)
  }

  return (
    <>
      <PageHeader title="権限" description="会社・部署・フォルダごとに、編集できる人を選びます。" />

      <div className="mb-6 flex gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <Info size={18} className="mt-0.5 shrink-0 text-brand" />
        <div className="space-y-1">
          <p>
            場所ごとに<strong className="font-medium">「上の階層と同じ」「全員」「指定した人だけ」</strong>から編集できる人を選べます。選ばれなかった人は閲覧のみになります。閲覧そのものを制限する（見せない）設定は、今後のアップデートで対応予定です。
          </p>
          <p className="text-muted-foreground">オーナーと管理者は、ルールに関係なく常にすべての場所を閲覧・編集できます。</p>
          {!isAdmin && <p className="text-muted-foreground">あなたが責任者を務める部署と、その中のフォルダだけを表示・変更できます。</p>}
        </div>
      </div>

      {permissions.loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <ListSkeleton rows={4} />
        </div>
      ) : isForbidden(permissions.error) ? (
        <EmptyState
          icon={LockSimple}
          title="権限を確認できるのは、オーナー・管理者と部署の責任者です"
          description="変更が必要なときは、管理者か部署の責任者に依頼してください。"
        />
      ) : permissions.error && !permissions.data ? (
        <ErrorState error={permissions.error} onRetry={permissions.reload} />
      ) : nodes.length === 0 || !selected ? (
        <EmptyState icon={ShieldCheck} title="権限の情報がありません" description="会社の共有フォルダがまだ作られていない可能性があります。" />
      ) : (
        <div className="space-y-6">
          {companyScope && (
            <Card className="flex-row items-center gap-4 px-5 py-5">
              <span
                className={cn(
                  'flex size-11 shrink-0 items-center justify-center rounded-xl',
                  companyScope.effectiveSummary === 'everyone-rw' ? 'bg-success/10 text-success' : 'bg-brand/10 text-brand'
                )}
              >
                <ShieldCheck size={24} weight="fill" />
              </span>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">会社全体の基本ルール</div>
                <div className="text-lg font-semibold">{SUMMARY_LABELS[companyScope.effectiveSummary]}</div>
                <p className="text-sm text-muted-foreground">
                  {explicitCount === 0
                    ? '個別のルールはありません。すべての部署・フォルダにこのルールが適用されます。'
                    : `${explicitCount}か所に個別のルールがあり、それ以外はこのルールが適用されます。`}
                </p>
              </div>
            </Card>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Card className="overflow-hidden py-0 lg:sticky lg:top-6">
              <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-muted-foreground">
                <span>場所</span>
                <span>現在のルール</span>
              </div>
              <ul ref={treeRef} role="tree" aria-label="権限を設定する場所" onKeyDown={onTreeKeyDown}>
                {visible.map((n) => (
                  <TreeRow
                    key={n.path}
                    node={n}
                    selected={n.path === selected.path}
                    expanded={!collapsed.has(n.path)}
                    onToggle={() => toggle(n.path)}
                    onSelect={() => select(n.path, true)}
                  />
                ))}
              </ul>
            </Card>

            <div ref={editorRef} className="scroll-mt-16">
              <ScopeEditor
                // A fresh draft whenever the saved rules of this place change.
                key={`${selected.path}\u0000${JSON.stringify(selected.scope?.rules ?? [])}`}
                companyId={companyId}
                node={selected}
                scopes={scopes}
                members={members.data ?? []}
                departments={departments.data ?? []}
                editable={canEdit(selected.path)}
                nameOf={nameOf}
                onChanged={permissions.reload}
                onPickSubfolder={(path) => {
                  setExtraPaths((prev) => (prev.includes(path) ? prev : [...prev, path]))
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    next.delete(selected.path)
                    return next
                  })
                  select(path)
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function TreeRow({
  node,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: Node
  selected: boolean
  expanded: boolean
  onToggle: () => void
  onSelect: () => void
}) {
  const { scope, depth, name, department, hasChildren, path, kind } = node
  const inherited = !scope || scope.inherited

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      className={cn('border-b last:border-b-0', selected && 'bg-accent/60')}
    >
      <div className="flex items-center gap-1.5 py-1.5 pr-3" style={{ paddingLeft: `${10 + depth * 20}px` }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={onToggle}
            tabIndex={-1}
            aria-label={expanded ? `${name} を折りたたむ` : `${name} を展開`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {expanded ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          data-tree-row
          data-path={path}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (hasChildren && ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded))) {
              e.preventDefault()
              onToggle()
            }
          }}
          aria-current={selected ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="shrink-0">
            {kind === 'company' ? (
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Buildings size={14} weight="fill" />
              </span>
            ) : department && (kind === 'department' || !scope) && department.folder.normalize('NFC') === path ? (
              <DepartmentIcon icon={department.icon} color={department.color} size="sm" />
            ) : (
              <span className="flex size-6 items-center justify-center text-muted-foreground">
                <Folder size={18} />
              </span>
            )}
          </span>
          <span className={cn('min-w-0 flex-1 truncate text-sm', kind !== 'folder' && 'font-medium')}>{name}</span>
          {inherited ? (
            <span className="shrink-0 text-xs text-muted-foreground">継承</span>
          ) : (
            <Badge variant={SUMMARY_BADGE[node.summary]} className="shrink-0">
              {TREE_BADGE_LABELS[node.summary]}
            </Badge>
          )}
        </button>
      </div>
    </li>
  )
}

'use client'

import { useMemo, useState } from 'react'
import { Buildings, CaretDown, CaretRight, Folder, Info, LockSimple, ShieldCheck } from '@phosphor-icons/react'

import { DepartmentIcon } from '@/components/app/department-icon'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  departmentsApi,
  permissionsApi,
  type Department,
  type EffectiveSummary,
  type PermissionScope,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { isForbidden } from '@/lib/errors'
import { SUMMARY_LABELS, ruleAccessLabel } from '@/lib/permission-labels'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const SUMMARY_BADGE: Record<EffectiveSummary, 'success' | 'warning' | 'brand'> = {
  'everyone-rw': 'success',
  'everyone-r': 'brand',
  restricted: 'warning',
}

interface Node {
  scope: PermissionScope
  depth: number
  name: string
  department: Department | undefined
  hasChildren: boolean
}

function depthOf(scope: PermissionScope): number {
  if (scope.kind === 'company') return 0
  return Math.max(1, scope.path.split('/').filter(Boolean).length)
}

export default function PermissionsPage() {
  const { companyId, company, isAdmin } = useCompany()
  const permissions = useQuery(`permissions:${companyId}`, () => permissionsApi.get(companyId))
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const nodes = useMemo<Node[]>(() => {
    const scopes = permissions.data?.scopes ?? []
    const deptById = new Map((departments.data ?? []).map((d) => [d.id, d]))
    // Managers receive only their departments' subtrees: indent from the top
    // of what was returned rather than from the company root.
    const base = Math.min(...scopes.map(depthOf))
    return scopes.map((scope, i) => {
      const depth = depthOf(scope) - base
      const next = scopes[i + 1]
      const department = scope.departmentId ? deptById.get(scope.departmentId) : undefined
      const segments = scope.path.split('/').filter(Boolean)
      const name =
        scope.kind === 'company'
          ? company.data?.name ?? '会社全体'
          : scope.kind === 'department'
            ? department?.name ?? segments.at(-1) ?? scope.path
            : segments.at(-1) ?? scope.path
      return { scope, depth, name, department, hasChildren: !!next && depthOf(next) - base > depth }
    })
  }, [permissions.data, departments.data, company.data])

  // Hide descendants of collapsed nodes (scopes arrive in tree order).
  const visible = useMemo(() => {
    const out: Node[] = []
    let hideBelow: number | null = null
    for (const n of nodes) {
      if (hideBelow !== null && n.depth > hideBelow) continue
      hideBelow = collapsed.has(n.scope.id) ? n.depth : null
      out.push(n)
    }
    return out
  }, [nodes, collapsed])

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const companyScope = nodes.find((n) => n.scope.kind === 'company')?.scope
  const explicitCount = nodes.filter((n) => n.scope.kind !== 'company' && !n.scope.inherited).length

  return (
    <>
      <PageHeader title="権限" description="会社・部署・フォルダごとに、誰が閲覧・編集できるかを確認できます。" />

      <div className="mb-6 flex gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <Info size={18} className="mt-0.5 shrink-0 text-brand" />
        <div className="space-y-1">
          <p>現在は確認のみできます。権限の変更は今後のアップデートで追加されます。</p>
          {!isAdmin && <p className="text-muted-foreground">あなたが責任者を務める部署だけを表示しています。</p>}
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
          description="確認が必要なときは、管理者に依頼してください。"
        />
      ) : permissions.error && !permissions.data ? (
        <ErrorState error={permissions.error} onRetry={permissions.reload} />
      ) : nodes.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="権限の情報がありません" description="会社の共有フォルダがまだ作られていない可能性があります。" />
      ) : (
        <div className="space-y-6">
          {companyScope && (
            <Card className="flex-row items-center gap-4 px-5 py-5">
              <span
                className={cn(
                  'flex size-11 shrink-0 items-center justify-center rounded-xl',
                  companyScope.effectiveSummary === 'everyone-rw' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
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

          <Card className="overflow-hidden py-0">
            <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-muted-foreground">
              <span>場所</span>
              <span>アクセスできる人</span>
            </div>
            <ul role="tree" aria-label="権限の一覧">
              {visible.map((n) => (
                <ScopeRow
                  key={n.scope.id}
                  node={n}
                  expanded={!collapsed.has(n.scope.id)}
                  onToggle={() => toggle(n.scope.id)}
                />
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  )
}

function ScopeRow({ node, expanded, onToggle }: { node: Node; expanded: boolean; onToggle: () => void }) {
  const { scope, depth, name, department, hasChildren } = node
  const explicitRules = scope.inherited ? [] : scope.rules

  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={false}
      className="border-b last:border-b-0"
    >
      <div className="flex items-start gap-2 py-2.5 pr-4" style={{ paddingLeft: `${16 + depth * 22}px` }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? `${name} を折りたたむ` : `${name} を展開`}
            className="mt-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {expanded ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <span className="mt-0.5">
          {scope.kind === 'company' ? (
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Buildings size={14} weight="fill" />
            </span>
          ) : scope.kind === 'department' && department ? (
            <DepartmentIcon icon={department.icon} color={department.color} size="sm" />
          ) : (
            <span className="flex size-6 items-center justify-center text-muted-foreground">
              <Folder size={18} />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className={cn('text-sm', scope.kind !== 'folder' && 'font-medium')}>{name}</span>
            {scope.kind !== 'company' && scope.path !== name && <span className="truncate font-mono text-xs text-muted-foreground">{scope.path}</span>}
          </div>
          {explicitRules.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="このフォルダのルール">
              {explicitRules.map((r) => (
                <li key={r.id} className="rounded-md border bg-background px-1.5 py-0.5 text-xs">
                  {r.subjectLabel}: <span className="font-medium">{ruleAccessLabel(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          {scope.inherited ? (
            <span className="text-xs text-muted-foreground">継承 · {SUMMARY_LABELS[scope.effectiveSummary]}</span>
          ) : (
            <Badge variant={SUMMARY_BADGE[scope.effectiveSummary]}>{SUMMARY_LABELS[scope.effectiveSummary]}</Badge>
          )}
        </div>
      </div>
    </li>
  )
}

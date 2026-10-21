'use client'

import { useMemo, useState } from 'react'
import { Check, Minus } from '@phosphor-icons/react'

import { ErrorState } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { EffectiveAccess, EffectiveMember } from '@/lib/api'
import { roleLabel } from '@/lib/format'
import type { QueryResult } from '@/lib/use-query'

const COLLAPSED_ROWS = 6

function reasonText(m: EffectiveMember, here: string, nameOf: (path: string) => string): string {
  if (m.reason === 'role') return `${roleLabel(m.role)}は常に編集できます`
  if (!m.decidedBy) return 'あてはまるルールがありません'
  const where = m.decidedBy.path === here ? 'この場所' : `「${nameOf(m.decidedBy.path)}」`
  return `${where}の「${m.decidedBy.subjectLabel}」のルール`
}

/**
 * Who can do what at the selected place, and which rule decided it: the
 * server's answer for what is saved, or `draft` (computed in the browser)
 * while an unsaved choice is shown.
 */
export function EffectivePreview({
  effective,
  draft,
  path,
  nameOf,
}: {
  effective: QueryResult<EffectiveAccess>
  draft?: EffectiveMember[] | null
  path: string
  nameOf: (path: string) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const members = useMemo(() => {
    const list = draft ?? effective.data?.members ?? []
    // Members who cannot edit first: that is what an editor usually checks.
    return [...list].sort((a, b) => Number(a.write) - Number(b.write) || (a.name ?? '').localeCompare(b.name ?? '', 'ja'))
  }, [effective.data, draft])

  if (!draft && effective.loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="読み込み中">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    )
  }
  if (!draft && effective.error && !effective.data) {
    return <ErrorState error={effective.error} onRetry={effective.reload} title="プレビューを読み込めませんでした" className="py-6" />
  }

  const editors = members.filter((m) => m.write).length
  const shown = expanded ? members : members.slice(0, COLLAPSED_ROWS)

  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-sm text-muted-foreground">
        編集できる <span className="font-medium text-foreground tabular-nums">{editors}人</span> · 閲覧のみ{' '}
        <span className="font-medium text-foreground tabular-nums">{members.length - editors}人</span>
        {draft ? (
          <span className="ml-2 inline-block rounded-full bg-warning/10 whitespace-nowrap px-2 py-0.5 text-xs text-warning">保存前のプレビュー</span>
        ) : (
          effective.fetching && <span className="ml-2 text-xs">更新中…</span>
        )}
      </p>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">この場所での各メンバーの権限</caption>
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-normal">メンバー</th>
              <th scope="col" className="px-2 py-2 text-center font-normal">閲覧</th>
              <th scope="col" className="px-2 py-2 text-center font-normal">編集</th>
              <th scope="col" className="hidden px-3 py-2 text-left font-normal sm:table-cell">理由</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((m) => {
              const name = m.name || m.email || '名前未設定'
              return (
                <tr key={m.userId}>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar name={name} seed={m.userId} className="size-6 text-[10px]" />
                      <div className="min-w-0">
                        <div className="truncate">{name}</div>
                        <div className="truncate text-xs text-muted-foreground sm:hidden">{reasonText(m, path, nameOf)}</div>
                      </div>
                      {m.role !== 'member' && <Badge variant="outline" className="hidden md:inline-flex">{roleLabel(m.role)}</Badge>}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Mark on={m.read || !(effective.data?.readRestrictionEnforced ?? false)} label="閲覧" />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Mark on={m.write} label="編集" />
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-muted-foreground sm:table-cell">{reasonText(m, path, nameOf)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {members.length > COLLAPSED_ROWS && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '折りたたむ' : `すべて表示（${members.length}人）`}
        </Button>
      )}
    </div>
  )
}

function Mark({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span className="inline-flex text-success">
      <Check size={16} weight="bold" aria-hidden="true" />
      <span className="sr-only">{label}できる</span>
    </span>
  ) : (
    <span className="inline-flex text-muted-foreground/60">
      <Minus size={16} aria-hidden="true" />
      <span className="sr-only">{label}できない</span>
    </span>
  )
}

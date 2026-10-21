'use client'

import type { ReactNode } from 'react'
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/errors'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon: IconComponent,
  title,
  description,
  action,
  className,
}: {
  icon: Icon
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center',
        className
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <IconComponent size={20} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
  title = '読み込めませんでした',
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center',
        className
      )}
    >
      <WarningCircle size={24} className="text-destructive" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{describeError(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <ArrowClockwise />
          再読み込み
        </Button>
      )}
    </div>
  )
}

/** Table-shaped placeholder while a list loads. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y rounded-xl border bg-card', className)} aria-busy="true" aria-label="読み込み中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Full-screen centered spinner-free placeholder used before auth resolves. */
export function FullPageLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
      <span className="sr-only">読み込み中</span>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-2 animate-pulse rounded-full bg-muted-foreground/60" />
        読み込み中…
      </div>
    </div>
  )
}

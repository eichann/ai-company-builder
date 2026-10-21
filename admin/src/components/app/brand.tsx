import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg bg-primary text-[13px] font-bold tracking-tight text-primary-foreground',
        className
      )}
    >
      AI
    </span>
  )
}

/** Centered single-card layout for sign-in, invitations and company creation. */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <BrandMark />
        <div className="leading-tight">
          <div className="text-sm font-semibold">AI Company Builder</div>
          <div className="text-xs text-muted-foreground">管理画面</div>
        </div>
      </div>
      <div className="w-full max-w-sm">{children}</div>
      {footer && <div className="mt-6 text-center text-xs text-muted-foreground">{footer}</div>}
    </main>
  )
}

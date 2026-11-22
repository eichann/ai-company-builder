'use client'

import { useState } from 'react'
import Link from 'next/link'
import { HandPalm, PauseCircle } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { useCompany } from '@/lib/company-context'
import { stopBy } from '@/lib/agent-stop'
import { formatDateTime } from '@/lib/format'
import { useAgentStops } from './agent-stop-context'
import { StopDialog } from './stop-dialog'

/**
 * On every page, for owners and admins: 「AI を止める」, and while something is
 * stopped a line saying so with a link to the list (release, history).
 */
export function StopBar() {
  const { companyId, isAdmin } = useCompany()
  const stops = useAgentStops()
  const [open, setOpen] = useState(false)
  if (!isAdmin) return null
  const active = stops?.data?.active.length ?? 0
  // Who stopped it and when (the newest stop): a person stopped it, so the band is grey, not red
  // (owner decision 2026-11-21, design-system.md P2b).
  const newest = stops?.data?.active[0]

  return (
    <div
      className={
        active > 0
          ? 'mb-6 flex flex-wrap items-center gap-3 rounded-control border border-paused-border bg-paused-bg px-4 py-2.5 text-sm text-paused-text'
          : 'mb-6 flex flex-wrap items-center justify-end gap-3 text-sm'
      }
    >
      {active > 0 && (
        <p role="status" data-stopped="paused" className="flex flex-1 items-center gap-2 font-medium">
          <PauseCircle size={18} weight="fill" aria-hidden className="shrink-0 text-paused-icon" />
          <span>
          AI を止めています（{active} 件{newest ? `・${stopBy(newest)}・${formatDateTime(newest.stoppedAt)}` : ''}）。
          <Link href={`/companies/${companyId}/advanced/ai-safety/stop`} className="ml-1 underline underline-offset-2">
            一覧と解除
          </Link>
          </span>
        </p>
      )}
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <HandPalm size={16} />
        AI を止める
      </Button>
      <StopDialog open={open} onOpenChange={setOpen} onStopped={(view) => stops?.setData(() => view)} />
    </div>
  )
}

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { HandPalm } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { useCompany } from '@/lib/company-context'
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

  return (
    <div
      className={
        active > 0
          ? 'mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm'
          : 'mb-6 flex flex-wrap items-center justify-end gap-3 text-sm'
      }
    >
      {active > 0 && (
        <p role="status" className="flex-1 font-medium text-destructive">
          AI を止めています（{active} 件）。
          <Link href={`/companies/${companyId}/agent-stop`} className="ml-1 underline underline-offset-2">
            一覧と解除
          </Link>
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

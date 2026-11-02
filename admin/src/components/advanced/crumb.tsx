'use client'

import Link from 'next/link'
import { CaretLeft } from '@phosphor-icons/react'

import { useCompany } from '@/lib/company-context'

/** The way back from a page inside 「詳しい設定」 (管理画面の見直し 2-3): 「詳しい設定」 or 「詳しい設定 › AI の安全」. */
export function AdvancedCrumb({ aiSafety = false }: { aiSafety?: boolean }) {
  const { companyId } = useCompany()
  const base = `/companies/${companyId}/advanced`
  const link = 'rounded underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'
  return (
    <nav aria-label="いまの場所" className="mb-3 flex items-center gap-1 text-xs text-muted-foreground">
      <CaretLeft size={12} />
      <Link href={base} className={link}>
        詳しい設定
      </Link>
      {aiSafety && (
        <>
          <span aria-hidden="true">›</span>
          <Link href={`${base}/ai-safety`} className={link}>
            AI の安全
          </Link>
        </>
      )}
    </nav>
  )
}

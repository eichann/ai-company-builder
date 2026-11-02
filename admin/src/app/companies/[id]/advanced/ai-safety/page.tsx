'use client'

import Link from 'next/link'
import { Barricade, CaretRight, ChatsCircle, HandPalm, Key, LockSimple, Robot } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { AdvancedCrumb } from '@/components/advanced/crumb'
import { EmptyState, PageHeader } from '@/components/app/states'
import { useCompany } from '@/lib/company-context'

/**
 * 「詳しい設定 › AI の安全」 (管理画面の見直し 2-4): the four menu items 「AI の緊急停止」
 * 「AI の操作の記録」「AI の囲い」「API キー」 as one heading, plus 「もう一方の AI に聞く」
 * (owner decision 2026-11-02). 「すべての鍵を止める」 is only on
 * 「AI を止める」 (one place).
 */
const AI_SAFETY_PAGES: Array<{ segment: string; title: string; description: string; icon: Icon }> = [
  { segment: 'stop', title: 'AI を止める', description: '会社全体や1人の AI を止める・解除する、すべての鍵を今すぐ止める、これまでの停止と解除', icon: HandPalm },
  { segment: 'events', title: 'AI の操作の記録', description: 'AI がしたことの記録、残す期間と見られる人', icon: Robot },
  { segment: 'sandbox', title: 'AI の囲い', description: 'AI が読める場所とつないでよい宛先（初めは「使わない」）', icon: Barricade },
  { segment: 'keys', title: 'API キー', description: '会社の鍵・メンバーの自分の鍵・サービスごとの決め方・登録したサービス', icon: Key },
  { segment: 'second-opinion', title: 'もう一方の AI に聞く', description: '相談の中で名前を書いたときだけ、もう一方の AI に読むだけで聞きます。会社の中身がもう一方の会社にも渡ります（初めは「聞かない」）', icon: ChatsCircle },
]

export default function AiSafetyPage() {
  const { companyId, isAdmin, role } = useCompany()
  return (
    <>
      <AdvancedCrumb />
      <PageHeader title="AI の安全" description="ふだんは触らなくても困りません。もしものときは、どのページの上にもある［AI を止める］から止められます。" />
      {role !== null && !isAdmin ? (
        <EmptyState icon={LockSimple} title="このページはオーナーと管理者だけが使えます" />
      ) : (
        <ul aria-label="AI の安全" className="divide-y overflow-hidden rounded-xl border bg-card">
          {AI_SAFETY_PAGES.map((p) => (
            <li key={p.segment}>
              <Link
                href={`/companies/${companyId}/advanced/ai-safety/${p.segment}`}
                className="flex items-center gap-3 px-5 py-4 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <p.icon size={18} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{p.title}</div>
                  <div className="text-xs text-muted-foreground">{p.description}</div>
                </div>
                <CaretRight size={14} className="shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

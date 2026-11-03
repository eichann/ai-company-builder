'use client'

// 「同じ会議から重複して作られたもの」 (minutes.md "Outputs made once"): what one meeting's reading
// made twice before the reading made each item once (same meeting, kind and name). The owner/admin
// keeps one; the others are cancelled (タスク) or retracted (決めたこと) with a note naming the kept
// one — nothing is deleted. Mail drafts are only listed: their author discards them in the app.
import { useState } from 'react'
import { toast } from 'sonner'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { meetingDuplicatesApi, type MeetingDuplicateGroup } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const KIND: Record<string, string> = { task: 'タスク', decision: '決めたこと', outbound_message: 'メールの下書き' }

export function MeetingDuplicatesSection() {
  const { companyId } = useCompany()
  const list = useQuery(`meeting-duplicates:${companyId}`, () => meetingDuplicatesApi.list(companyId))
  const [busy, setBusy] = useState<string | null>(null)

  async function merge(g: MeetingDuplicateGroup) {
    setBusy(g.keep.id)
    try {
      const r = await meetingDuplicatesApi.merge(companyId, g.keep.id, g.duplicates.map(d => d.id))
      if (r.failed.length > 0) toast.error(`${r.failed.length}件はまとめられませんでした（状態が変わった可能性があります）。`)
      else toast.success(`「${g.keep.title}」を残し、${r.merged.length}件を使わないものにしました。`)
      list.reload()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card data-testid="meeting-duplicates">
      <CardHeader>
        <CardTitle className="text-base">同じ会議から重複して作られたもの</CardTitle>
        <CardDescription>
          議事録を読み直したときに、同じ会議から同じ名前で2回以上作られたものです。いちばん古いものを残し、ほかは「使わない」にします（消しません。経緯に残したものの名前が残ります）。
        </CardDescription>
      </CardHeader>
      <div className="space-y-2 px-6 pb-6">
        {list.loading && !list.data ? <ListSkeleton rows={2} />
          : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
            : list.data && list.data.groups.length === 0 ? <p className="text-sm text-muted-foreground">重複はありません。</p>
              : list.data?.groups.map(g => (
                <div key={g.keep.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{g.keep.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {KIND[g.type] ?? g.type}・{g.duplicates.length + 1}件・会議「{g.meetingTitle}」
                    </div>
                  </div>
                  {g.mergeable
                    ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void merge(g)}>1件にまとめる</Button>
                    : <span className="text-xs text-muted-foreground">作った人がアプリで取り消します</span>}
                </div>
              ))}
      </div>
    </Card>
  )
}

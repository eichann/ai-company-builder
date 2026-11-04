'use client'

// 「つなぎ先」→「Google」→「会議の記録」 (`.claude/rules/minutes.md` "Meetings for their attendees"):
// meetings are found from members' Google calendars and recorded for their attendees only; events
// marked private in the calendar are skipped. The old 「議事録の置き場所」 and 「読む会議」 no longer do
// anything and are gone; only how many days 「どのまとまりの会議ですか？」 stays in a member's
// あなたの番 is still chosen here. Words for non-engineers: 「会議」「議事録」「出た人」.
import { useState } from 'react'
import { toast } from 'sonner'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiError, minutesApi, type MinutesFolderSetting } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const DAY_CHOICES = [3, 7, 14, 30]

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 400 && /[ぁ-んァ-ヶ一-龠]/.test(err.message)) return err.message
  return describeError(err)
}

export function MinutesFolderSection({ companyId }: { companyId: string }) {
  const setting = useQuery(`minutes-folder:${companyId}`, () => minutesApi.folder(companyId))
  const [view, setView] = useState<MinutesFolderSetting | null>(null)
  const [busy, setBusy] = useState(false)
  const data = view ?? setting.data

  async function chooseDays(value: string) {
    const days = Number(value)
    if (!DAY_CHOICES.includes(days)) return
    setBusy(true)
    try {
      setView(await minutesApi.setBundleQuestionDays(companyId, days))
      toast.success(`「どの案件・プロジェクトの会議ですか？」を${days}日のあいだ出すようにしました。`)
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2" data-testid="minutes-folder">
      <h3 className="text-sm font-medium">会議の記録</h3>
      <p className="text-xs text-muted-foreground" data-testid="minutes-attendees-note">
        Google をつないだメンバーのカレンダーから Meet の会議を見つけ、その会議に出た人だけが見られる記録にします（会社の持ち主・管理者も、出ていない会議は見えません）。
        カレンダーで「非公開」にした予定は記録しません。議事録を AI が読むのは、出た人が［AI に読ませる］を押したときだけです。
      </p>
      {setting.loading && !data ? (
        <ListSkeleton rows={1} />
      ) : setting.error && !data ? (
        <ErrorState error={setting.error} onRetry={setting.reload} />
      ) : data ? (
        <>
          <h3 className="pt-2 text-sm font-medium">どの案件・プロジェクトの会議かを聞く期間</h3>
          <Select value={String(data.bundleQuestionDays)} onValueChange={chooseDays} disabled={busy}>
            <SelectTrigger className="w-64" aria-label="どの案件・プロジェクトの会議かを聞く期間">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...DAY_CHOICES, data.bundleQuestionDays])].sort((a, b) => a - b).map(d => (
                <SelectItem key={d} value={String(d)}>{d}日{d === 7 ? '（おすすめ）' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            案件・プロジェクトが決まらないまま読んだ社外の会議は、この日数のあいだ読んだ人の「あなたの番」に「どの案件の会議ですか？」（部署の呼び方で）として出ます。過ぎたら一覧から消えます（会議のカードからは、あとでも選べます）。
          </p>
        </>
      ) : null}
    </section>
  )
}

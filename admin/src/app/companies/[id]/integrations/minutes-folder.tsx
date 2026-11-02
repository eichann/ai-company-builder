'use client'

// 「つなぎ先」→「Google」→「議事録の置き場所」 (milestone 4 G7, `.claude/rules/minutes.md`):
// the department folder the meeting records (and the tasks and decisions made from them) go to,
// which meetings are read (default: only those with someone from outside), and how many days
// 「どのまとまりの会議ですか？」 stays in a member's あなたの番.
// Only department folders that are not private are offered; until one is chosen, members'
// apps read nothing. Words for non-engineers: 「会議」「議事録」「置き場所」.
import { useState } from 'react'
import { toast } from 'sonner'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiError, minutesApi, type MeetingIntake, type MinutesFolderSetting } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const NONE = '__none__'
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

  async function choose(value: string) {
    setBusy(true)
    try {
      setView(await minutesApi.setFolder(companyId, value === NONE ? null : value))
      toast.success(value === NONE ? '議事録の置き場所を外しました。議事録は読み込まれなくなります。' : `議事録の置き場所を「${value}」にしました。`)
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function chooseMeetings(value: string) {
    if (value !== 'external' && value !== 'all') return
    setBusy(true)
    try {
      setView(await minutesApi.setMeetings(companyId, value as MeetingIntake))
      toast.success(value === 'all' ? '社内だけの会議の議事録も読むようにしました。' : '社外の人が参加した会議の議事録だけを読むようにしました。')
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function chooseDays(value: string) {
    const days = Number(value)
    if (!DAY_CHOICES.includes(days)) return
    setBusy(true)
    try {
      setView(await minutesApi.setBundleQuestionDays(companyId, days))
      toast.success(`「どのまとまりの会議ですか？」を${days}日のあいだ出すようにしました。`)
    } catch (err) {
      toast.error(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2" data-testid="minutes-folder">
      <h3 className="text-sm font-medium">議事録の置き場所</h3>
      {setting.loading && !data ? (
        <ListSkeleton rows={1} />
      ) : setting.error && !data ? (
        <ErrorState error={setting.error} onRetry={setting.reload} />
      ) : data ? (
        <>
          <Select value={data.folder ?? NONE} onValueChange={choose} disabled={busy}>
            <SelectTrigger className="w-64" aria-label="議事録の置き場所">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>選んでいない（議事録を読み込まない）</SelectItem>
              {data.choices.map((folder) => (
                <SelectItem key={folder} value={folder}>{folder}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Meet の会議の議事録を、この部署の記録として受け取ります。
            議事録から作る宿題や決めたことも、この部署に置かれます。非公開のフォルダは選べません。
          </p>
          <h3 className="pt-2 text-sm font-medium">読む会議</h3>
          <Select value={data.meetings} onValueChange={chooseMeetings} disabled={busy}>
            <SelectTrigger className="w-64" aria-label="読む会議">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="external">社外の人が参加した会議だけ（おすすめ）</SelectItem>
              <SelectItem value="all">社内だけの会議も含めて、すべて</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            「すべて」にすると、人事の面談など社内だけの会議の議事録も読み、出席したメンバーの宿題や決めたことにします。
          </p>
          <h3 className="pt-2 text-sm font-medium">まとまりを聞く期間</h3>
          <Select value={String(data.bundleQuestionDays)} onValueChange={chooseDays} disabled={busy}>
            <SelectTrigger className="w-64" aria-label="まとまりを聞く期間">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...DAY_CHOICES, data.bundleQuestionDays])].sort((a, b) => a - b).map(d => (
                <SelectItem key={d} value={String(d)}>{d}日{d === 7 ? '（おすすめ）' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            案件などのまとまりが決まらないまま読んだ社外の会議は、この日数のあいだ担当の人の「あなたの番」に「どのまとまりの会議ですか？」として出ます。過ぎたら一覧から消えます（会議のカードからは、あとでも選べます）。
          </p>
        </>
      ) : null}
    </section>
  )
}

'use client'

// 「つなぎ先」→「Google」→「議事録の置き場所」 (milestone 4 G7, `.claude/rules/minutes.md`):
// the department folder the minutes records (and the tasks and decisions made from them) go to.
// Only department folders that are not private are offered; until one is chosen, members'
// apps read nothing. Words for non-engineers: 「議事録」「置き場所」.
import { useState } from 'react'
import { toast } from 'sonner'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ApiError, minutesApi, type MinutesFolderSetting } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

const NONE = '__none__'

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
            社外の人が参加した Meet の会議の議事録を、この部署の記録として受け取ります（社内だけの会議は読みません）。
            議事録から作る宿題や決めたことも、この部署に置かれます。非公開のフォルダは選べません。
          </p>
        </>
      ) : null}
    </section>
  )
}

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CalendarBlank, ChatCircleText, EnvelopeSimple, Handshake, ListChecks, LockSimple, Robot, Trash, UsersThree } from '@phosphor-icons/react'

import { RadioCard } from '@/components/app/radio-card'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { DepartmentMembersDialog, MemberAbsenceDialog } from '@/components/departments/department-members-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  companiesApi,
  departmentsApi,
  taskSettingsApi,
  type Department,
  type DepartmentMember,
  type DepartmentMembersView,
  type Member,
  type TaskSettings,
  type TaskSettingsView,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { IntakeSettingsSection } from './intake-settings'
import { MeetingDuplicatesSection } from './meeting-duplicates'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  TASK_SETTINGS_LIMITS,
  cloneSettings,
  formatDay,
  isCalendarDate,
  isCutoff,
  japaneseHolidayName,
  parseTaskSettings,
  replyTarget,
  sameSettings,
} from '@/lib/task-settings'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const TITLE = 'やることの一覧'

/**
 * The company's task settings, asked as plain questions (stage 2 S6):
 * owners and admins answer them; department managers set who belongs to
 * their own departments. Rules: shared/core/task-settings.ts.
 */
export default function TaskListSettingsPage() {
  const { companyId, isAdmin, managedDepartmentIds, role } = useCompany()
  const isManager = managedDepartmentIds.length > 0
  const settings = useQuery(isAdmin ? `task-settings:${companyId}` : null, () => taskSettingsApi.get(companyId))
  const departments = useQuery(`departments:${companyId}`, () => departmentsApi.list(companyId))

  if (role !== null && !isAdmin && !isManager) {
    return (
      <>
        <PageHeader title={TITLE} />
        <EmptyState icon={LockSimple} title="このページはオーナー・管理者と部署の管理役だけが使えます" />
      </>
    )
  }

  return (
    <>
      <PageHeader title={TITLE} />
      <div className="-mt-2 mb-6 max-w-3xl space-y-2 text-sm text-muted-foreground">
        <p>やることの一覧と、AI に任せる仕事の進め方を決めます。</p>
        {!isAdmin && <p>会社全体の決めごとはオーナーと管理者が決めます。ここでは、あなたが管理役の部署に所属する人を決められます。</p>}
      </div>
      <div className="space-y-6 pb-4">
        {isAdmin &&
          (settings.loading || departments.loading ? (
            <ListSkeleton rows={4} />
          ) : settings.error && !settings.data ? (
            <ErrorState error={settings.error} onRetry={settings.reload} />
          ) : settings.data ? (
            <SettingsForm
              key={settings.data.updatedAt ?? 'defaults'}
              view={settings.data}
              departments={departments.data ?? []}
              onSaved={(next) => settings.setData(() => next)}
            />
          ) : null)}
        {isAdmin && <IntakeSettingsSection departments={departments.data ?? []} />}
        {isAdmin && <MeetingDuplicatesSection />}
        <MembershipCard departments={departments.data} error={departments.error} onRetry={departments.reload} />
      </div>
    </>
  )
}

function SettingsForm({
  view,
  departments,
  onSaved,
}: {
  view: TaskSettingsView
  departments: Department[]
  onSaved: (next: TaskSettingsView) => void
}) {
  const { companyId } = useCompany()
  const [draft, setDraft] = useState<TaskSettings>(() => cloneSettings(view.settings))
  const [busy, setBusy] = useState(false)
  const change = (fn: (d: TaskSettings) => void) =>
    setDraft((prev) => {
      const next = cloneSettings(prev)
      fn(next)
      return next
    })

  const dirty = !sameSettings(draft, view.settings)
  const checked = parseTaskSettings(draft)
  const problem = 'error' in checked ? checked.error : null

  const save = async () => {
    setBusy(true)
    try {
      const next = await taskSettingsApi.update(companyId, draft)
      toast.success('設定を保存しました')
      onSaved(next)
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ReplyCard draft={draft} change={change} />
      <AutoRunCard draft={draft} change={change} />
      <ReadIncomingCard draft={draft} change={change} />
      <AcceptanceCard draft={draft} change={change} />
      <DepartmentsCard draft={draft} change={change} departments={departments} />
      <HolidaysCard draft={draft} change={change} />

      {view.updatedAt && (
        <p className="text-xs text-muted-foreground">
          最後に変えた日時: {formatDateTime(view.updatedAt)}（{view.updatedByName ?? '管理者'}）
        </p>
      )}

      <div
        className={cn(
          'sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 shadow-md sm:flex-row sm:items-center sm:justify-between',
          !dirty && 'hidden'
        )}
        aria-live="polite"
      >
        <p className="text-sm font-medium">{problem ? '入力を直してから保存してください' : '保存していない変更があります'}</p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setDraft(cloneSettings(view.settings))} disabled={busy}>
            取り消す
          </Button>
          <Button onClick={save} disabled={busy || problem !== null}>
            {busy ? '保存しています…' : '保存'}
          </Button>
        </div>
      </div>
    </>
  )
}

type CardProps = { draft: TaskSettings; change: (fn: (d: TaskSettings) => void) => void }

function ReplyCard({ draft, change }: CardProps) {
  const holidays = draft.companyHolidays.map((h) => h.date)
  const example = (() => {
    try {
      return replyTarget(new Date(), draft.reply, holidays).date
    } catch {
      return null
    }
  })()
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ChatCircleText size={16} />
          届いた連絡に締め切りが書いていないとき、いつまでに返しますか？
        </CardTitle>
        <CardDescription>AI がやることを作るときの、返事の目安になります。土日・祝日・会社の休みは数えません。</CardDescription>
      </CardHeader>
      <div role="radiogroup" aria-label="返事の目安" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
        <RadioCard
          checked={draft.reply.rule === 'next-business-day'}
          onSelect={() => change((d) => { d.reply.rule = 'next-business-day' })}
          label="次の営業日まで"
          help="届いた日の次の営業日のうちに返します。"
        />
        <RadioCard
          checked={draft.reply.rule === 'same-day'}
          onSelect={() => change((d) => { d.reply.rule = 'same-day' })}
          label="その日のうち"
          help="営業日に届いたものは、その日のうちに返します。"
        />
      </div>
      {draft.reply.rule === 'same-day' && (
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-4 text-sm">
          <Label htmlFor="reply-cutoff">この時刻より後に届いたものは、次の営業日まで:</Label>
          <Input
            id="reply-cutoff"
            type="time"
            step={60}
            className="w-32"
            aria-invalid={!isCutoff(draft.reply.sameDayCutoff) || undefined}
            value={draft.reply.sameDayCutoff}
            onChange={(e) => change((d) => { d.reply.sameDayCutoff = e.target.value })}
          />
        </div>
      )}
      {example && (
        <p className="border-t px-5 py-3 text-sm text-muted-foreground">
          例: いま届いた連絡なら、<strong className="font-medium text-foreground">{formatDay(example)}</strong> までに返します。
        </p>
      )}
    </Card>
  )
}

function AutoRunCard({ draft, change }: CardProps) {
  const L = TASK_SETTINGS_LIMITS
  const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v))
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Robot size={16} />
          AI に、押さなくても仕事を進めさせますか？
        </CardTitle>
        <CardDescription>送ることと承認は、いつも人が押します。AI が進めるのは、アプリを開いているあいだだけです。</CardDescription>
      </CardHeader>
      <div role="radiogroup" aria-label="AI に押さなくても仕事を進めさせるか" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
        <RadioCard
          checked={!draft.autoRun.enabled}
          onSelect={() => change((d) => { d.autoRun.enabled = false })}
          label="進めさせない"
          help="人が押したときだけ、AI が仕事を進めます。"
        />
        <RadioCard
          checked={draft.autoRun.enabled}
          onSelect={() => change((d) => { d.autoRun.enabled = true })}
          label="進めさせる"
          help="AI の番になった仕事を、AI が自分で進めます（下書きまで）。各自が自分の設定でオン・オフできます。"
        />
      </div>
      {draft.autoRun.enabled && (
        <div role="radiogroup" aria-label="AI が自動で進める 各自の初めの値" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
          <RadioCard
            checked={draft.autoRun.memberDefault}
            onSelect={() => change((d) => { d.autoRun.memberDefault = true })}
            label="各自オンで始める"
            help="まだ自分で決めていない人は、AI が自動で進めます。"
          />
          <RadioCard
            checked={!draft.autoRun.memberDefault}
            onSelect={() => change((d) => { d.autoRun.memberDefault = false })}
            label="各自オフで始める"
            help="自分の設定でオンにした人だけ、AI が自動で進めます。"
          />
        </div>
      )}
      {draft.autoRun.enabled && (
        <div className="grid gap-4 border-t px-5 py-4 text-sm sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="auto-daily">1人につき、1日に何回まで進めますか？</Label>
            <Input
              id="auto-daily"
              type="number"
              inputMode="numeric"
              min={L.dailyLimit.min}
              max={L.dailyLimit.max}
              className="w-32"
              value={Number.isNaN(draft.autoRun.dailyLimit) ? '' : draft.autoRun.dailyLimit}
              onChange={(e) => change((d) => { d.autoRun.dailyLimit = num(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">{L.dailyLimit.min}〜{L.dailyLimit.max} 回</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-failures">続けて何回うまくいかなかったら止めますか？</Label>
            <Input
              id="auto-failures"
              type="number"
              inputMode="numeric"
              min={L.stopAfterFailures.min}
              max={L.stopAfterFailures.max}
              className="w-32"
              value={Number.isNaN(draft.autoRun.stopAfterFailures) ? '' : draft.autoRun.stopAfterFailures}
              onChange={(e) => change((d) => { d.autoRun.stopAfterFailures = num(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">止まったら、本人に知らせます（{L.stopAfterFailures.min}〜{L.stopAfterFailures.max} 回）</p>
          </div>
        </div>
      )}
    </Card>
  )
}

function ReadIncomingCard({ draft, change }: CardProps) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <EnvelopeSimple size={16} />
          受信を読む
        </CardTitle>
        <CardDescription>
          本人のメール・Slack に来た連絡を AI が読み、返事が要るものを「返事のお願い」にします。本文は ACB に残しません。使ってよいときは、各自が自分の設定でオン・オフできます。
        </CardDescription>
      </CardHeader>
      <div role="radiogroup" aria-label="受信を読む 使ってよいか" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
        <RadioCard
          checked={draft.readIncoming.allowed}
          onSelect={() => change((d) => { d.readIncoming.allowed = true })}
          label="使ってよい"
          help="各自が自分の設定でオンにできます。"
        />
        <RadioCard
          checked={!draft.readIncoming.allowed}
          onSelect={() => change((d) => { d.readIncoming.allowed = false })}
          label="使わない"
          help="だれのメール・Slack も読みません。"
        />
      </div>
      {draft.readIncoming.allowed && (
        <div role="radiogroup" aria-label="受信を読む 各自の初めの値" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
          <RadioCard
            checked={!draft.readIncoming.memberDefault}
            onSelect={() => change((d) => { d.readIncoming.memberDefault = false })}
            label="各自オフで始める"
            help="自分の設定でオンにした人のものだけ読みます。"
          />
          <RadioCard
            checked={draft.readIncoming.memberDefault}
            onSelect={() => change((d) => { d.readIncoming.memberDefault = true })}
            label="各自オンで始める"
            help="まだ自分で決めていない人のものも読みます（Google・Slack で許可した人だけ）。"
          />
        </div>
      )}
    </Card>
  )
}

const ACCEPTANCE_CASES: Array<{ key: keyof TaskSettings['acceptance']; label: string }> = [
  { key: 'sameDepartment', label: '同じ部署に所属する人に頼んだとき' },
  { key: 'managerToMember', label: '部署の管理役が、その部署に所属する人に頼んだとき' },
  { key: 'meetingHomework', label: '会議の宿題を AI が作ったとき（担当がその会議に出ていた場合）' },
]

function AcceptanceCard({ draft, change }: CardProps) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Handshake size={16} />
          人に頼んだとき、相手が「引き受ける」を押すまで待ちますか？
        </CardTitle>
        <CardDescription>
          チェックしたときは、頼んだ時点で引き受けたことにします。それ以外（ほかの部署の人に頼んだときなど）は「引き受け待ち」になり、相手が引き受けると相手の番になります。1 営業日たっても引き受けられていなければ、頼んだ人に知らせます。自分だけのやることは、いつも待ちません。
        </CardDescription>
      </CardHeader>
      <fieldset className="border-t px-5 py-4">
        <legend className="sr-only">頼んだ時点で引き受けたことにするとき</legend>
        <ul className="grid gap-2">
          {ACCEPTANCE_CASES.map((c) => (
            <li key={c.key}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={draft.acceptance[c.key]}
                  onChange={(e) => change((d) => { d.acceptance[c.key] = e.target.checked })}
                />
                {c.label}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </Card>
  )
}

function DepartmentsCard({ draft, change, departments }: CardProps & { departments: Department[] }) {
  const chosen = new Set(draft.taskListDepartmentIds ?? [])
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <ListChecks size={16} />
          どの部署で、やることの一覧を使いますか？
        </CardTitle>
      </CardHeader>
      <div role="radiogroup" aria-label="やることの一覧を使う部署" className="grid gap-3 border-t px-5 py-4 md:grid-cols-2">
        <RadioCard
          checked={draft.taskListDepartmentIds === null}
          onSelect={() => change((d) => { d.taskListDepartmentIds = null })}
          label="すべての部署"
          help="あとから作った部署でも使えます。"
        />
        <RadioCard
          checked={draft.taskListDepartmentIds !== null}
          onSelect={() => change((d) => { d.taskListDepartmentIds = d.taskListDepartmentIds ?? [] })}
          label="選んだ部署だけ"
          help="少しずつ使い始めるときに。"
        />
      </div>
      {draft.taskListDepartmentIds !== null && (
        <fieldset className="border-t px-5 py-4">
          <legend className="sr-only">使う部署</legend>
          {departments.length === 0 ? (
            <p className="text-sm text-muted-foreground">部署がまだありません。</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {departments.map((dep) => (
                <li key={dep.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      checked={chosen.has(dep.id)}
                      onChange={(e) =>
                        change((d) => {
                          const set = new Set(d.taskListDepartmentIds ?? [])
                          if (e.target.checked) set.add(dep.id)
                          else set.delete(dep.id)
                          d.taskListDepartmentIds = [...set]
                        })
                      }
                    />
                    {dep.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
    </Card>
  )
}

function HolidaysCard({ draft, change }: CardProps) {
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const taken = draft.companyHolidays.some((h) => h.date === date)
  const publicName = isCalendarDate(date) ? japaneseHolidayName(date) : null
  const canAdd = isCalendarDate(date) && !taken && name.trim().length <= TASK_SETTINGS_LIMITS.holidayNameLength

  const add = () => {
    if (!canAdd) return
    change((d) => {
      d.companyHolidays.push({ date, name: name.trim() })
      d.companyHolidays.sort((a, b) => (a.date < b.date ? -1 : 1))
    })
    setDate('')
    setName('')
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <CalendarBlank size={16} />
          土日と祝日のほかに、会社が休みの日はありますか？
        </CardTitle>
        <CardDescription>土日と祝日（振替休日を含む）は、何もしなくても休みとして数えます。夏休みや年末年始など、会社だけの休みを足してください。</CardDescription>
      </CardHeader>
      {draft.companyHolidays.length === 0 ? (
        <p className="border-t px-5 py-4 text-sm text-muted-foreground">会社だけの休みは、まだありません。</p>
      ) : (
        <ul aria-label="会社の休み" className="divide-y border-t">
          {draft.companyHolidays.map((h) => (
            <li key={h.date} className="flex items-center gap-3 px-5 py-2 text-sm">
              <span className="w-40 shrink-0 font-medium">
                {h.date.slice(0, 4)}年{formatDay(h.date)}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{h.name}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${formatDay(h.date)}を休みから外す`}
                onClick={() => change((d) => { d.companyHolidays = d.companyHolidays.filter((x) => x.date !== h.date) })}
              >
                <Trash size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-3 border-t px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="holiday-date">日付</Label>
          <Input id="holiday-date" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="holiday-name">名前（なくてもよい）</Label>
          <Input
            id="holiday-name"
            placeholder="夏季休業"
            maxLength={TASK_SETTINGS_LIMITS.holidayNameLength}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={!canAdd}>
          休みに足す
        </Button>
        {(taken || publicName) && (
          <p className="w-full text-xs text-muted-foreground" role="status">
            {taken ? 'この日はもう入っています。' : `この日は祝日（${publicName}）なので、足さなくても休みです。`}
          </p>
        )}
      </form>
    </Card>
  )
}

function MembershipCard({ departments, error, onRetry }: { departments: Department[] | undefined; error: unknown; onRetry: () => void }) {
  const { companyId } = useCompany()
  const members = useQuery(`members:${companyId}`, () => companiesApi.getMembers(companyId))
  const ids = departments?.map((d) => d.id) ?? []
  const membership = useQuery(departments ? `department-members:${companyId}:${ids.join(',')}` : null, async () => {
    const views = await Promise.all(ids.map((id) => departmentsApi.getMembers(companyId, id)))
    return Object.fromEntries(ids.map((id, i) => [id, views[i]])) as Record<string, DepartmentMembersView>
  })
  const [editing, setEditing] = useState<Department | null>(null)
  const [absent, setAbsent] = useState<DepartmentMember | null>(null)

  const nameOf = (m: { name: string | null; email: string | null; userId: string }) => m.name || m.email || '名前未設定'

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <UsersThree size={16} />
          それぞれの部署に、だれが所属していますか？
        </CardTitle>
        <CardDescription>
          所属は、やることの一覧や部署あての連絡をだれが受け持つかに使います。フォルダを見られる人・編集できる人は変わりません（それは「権限」で決めます）。1人が複数の部署に所属できます。
        </CardDescription>
      </CardHeader>
      {error && !departments ? (
        <div className="border-t px-5 py-4">
          <ErrorState error={error} onRetry={onRetry} />
        </div>
      ) : !departments || membership.loading ? (
        <div className="border-t px-5 py-4">
          <ListSkeleton rows={3} />
        </div>
      ) : membership.error && !membership.data ? (
        <div className="border-t px-5 py-4">
          <ErrorState error={membership.error} onRetry={membership.reload} />
        </div>
      ) : departments.length === 0 ? (
        <p className="border-t px-5 py-4 text-sm text-muted-foreground">部署がまだありません。</p>
      ) : (
        <ul aria-label="部署に所属する人" className="divide-y border-t">
          {departments.map((dep) => {
            const view = membership.data?.[dep.id]
            const people = view?.members ?? []
            return (
              <li key={dep.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{dep.name}</p>
                  {people.length === 0 || !view?.canEdit ? (
                    <p className="text-sm text-muted-foreground">
                      {people.length === 0 ? 'まだだれも所属していません' : people.map(nameOf).join('、')}
                    </p>
                  ) : (
                    <ul aria-label={`${dep.name}に所属する人`} className="mt-1 space-y-1">
                      {people.map((p) => (
                        <li key={p.userId} className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 truncate text-muted-foreground">{nameOf(p)}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            aria-label={`${nameOf(p)}さんの不在・代わりの人`}
                            onClick={() => setAbsent(p)}
                            disabled={!members.data}
                          >
                            不在・代わりの人
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {view?.canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setEditing(dep)} disabled={!members.data}>
                    所属する人を変える
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <DepartmentMembersDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        companyId={companyId}
        department={editing}
        current={editing ? (membership.data?.[editing.id]?.members ?? []).map((m) => m.userId) : []}
        members={(members.data ?? []) as Member[]}
        onSaved={(view) => {
          const id = editing?.id
          if (id) membership.setData((prev) => ({ ...(prev ?? {}), [id]: view }))
        }}
      />
      <MemberAbsenceDialog
        open={absent !== null}
        onOpenChange={(o) => !o && setAbsent(null)}
        companyId={companyId}
        member={absent}
        members={(members.data ?? []) as Member[]}
      />
    </Card>
  )
}

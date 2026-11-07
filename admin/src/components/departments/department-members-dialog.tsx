'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Trash } from '@phosphor-icons/react'

import { ErrorState, ListSkeleton } from '@/components/app/states'
import { OutdatedClientsDialog, useOutdatedClients } from '@/components/permissions/outdated-clients-dialog'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  absencesApi,
  ApiError,
  departmentsApi,
  type Department,
  type DepartmentMember,
  type DepartmentMembersView,
  type Member,
} from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { roleLabel } from '@/lib/format'
import { formatDay } from '@/lib/task-settings'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

/** 409 OUTDATED_CLIENTS when someone taken out of a department would lose edit access there. */
const MEMBERS_OUTDATED_MESSAGE =
  '次のメンバーは古いアプリを使っています。所属から外すと、その部署のフォルダに変更を送れなくなり、同期が止まってしまいます。先にアプリを更新してもらってください。'

/** Multi-select of company members who belong to one department (所属する部署). */
/**
 * What 所属 is for, under 「それぞれの部署に、だれが所属していますか？」 and in its dialog. A company with
 * the shared folder: who belongs edits a new department's folder and everyone reads it. Without the
 * folder (PR #650) who sees a department's things is set per department (「見られる人」), so
 * 「見るのは全員できます」 would be wrong there.
 */
export const MEMBERSHIP_NOTE_WITH_FOLDER = '所属は、やることの一覧や部署あての連絡をだれが受け持つかに使います。新しく作った部署では、所属する人だけがその部署のフォルダを編集できます（オーナーと管理者はいつでも編集できます。見るのは全員できます）。1人が複数の部署に所属できます。'
export const MEMBERSHIP_NOTE_WITHOUT_FOLDER =
  '所属は、やることの一覧や部署あての連絡をだれが受け持つかに使います。部署のものをだれが見られるかは、部署ごとの「見られる人」で決めます。1人が複数の部署に所属できます。'
export function membershipNote(hasCompanyFolder: boolean): string {
  return hasCompanyFolder ? MEMBERSHIP_NOTE_WITH_FOLDER : MEMBERSHIP_NOTE_WITHOUT_FOLDER
}

export function DepartmentMembersDialog({
  open,
  onOpenChange,
  companyId,
  department,
  current,
  members,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  department: Department | null
  current: string[]
  members: Member[]
  onSaved: (view: DepartmentMembersView) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        {open && department && (
          <MembersForm
            companyId={companyId}
            department={department}
            current={current}
            members={members}
            onCancel={() => onOpenChange(false)}
            onSaved={(v) => {
              onSaved(v)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MembersForm({
  companyId,
  department,
  current,
  members,
  onCancel,
  onSaved,
}: {
  companyId: string
  department: Department
  current: string[]
  members: Member[]
  onCancel: () => void
  onSaved: (view: DepartmentMembersView) => void
}) {
  const { hasCompanyFolder } = useCompany()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current))
  const [busy, setBusy] = useState(false)

  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })

  // 409 OUTDATED_CLIENTS: in a department where only the people who belong edit,
  // someone taken off would lose edit access on an app that cannot recover from it.
  const { catchOutdated, dialogProps: outdatedDialog } = useOutdatedClients()

  const save = async (force = false) => {
    setBusy(true)
    try {
      const view = await departmentsApi.setMembers(companyId, department.id, [...selected], { force })
      toast.success(`「${department.name}」に所属する人を更新しました`)
      onSaved(view)
    } catch (err) {
      if (!force && catchOutdated(err, () => save(true))) return
      toast.error('所属する人を更新できませんでした', { description: describeError(err) })
      if (force) throw err
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>「{department.name}」に所属する人</DialogTitle>
        <DialogDescription>
{membershipNote(hasCompanyFolder)}
        </DialogDescription>
      </DialogHeader>
      <Command className="border-y" loop>
        <CommandInput placeholder="名前・メールで絞り込む" />
        <CommandList className="max-h-72">
          <CommandEmpty>該当するメンバーがいません</CommandEmpty>
          <CommandGroup>
            {members.map((m) => {
              const name = m.name || m.email || '名前未設定'
              const checked = selected.has(m.userId)
              return (
                <CommandItem
                  key={m.userId}
                  value={`${name} ${m.email ?? ''} ${m.userId}`}
                  onSelect={() => toggle(m.userId)}
                  role="option"
                  aria-selected={checked}
                  className="gap-3 py-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 items-center justify-center rounded border',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                    )}
                  >
                    {checked && <Check size={12} weight="bold" />}
                  </span>
                  <Avatar name={name} seed={m.userId} className="size-6 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{roleLabel(m.role)}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
      <DialogFooter className="items-center p-4 sm:justify-between">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {selected.size}人を選択中
        </span>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            キャンセル
          </Button>
          <Button type="button" onClick={() => void save().catch(() => {})} disabled={busy}>
            {busy ? '保存しています…' : '保存'}
          </Button>
        </div>
      </DialogFooter>
      <OutdatedClientsDialog {...outdatedDialog} description={MEMBERS_OUTDATED_MESSAGE} />
    </>
  )
}

const personName = (m: { name: string | null; email: string | null }) => m.name || m.email || '名前未設定'

/** 400 / 409 of the absence API carry a Japanese sentence meant for the person (shared/core/absences.ts). */
const absenceErrorText = (err: unknown) =>
  err instanceof ApiError && (err.status === 400 || err.status === 409) && err.message ? err.message : describeError(err)

const fullDay = (date: string) => `${date.slice(0, 4)}年${formatDay(date)}`

/**
 * 不在・代わりの人 of one member (stage 2 S4): their absences that have not
 * ended, and a form to add one. Who may: the member, owner/admin, managers of
 * a department the member belongs to; the server decides (`canEdit`).
 */
export function MemberAbsenceDialog({
  open,
  onOpenChange,
  companyId,
  member,
  members,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  member: DepartmentMember | null
  members: Member[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        {open && member && <AbsenceForm key={member.userId} companyId={companyId} member={member} members={members} />}
      </DialogContent>
    </Dialog>
  )
}

function AbsenceForm({ companyId, member, members }: { companyId: string; member: DepartmentMember; members: Member[] }) {
  const absences = useQuery(`absences:${companyId}:${member.userId}`, () => absencesApi.list(companyId, member.userId))
  const today = absences.data?.today ?? ''
  const [from, setFrom] = useState('')
  const [until, setUntil] = useState('')
  const [delegateId, setDelegateId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const name = personName(member)
  const candidates = members.filter((m) => m.userId !== member.userId)
  const canEdit = absences.data?.canEdit ?? false

  const add = async () => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      const created = await absencesApi.create(companyId, { userId: member.userId, from: from || today, until, delegateId })
      toast.success(`${name}さんの不在を追加しました`)
      if (created.delegateCannotRead > 0) {
        setNotice(`代わりの人が見られないものが ${created.delegateCannotRead} 件あります。部署の管理役に知らせました。`)
      }
      setFrom('')
      setUntil('')
      setDelegateId('')
      absences.reload()
    } catch (err) {
      setProblem(absenceErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (absenceId: string) => {
    setBusy(true)
    setProblem(null)
    try {
      await absencesApi.remove(companyId, absenceId)
      absences.setData((prev) => ({ ...prev!, absences: prev!.absences.filter((a) => a.id !== absenceId) }))
    } catch (err) {
      setProblem(absenceErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>{name}さんの不在と代わりの人</DialogTitle>
        <DialogDescription>
          休みのあいだ、{name}さんの番になった仕事や承認、お知らせは代わりの人にも届きます。代わりの人は、自分が見られるものだけを扱えます。
        </DialogDescription>
      </DialogHeader>
      <div className="border-t px-6 py-4">
        {absences.loading ? (
          <ListSkeleton rows={2} />
        ) : absences.error && !absences.data ? (
          <ErrorState error={absences.error} onRetry={absences.reload} />
        ) : !absences.data || absences.data.absences.length === 0 ? (
          <p className="text-sm text-muted-foreground">これからの不在は、まだありません。</p>
        ) : (
          <ul aria-label="不在の予定" className="divide-y">
            {absences.data.absences.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {fullDay(a.from)} 〜 {a.until === a.from ? '（1日だけ）' : fullDay(a.until)}
                  </span>
                  <span className="block truncate text-muted-foreground">代わりの人: {a.delegateName ?? '名前未設定'}</span>
                </span>
                {a.active && <Badge variant="warning">いま不在</Badge>}
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${fullDay(a.from)}からの不在を削除`}
                    onClick={() => remove(a.id)}
                    disabled={busy}
                  >
                    <Trash size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canEdit && (
        <form
          className="grid gap-3 border-t px-6 py-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="absence-from">始まりの日</Label>
            <Input id="absence-from" type="date" min={today || undefined} value={from || today} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="absence-until">終わりの日</Label>
            <Input id="absence-until" type="date" min={from || today || undefined} value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="absence-delegate">代わりの人</Label>
            <select
              id="absence-delegate"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={delegateId}
              onChange={(e) => setDelegateId(e.target.value)}
            >
              <option value="">選んでください</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {personName(m)}
                </option>
              ))}
            </select>
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {problem}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-warning sm:col-span-2">
              {notice}
            </p>
          )}
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" disabled={busy || !until || !delegateId}>
              {busy ? '追加しています…' : '追加'}
            </Button>
          </div>
        </form>
      )}
    </>
  )
}

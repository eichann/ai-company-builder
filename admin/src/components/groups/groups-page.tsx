'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check, PencilSimple, Plus, Trash, UsersFour } from '@phosphor-icons/react'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/app/states'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, companiesApi, groupsApi, type Member, type MemberGroup } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { roleLabel } from '@/lib/format'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

/** What the page says at the top (plain words: no 権限・スコープ・グループ). */
export const GROUPS_INTRO =
  '「見える人のまとまり」は、記録を見られる人を決めるときに使う、メンバーの組み合わせです（例：採用チーム）。まとまりに入っている人の分だけが対象になり、あとから入れた人・外した人もすぐに反映されます。部署や場所の設定では、オーナーと管理者は、まとまりに入れなくても、いつでもすべてを見られます。「この人たちだけ」の記録（会議など）の見られる人にも使えます。こちらは、オーナーや管理者も、入れなければ見られません。'

/** Shown in a company that uses the shared company folder: place rules cannot name a group there; members-only records can. */
export const GROUPS_WITH_FOLDER_NOTE =
  'この会社では、部署やフォルダを見られる人の設定にはまだ使えません。「この人たちだけ」の記録（会議など）の見られる人には使えます。'

const personName = (m: { name: string | null; email: string | null }) => m.name || m.email || '名前未設定'

/** The places (paths) a group is used in, as people read them: 「人事部 › 採用」. */
export const placeLabel = (path: string) => path.split('/').join(' › ')

export function GroupsPage() {
  const { companyId, isAdmin, role, hasCompanyFolder } = useCompany()
  const groups = useQuery(isAdmin ? `groups:${companyId}` : null, () => groupsApi.list(companyId))
  const members = useQuery(isAdmin ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<MemberGroup | null>(null)
  const [editing, setEditing] = useState<MemberGroup | null>(null)
  const [deleting, setDeleting] = useState<MemberGroup | null>(null)
  // Why the last delete was refused (a place still uses the group): shown on the page, not only in a toast.
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null)

  const byId = new Map(((members.data ?? []) as Member[]).map((m) => [m.userId, m]))
  const replace = (g: MemberGroup) =>
    groups.setData((prev) => ({ groups: (prev?.groups ?? []).map((x) => (x.id === g.id ? g : x)) }))

  if (role !== null && !isAdmin) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <PageHeader title="見える人のまとまり" />
        <p className="text-sm text-muted-foreground">このページはオーナーと管理者だけが使えます。</p>
      </div>
    )
  }

  const list = groups.data?.groups ?? []

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="見える人のまとまり"
        description={GROUPS_INTRO}
        actions={
          <Button onClick={() => setCreating(true)} disabled={!members.data}>
            <Plus />
            まとまりを作る
          </Button>
        }
      />
      {deleteProblem && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          {deleteProblem}
        </p>
      )}
      {hasCompanyFolder && <p className="mb-4 rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{GROUPS_WITH_FOLDER_NOTE}</p>}
      {groups.error && !groups.data ? (
        <ErrorState error={groups.error} onRetry={groups.reload} />
      ) : groups.loading || !groups.data ? (
        <ListSkeleton rows={3} />
      ) : list.length === 0 ? (
        <EmptyState icon={UsersFour} title="まだまとまりがありません" description="「まとまりを作る」から、名前と入る人を決めてください。" />
      ) : (
        <Card className="p-0">
          <ul aria-label="見える人のまとまり" className="divide-y">
            {list.map((g) => (
              <li key={g.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{g.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {g.memberIds.length === 0
                      ? 'まだだれも入っていません'
                      : `${g.memberIds.length}人：${g.memberIds.map((id) => (byId.get(id) ? personName(byId.get(id)!) : 'もういない人')).join('、')}`}
                  </p>
                  {g.usedIn.length > 0 && (
                    <p className="text-xs text-muted-foreground">使っている場所：{g.usedIn.map(placeLabel).join('、')}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(g)} disabled={!members.data}>
                    入る人を変える
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(g)} aria-label={`「${g.name}」の名前を変える`}>
                    <PencilSimple />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(g)} aria-label={`「${g.name}」を削除`}>
                    <Trash />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <GroupMembersDialog
        open={creating || editing !== null}
        onOpenChange={(o) => {
          if (o) return
          setCreating(false)
          setEditing(null)
        }}
        group={editing}
        members={(members.data ?? []) as Member[]}
        onSave={async (name, userIds) => {
          if (editing) {
            const saved = await groupsApi.setMembers(companyId, editing.id, userIds)
            replace(saved)
            toast.success(`「${saved.name}」に入る人を更新しました`)
          } else {
            const made = await groupsApi.create(companyId, name, userIds)
            groups.setData((prev) => ({ groups: [...(prev?.groups ?? []), made] }))
            toast.success(`「${made.name}」を作りました`)
          }
        }}
      />
      <RenameDialog
        group={renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        onSave={async (name) => {
          const saved = await groupsApi.rename(companyId, renaming!.id, name)
          replace(saved)
          toast.success('名前を変えました')
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? `「${deleting.name}」を削除しますか？` : ''}
        description="入っている人はそのままです（メンバーから外れることはありません）。このまとまりで見られるようにしていた「この人たちだけ」の記録は、まとまりから見られなくなります。"
        confirmLabel="削除する"
        onConfirm={async () => {
          const target = deleting!
          try {
            await groupsApi.delete(companyId, target.id)
            setDeleteProblem(null)
            groups.setData((prev) => ({ groups: (prev?.groups ?? []).filter((x) => x.id !== target.id) }))
            toast.success(`「${target.name}」を削除しました`)
          } catch (err) {
            const text = deleteErrorText(err)
            setDeleteProblem(`「${target.name}」を削除できませんでした。${text}`)
            toast.error('削除できませんでした', { description: text })
            setDeleting(null)
            throw err
          }

        }}
      />
    </div>
  )
}

/** 409 GROUP_IN_USE names the places that still use the group. */
export function deleteErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'GROUP_IN_USE') {
    const places = Array.isArray(err.body?.places) ? (err.body.places as unknown[]).filter((p): p is string => typeof p === 'string') : []
    return places.length > 0 ? `${err.message}（${places.map(placeLabel).join('、')}）` : err.message
  }
  return describeError(err)
}

function RenameDialog({
  group,
  onOpenChange,
  onSave,
}: {
  group: MemberGroup | null
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => Promise<void>
}) {
  return (
    <Dialog open={group !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {group && <RenameForm group={group} onCancel={() => onOpenChange(false)} onSave={async (n) => { await onSave(n); onOpenChange(false) }} />}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({ group, onCancel, onSave }: { group: MemberGroup; onCancel: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(group.name)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await onSave(name)
    } catch (err) {
      toast.error('名前を変えられませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>名前を変える</DialogTitle>
        <DialogDescription>使っている場所の設定はそのままです。</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="group-rename">名前</Label>
        <Input id="group-rename" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>キャンセル</Button>
        <Button onClick={() => void save()} disabled={busy || name.trim() === ''}>{busy ? '保存しています…' : '保存'}</Button>
      </DialogFooter>
    </>
  )
}

/** Create a group (name + who is in it), or change who is in one. */
function GroupMembersDialog({
  open,
  onOpenChange,
  group,
  members,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: MemberGroup | null
  members: Member[]
  onSave: (name: string, userIds: string[]) => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        {open && (
          <MembersForm
            group={group}
            members={members}
            onCancel={() => onOpenChange(false)}
            onSave={async (name, ids) => {
              await onSave(name, ids)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MembersForm({
  group,
  members,
  onCancel,
  onSave,
}: {
  group: MemberGroup | null
  members: Member[]
  onCancel: () => void
  onSave: (name: string, userIds: string[]) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(group?.memberIds ?? []))
  const [busy, setBusy] = useState(false)
  const toggle = (userId: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  const save = async () => {
    setBusy(true)
    try {
      await onSave(name, [...selected])
    } catch (err) {
      toast.error(group ? '入る人を更新できませんでした' : 'まとまりを作れませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>{group ? `「${group.name}」に入る人` : 'まとまりを作る'}</DialogTitle>
        <DialogDescription>
          {group
            ? 'ここで外した人は、このまとまりで見られるようにしていた記録を、すぐに見られなくなります。'
            : '名前と、入る人を選んでください。入る人はあとから変えられます。'}
        </DialogDescription>
      </DialogHeader>
      {!group && (
        <div className="space-y-2 px-6 pb-4">
          <Label htmlFor="group-name">名前</Label>
          <Input id="group-name" value={name} maxLength={40} placeholder="例：採用チーム" onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      <Command className="border-y" loop>
        <CommandInput placeholder="名前・メールで絞り込む" />
        <CommandList className="max-h-72">
          <CommandEmpty>該当するメンバーがいません</CommandEmpty>
          <CommandGroup>
            {members.map((m) => {
              const label = personName(m)
              const checked = selected.has(m.userId)
              return (
                <CommandItem
                  key={m.userId}
                  value={`${label} ${m.email ?? ''} ${m.userId}`}
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
                  <Avatar name={label} seed={m.userId} className="size-6 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{label}</span>
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
          <Button type="button" onClick={() => void save()} disabled={busy || (!group && name.trim() === '')}>
            {busy ? '保存しています…' : group ? '保存' : '作る'}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

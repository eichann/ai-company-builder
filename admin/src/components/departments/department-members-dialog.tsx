'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { departmentsApi, type Department, type DepartmentMembersView, type Member } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { roleLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Multi-select of company members who belong to one department (所属する部署). */
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current))
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
      const view = await departmentsApi.setMembers(companyId, department.id, [...selected])
      toast.success(`「${department.name}」に所属する人を更新しました`)
      onSaved(view)
    } catch (err) {
      toast.error('所属する人を更新できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>「{department.name}」に所属する人</DialogTitle>
        <DialogDescription>
          所属は、やることの一覧や部署あての連絡をだれが受け持つかに使います。フォルダを見られる人・編集できる人は変わりません。1人が複数の部署に所属できます。
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
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? '保存しています…' : '保存'}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

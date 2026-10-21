'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { departmentsApi, type Department, type DepartmentManager, type Member } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { roleLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Multi-select of company members as managers (部署の責任者) of one department. */
export function ManagersDialog({
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
  current: DepartmentManager[]
  members: Member[]
  onSaved: (managers: DepartmentManager[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        {open && department && (
          <ManagersForm
            companyId={companyId}
            department={department}
            current={current}
            members={members}
            onCancel={() => onOpenChange(false)}
            onSaved={(m) => {
              onSaved(m)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ManagersForm({
  companyId,
  department,
  current,
  members,
  onCancel,
  onSaved,
}: {
  companyId: string
  department: Department
  current: DepartmentManager[]
  members: Member[]
  onCancel: () => void
  onSaved: (managers: DepartmentManager[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current.map((m) => m.userId)))
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
      const res = await departmentsApi.setManagers(companyId, department.id, [...selected])
      toast.success(`「${department.name}」の責任者を更新しました`)
      onSaved(res.managers)
    } catch (err) {
      toast.error('責任者を更新できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>「{department.name}」の責任者</DialogTitle>
        <DialogDescription>
          責任者は、この部署のフォルダの権限を管理画面で確認できます（変更は今後のアップデートで対応予定）。ファイルへのアクセス権は変わりません。複数人を選べます。
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

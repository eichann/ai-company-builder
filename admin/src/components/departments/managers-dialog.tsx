'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { MemberChecklist } from '@/components/departments/member-checklist'
import { Button } from '@/components/ui/button'
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

/** Multi-select of company members as managers (部署の管理役) of one department. */
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
      toast.success(`「${department.name}」の管理役を更新しました`)
      onSaved(res.managers)
    } catch (err) {
      toast.error('管理役を更新できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>「{department.name}」の管理役</DialogTitle>
        <DialogDescription>
          管理役は、この部署とその中のフォルダの編集権限を管理画面で設定できます。管理役になるだけでは、本人が編集できる場所は変わりません。複数人を選べます。
        </DialogDescription>
      </DialogHeader>
      <MemberChecklist members={members} selected={selected} onToggle={toggle} />
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

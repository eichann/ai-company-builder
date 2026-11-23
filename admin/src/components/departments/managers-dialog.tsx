'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { ErrorState } from '@/components/app/states'
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
import { ApiError, departmentsApi, type Department, type DepartmentManager, type Member } from '@/lib/api'
import { describeError } from '@/lib/errors'

/**
 * Multi-select of company members as managers (部署の管理役) of one department.
 *
 * Saving replaces the whole list, so the form exists only on a loaded list:
 * `current` undefined means "not known yet" (loading, or it failed: `loadError`),
 * never "nobody" — an empty start would remove every manager on save. The form
 * is keyed to the list it started from, so a reload that changed it starts the
 * form again, and the save sends that list (`expectedUserIds`): if someone
 * changed it meanwhile the server writes nothing (409 MANAGERS_CHANGED).
 */
export function ManagersDialog({
  open,
  onOpenChange,
  companyId,
  department,
  current,
  loadError,
  onRetry,
  members,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  department: Department | null
  /** The department's managers as loaded; undefined while unknown. */
  current: DepartmentManager[] | undefined
  loadError: unknown
  onRetry: () => void
  members: Member[]
  /** Today's list: after a save, or the server's when it refused a stale one. */
  onSaved: (managers: DepartmentManager[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        {open && department && current === undefined && (
          <>
            <DialogHeader className="p-6 pb-4">
              <DialogTitle>「{department.name}」の管理役</DialogTitle>
              <DialogDescription>いまの管理役を確かめてから選べます。</DialogDescription>
            </DialogHeader>
            <div className="px-6 pb-6">
              {loadError ? (
                <ErrorState error={loadError} onRetry={onRetry} title="いまの管理役を読み込めませんでした" />
              ) : (
                <p className="text-body text-muted-foreground" role="status" aria-busy="true">
                  いまの管理役を読み込んでいます…
                </p>
              )}
            </div>
            <DialogFooter className="p-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                閉じる
              </Button>
            </DialogFooter>
          </>
        )}
        {open && department && current !== undefined && (
          <ManagersForm
            key={`${department.id}:${listKey(current)}`}
            companyId={companyId}
            department={department}
            current={current}
            members={members}
            onCancel={() => onOpenChange(false)}
            onChanged={onSaved}
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

/** The same people in any order give the same key. */
function listKey(list: DepartmentManager[]): string {
  return list
    .map((m) => m.userId)
    .sort()
    .join(',')
}

/** Today's managers in a 409 MANAGERS_CHANGED answer, when well formed. */
function managersOfConflict(err: unknown): DepartmentManager[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'MANAGERS_CHANGED') return null
  const list = err.body?.managers
  if (!Array.isArray(list)) return null
  const wellFormed = list.every(
    (m) => typeof m === 'object' && m !== null && typeof (m as { userId?: unknown }).userId === 'string'
  )
  return wellFormed ? (list as DepartmentManager[]) : null
}

function ManagersForm({
  companyId,
  department,
  current,
  members,
  onCancel,
  onChanged,
  onSaved,
}: {
  companyId: string
  department: Department
  current: DepartmentManager[]
  members: Member[]
  onCancel: () => void
  /** Someone else changed the list: today's list (the form starts again from it). */
  onChanged: (managers: DepartmentManager[]) => void
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
      const res = await departmentsApi.setManagers(
        companyId,
        department.id,
        [...selected],
        current.map((m) => m.userId)
      )
      toast.success(`「${department.name}」の管理役を更新しました`)
      onSaved(res.managers)
    } catch (err) {
      toast.error('管理役を更新できませんでした', { description: describeError(err) })
      const today = managersOfConflict(err)
      if (today) onChanged(today)
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

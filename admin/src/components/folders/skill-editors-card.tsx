'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { MemberChecklist } from '@/components/departments/member-checklist'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { skillEditorsApi, type Department, type DepartmentManager, type Member, type SkillEditors } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

interface Place {
  /** null: the whole company. */
  departmentId: string | null
  name: string
  editors: DepartmentManager[]
}

/**
 * 「Skill を直せる人」 (owner/admin): besides owners, admins and a department's 管理役, who may
 * change skills. A skill's scripts run on the computer of whoever uses it, so this is a short
 * list by default; a company that prefers can open it with one switch (全員が直せる). It says
 * nothing about folders: the place must also be writable for them.
 */
export function SkillEditorsCard({ companyId, departments, members }: { companyId: string; departments: Department[]; members: Member[] }) {
  const editors = useQuery(`skill-editors:${companyId}`, () => skillEditorsApi.get(companyId))
  const [editing, setEditing] = useState<Place | null>(null)
  const [switching, setSwitching] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const setEveryone = async (everyone: boolean) => {
    setSwitching(true)
    try {
      const view = await skillEditorsApi.setEveryone(companyId, everyone)
      editors.setData(() => view)
      toast.success(everyone ? '全員がスキルを直せるようにしました' : 'スキルを直せる人を、選んだ人だけに戻しました')
    } catch (err) {
      toast.error('設定を変更できませんでした', { description: describeError(err) })
    } finally {
      setSwitching(false)
    }
  }

  const inDepartment = (id: string) => editors.data?.departments.find((d) => d.departmentId === id)?.editors ?? []
  const places: Place[] = [
    { departmentId: null, name: '会社全体', editors: editors.data?.company ?? [] },
    ...departments.map((d) => ({ departmentId: d.id, name: d.name, editors: inDepartment(d.id) })),
  ]

  return (
    <Card className="gap-3 px-5 py-5">
      <div>
        <h2 className="text-base font-semibold">Skill を直せる人</h2>
        <p className="text-sm text-muted-foreground">
          スキルの中身（スクリプトを含む）は使う人のパソコンで動くため、変えられるのはオーナー・管理者・部署の管理役と、ここで選んだ人だけです。「会社全体」で選ぶと全部のスキルを、部署で選ぶとその部署のスキルを直せます。
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={editors.data?.everyone ?? false}
          disabled={!editors.data || switching}
          onChange={(e) => (e.target.checked ? setConfirmOpen(true) : void setEveryone(false))}
        />
        <span>
          <span className="block font-medium">全員が直せるようにする</span>
          <span className="block text-xs text-muted-foreground">
            編集できるフォルダのスキルを、メンバーのだれでも直せます。下の一覧は残り、切るとまた使われます。自動実行の設定だけは、オーナー・管理者のままです。
          </span>
        </span>
      </label>
      <ul className={cn('divide-y', editors.data?.everyone && 'opacity-50')}>
        {places.map((p) => (
          <li key={p.departmentId ?? 'company'} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{p.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {!editors.data ? (editors.error ? '読み込めませんでした' : '読み込み中…') : p.editors.length > 0 ? p.editors.map((e) => e.name || e.email).join('、') : 'だれも選んでいません'}
              </span>
            </span>
            <Button type="button" variant="outline" size="sm" disabled={!editors.data} aria-label={`${p.name}の Skill を直せる人を選ぶ`} onClick={() => setEditing(p)}>
              選ぶ
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="全員がスキルを直せるようにしますか？"
        description={
          <p>
            スキルの中のスクリプトは、使う人のパソコンで、その人の権限で動きます。オンにすると、メンバーのだれか（またはその人の AI）が直したスクリプトが、ほかの人のパソコンでも動くようになります。
          </p>
        }
        confirmLabel="全員が直せるようにする"
        onConfirm={() => setEveryone(true)}
      />
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          {editing && (
            <SkillEditorsForm
              companyId={companyId}
              place={editing}
              members={members}
              onCancel={() => setEditing(null)}
              onSaved={(view) => {
                editors.setData(() => view)
                setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function SkillEditorsForm({
  companyId,
  place,
  members,
  onCancel,
  onSaved,
}: {
  companyId: string
  place: Place
  members: Member[]
  onCancel: () => void
  onSaved: (view: SkillEditors) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(place.editors.map((e) => e.userId)))
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
      const view = await skillEditorsApi.set(companyId, place.departmentId, [...selected])
      toast.success(`「${place.name}」の Skill を直せる人を更新しました`)
      onSaved(view)
    } catch (err) {
      toast.error('Skill を直せる人を更新できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>「{place.name}」の Skill を直せる人</DialogTitle>
        <DialogDescription>
          選ばれた人が直したスキルは、使う人のパソコンで動きます。信頼できる人だけを選んでください。選ぶだけでは、その人が編集できるフォルダは変わりません。
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

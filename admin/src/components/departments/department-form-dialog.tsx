'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Warning } from '@phosphor-icons/react'

import { DEPARTMENT_COLORS, DEPARTMENT_ICONS, DepartmentIcon } from '@/components/app/department-icon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { departmentsApi, type Department } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { isValidFolderName, suggestFolderName } from '@/lib/folder-name'
import { cn } from '@/lib/utils'

/** Create (department = null) or edit a department. */
export function DepartmentFormDialog({
  open,
  onOpenChange,
  companyId,
  department,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  department: Department | null
  onSaved: (saved: Department) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <DepartmentForm
            companyId={companyId}
            department={department}
            onCancel={() => onOpenChange(false)}
            onSaved={(d) => {
              onSaved(d)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DepartmentForm({
  companyId,
  department,
  onCancel,
  onSaved,
}: {
  companyId: string
  department: Department | null
  onCancel: () => void
  onSaved: (saved: Department) => void
}) {
  const editing = department !== null
  const [name, setName] = useState(department?.name ?? '')
  const [folder, setFolder] = useState(department?.folder ?? '')
  // On create the folder follows the name until the user edits it.
  const [folderTouched, setFolderTouched] = useState(editing)
  const [nameEn, setNameEn] = useState(department?.nameEn ?? '')
  const [icon, setIcon] = useState(department?.icon ?? 'Folder')
  const [color, setColor] = useState(department?.color ?? '#6366f1')
  const [description, setDescription] = useState(department?.description ?? '')
  const [busy, setBusy] = useState(false)

  const folderValid = folder === '' || isValidFolderName(folder)
  const renaming = editing && folder !== department.folder

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!folderValid || !folder || !name.trim()) return
    setBusy(true)
    try {
      const saved = editing
        ? await departmentsApi.update(companyId, department.id, {
            name: name.trim(),
            folder,
            nameEn: nameEn.trim() || null,
            icon,
            color,
            description: description.trim() || null,
          })
        : await departmentsApi.create(companyId, {
            name: name.trim(),
            folder,
            nameEn: nameEn.trim() || undefined,
            icon,
            color,
            description: description.trim() || undefined,
          })
      toast.success(editing ? `「${saved.name}」を更新しました` : `「${saved.name}」を作成しました`)
      onSaved(saved)
    } catch (err) {
      toast.error(editing ? '部署を更新できませんでした' : '部署を作成できませんでした', {
        description: describeError(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{editing ? '部署を編集' : '部署を追加'}</DialogTitle>
        <DialogDescription>
          {editing
            ? '部署の名前や表示を変更します。'
            : '部署ごとに共有フォルダが作られ、メンバーのPCには次回の同期で表示されます。'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-start gap-4">
        <DepartmentIcon icon={icon} color={color} className="mt-6 size-10 rounded-lg" />
        <div className="grid flex-1 gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="dept-name">部署名</Label>
            <Input
              id="dept-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!folderTouched) setFolder(suggestFolderName(e.target.value))
              }}
              placeholder="営業部"
              required
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dept-name-en" className="gap-0.5">
              英語名 <span className="font-normal text-muted-foreground">（任意）</span>
            </Label>
            <Input id="dept-name-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Sales" />
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="dept-folder">フォルダ名</Label>
        <Input
          id="dept-folder"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value)
            setFolderTouched(true)
          }}
          className="font-mono"
          aria-invalid={!folderValid}
          aria-describedby="dept-folder-help"
          required
        />
        <p id="dept-folder-help" className={cn('text-xs', folderValid ? 'text-muted-foreground' : 'text-destructive')}>
          {folderValid
            ? '共有フォルダの名前です。日本語・英数字と「.」「_」「-」が使えます（スペースは使えません）。'
            : '使えない文字が含まれています。日本語・英数字で始め、「.」「_」「-」以外の記号やスペースは使わないでください。'}
        </p>
        {renaming && (
          <p className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <Warning size={16} className="mt-px shrink-0 text-warning" />
            <span>
              フォルダ名を「{department.folder}」から「{folder}」に変更します。メンバーのPCでは次回の同期でフォルダの名前が変わります。
            </span>
          </p>
        )}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">アイコン</legend>
        <div role="radiogroup" aria-label="アイコン" className="flex flex-wrap gap-1.5">
          {Object.entries(DEPARTMENT_ICONS).map(([key, IconComponent]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={icon === key}
              aria-label={key}
              onClick={() => setIcon(key)}
              className={cn(
                'flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                icon === key && 'border-foreground bg-accent text-foreground'
              )}
            >
              <IconComponent size={18} />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">色</legend>
        <div role="radiogroup" aria-label="色" className="flex flex-wrap gap-2">
          {DEPARTMENT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn(
                'size-7 rounded-full ring-offset-2 ring-offset-popover transition-shadow outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                color === c && 'ring-2 ring-foreground'
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor="dept-description" className="gap-0.5">
          説明 <span className="font-normal text-muted-foreground">（任意）</span>
        </Label>
        <Textarea
          id="dept-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="この部署で扱う業務や資料"
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={busy || !folderValid || !folder || !name.trim()}>
          {busy ? '保存しています…' : editing ? '保存' : '部署を追加'}
        </Button>
      </DialogFooter>
    </form>
  )
}

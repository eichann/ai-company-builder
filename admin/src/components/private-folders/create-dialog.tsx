'use client'

import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { AudienceFields } from '@/components/private-folders/audience-fields'
import { PrivateFolderHelpButton } from '@/components/private-folders/help-dialog'
import { PlacePicker, type PlaceRoot } from '@/components/private-folders/place-picker'
import {
  OutdatedClientsDialog,
  PRIVATE_FOLDER_OUTDATED_MESSAGE,
  useOutdatedClients,
} from '@/components/permissions/outdated-clients-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, departmentsApi, privateFoldersApi, type Department, type Member, type PrivateFolderDetail } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { isValidFolderName } from '@/lib/folder-name'
import { audienceRequest, defaultAudience, departmentOfPath, type Audience } from '@/lib/private-folders'
import { isSameOrAncestorPath } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'

/**
 * 非公開フォルダを作成: place, name, 見られる人 (default: the creator + the
 * department's managers), 編集できる人 and the summary line. The server
 * creates the repository and the rules in one step; the folder reaches the
 * chosen people's apps at their next sync. Owners/admins anywhere; managers
 * inside their own departments.
 */
export function CreatePrivateFolderDialog({
  open,
  onOpenChange,
  departments,
  members,
  initialPath,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  departments: Department[]
  members: Member[]
  /** Where to start (e.g. the place selected on the 権限 screen). */
  initialPath?: string
  onCreated: (folder: PrivateFolderDetail) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        {open && (
          <CreateForm
            departments={departments}
            members={members}
            initialPath={initialPath}
            onCancel={() => onOpenChange(false)}
            onCreated={(f) => {
              onCreated(f)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreateForm({
  departments,
  members,
  initialPath,
  onCancel,
  onCreated,
}: {
  departments: Department[]
  members: Member[]
  initialPath?: string
  onCancel: () => void
  onCreated: (folder: PrivateFolderDetail) => void
}) {
  const { companyId, company, isAdmin, managedDepartmentIds } = useCompany()
  const { user } = useAuth()
  const nameId = useId()

  const roots = useMemo<PlaceRoot[]>(() => {
    if (isAdmin) return [{ path: '', label: company.data?.name ?? '会社全体' }]
    return departments
      .filter((d) => managedDepartmentIds.includes(d.id))
      .map((d) => ({ path: d.folder.normalize('NFC'), label: d.name, department: d }))
  }, [isAdmin, company.data, departments, managedDepartmentIds])

  const [parent, setParent] = useState<string | null>(() => {
    const start = initialPath?.normalize('NFC')
    if (start !== undefined && roots.some((r) => isSameOrAncestorPath(r.path, start))) return start
    return roots.length === 1 ? roots[0].path : null
  })
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const department = parent === null ? undefined : departmentOfPath(parent === '' ? '' : `${parent}/_`, departments)
  const managers = useQuery(department ? `managers:${companyId}:${department.id}` : null, () =>
    departmentsApi.getManagers(companyId, department!.id)
  )
  const managerIds = useMemo(() => (managers.data?.managers ?? []).map((m) => m.userId), [managers.data])

  // The default follows the department until the user changes the list.
  const [edited, setEdited] = useState<Audience | null>(null)
  const audience = edited ?? defaultAudience(user?.id, managerIds, members)

  const { catchOutdated, dialogProps: outdatedDialog } = useOutdatedClients()

  const trimmed = name.trim()
  const fullPath = parent === null || !trimmed ? null : parent ? `${parent}/${trimmed}` : trimmed
  const nameInvalid = trimmed !== '' && !isValidFolderName(trimmed)
  const canSubmit = parent !== null && trimmed !== '' && !nameInvalid && !busy

  const create = async (force = false) => {
    if (parent === null) return
    setBusy(true)
    setNameError(null)
    try {
      const folder = await privateFoldersApi.create(companyId, { parentPath: parent, name: trimmed, ...audienceRequest(audience) }, { force })
      toast.success(`「${trimmed}」を非公開フォルダとして作成しました`, {
        description: '見られる人のアプリで、次に同期したときに届きます。',
      })
      onCreated(folder)
    } catch (err) {
      if (!force && catchOutdated(err, () => create(true))) return
      if (err instanceof ApiError && err.code === 'FOLDER_NAME_UNAVAILABLE') {
        setNameError(err.message)
      } else {
        toast.error('非公開フォルダを作成できませんでした', { description: describeError(err) })
      }
      if (force) throw err
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) void create()
      }}
    >
      <DialogHeader>
        <DialogTitle>非公開フォルダを作成</DialogTitle>
        <DialogDescription>
          選んだ人だけに届く、新しいフォルダを作ります。オーナーと管理者は常に見られます。部署の中に作ると、その部署の責任者が見られる人を変更でき、自分を加えることもできます。
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <span className="text-sm font-medium">場所</span>
        <PlacePicker companyId={companyId} roots={roots} value={parent} onChange={setParent} disabled={busy} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={nameId}>名前</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setNameError(null)
          }}
          placeholder="例：評価"
          autoComplete="off"
          aria-invalid={nameInvalid || !!nameError || undefined}
          aria-describedby={`${nameId}-hint`}
          disabled={busy}
        />
        <p id={`${nameId}-hint`} className={nameInvalid || nameError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {nameError ??
            (nameInvalid
              ? 'フォルダ名に使えない文字が含まれています。日本語・英数字・「.」「_」「-」が使えます。'
              : fullPath
                ? `作成する場所：${fullPath}`
                : '日本語・英数字・「.」「_」「-」が使えます。')}
        </p>
      </div>

      <AudienceFields
        members={members}
        managerIds={managerIds}
        value={audience}
        onChange={setEdited}
        disabled={busy}
        lockedViewerId={user?.id}
        meId={user?.id}
        inDepartment={!!department}
      />

      <DialogFooter className="sm:items-center">
        <div className="mr-auto">
          <PrivateFolderHelpButton variant="link" />
        </div>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {busy ? '作成しています…' : '作成'}
        </Button>
      </DialogFooter>

      <OutdatedClientsDialog
        {...outdatedDialog}
        description={PRIVATE_FOLDER_OUTDATED_MESSAGE}
        forceLabel="それでも作成する"
        backLabel="作成せずに戻る"
      />
    </form>
  )
}

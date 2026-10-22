'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Warning } from '@phosphor-icons/react'

import { AudienceFields } from '@/components/private-folders/audience-fields'
import { ErrorState } from '@/components/app/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { departmentsApi, privateFoldersApi, type Department, type Member, type PrivateFolderDetail } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { audienceFromDetail, audienceRequest, departmentOfPath, displayPath, sameAudience, type Audience } from '@/lib/private-folders'
import { useQuery } from '@/lib/use-query'

/** Change who can see / edit a private folder (owner/admin, the department's managers). */
export function PrivateFolderMembersDialog({
  open,
  onOpenChange,
  scopeId,
  departments,
  members,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scopeId: string | null
  departments: Department[]
  members: Member[]
  onSaved: (folder: PrivateFolderDetail) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        {open && scopeId && (
          <MembersForm
            scopeId={scopeId}
            departments={departments}
            members={members}
            onCancel={() => onOpenChange(false)}
            onSaved={(f) => {
              onSaved(f)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MembersForm({
  scopeId,
  departments,
  members,
  onCancel,
  onSaved,
}: {
  scopeId: string
  departments: Department[]
  members: Member[]
  onCancel: () => void
  onSaved: (folder: PrivateFolderDetail) => void
}) {
  const { companyId } = useCompany()
  const detail = useQuery(`private-folder:${companyId}:${scopeId}`, () => privateFoldersApi.get(companyId, scopeId))
  const department = detail.data ? departmentOfPath(detail.data.path, departments) : undefined
  const managers = useQuery(department ? `managers:${companyId}:${department.id}` : null, () =>
    departmentsApi.getManagers(companyId, department!.id)
  )
  const [edited, setEdited] = useState<Audience | null>(null)
  const [busy, setBusy] = useState(false)

  const saved = detail.data ? audienceFromDetail(detail.data) : null
  const audience = edited ?? saved
  const removed = saved && audience ? saved.viewers.filter((id) => !audience.viewers.includes(id)) : []
  const dirty = !!saved && !!audience && !sameAudience(saved, audience)
  const nameOf = (id: string) => {
    const m = members.find((x) => x.userId === id)
    return m?.name || m?.email || '名前未設定'
  }

  const save = async () => {
    if (!audience) return
    setBusy(true)
    try {
      const req = audienceRequest(audience)
      const folder = await privateFoldersApi.updateMembers(companyId, scopeId, req.viewers, req.editors)
      toast.success('見られる人を更新しました', {
        description: removed.length > 0 ? '外した人の手元からは、次の同期でこのフォルダが削除されます。' : '次の同期から反映されます。',
      })
      onSaved(folder)
    } catch (err) {
      toast.error('見られる人を更新できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>見られる人を変更</DialogTitle>
        <DialogDescription>{detail.data ? displayPath(detail.data.path, departments) : ' '}</DialogDescription>
      </DialogHeader>

      {detail.loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="読み込み中">
          <Skeleton className="h-8" />
          <Skeleton className="h-24" />
        </div>
      ) : detail.error || !audience ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : (
        <>
          <AudienceFields
            members={members}
            managerIds={(managers.data?.managers ?? []).map((m) => m.userId)}
            value={audience}
            onChange={setEdited}
            disabled={busy}
          />
          {removed.length > 0 && (
            <p className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              <Warning size={16} className="mt-px shrink-0 text-warning" aria-hidden="true" />
              <span>
                {removed.map(nameOf).join('、')}
                の手元からは、次の同期でこのフォルダが削除されます。同期していない変更も一緒に消えます。
              </span>
            </p>
          )}
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          キャンセル
        </Button>
        <Button type="button" onClick={save} disabled={!dirty || busy}>
          {busy ? '保存しています…' : '保存'}
        </Button>
      </DialogFooter>
    </div>
  )
}

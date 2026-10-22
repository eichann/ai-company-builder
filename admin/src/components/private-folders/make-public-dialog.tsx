'use client'

import { toast } from 'sonner'

import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { privateFoldersApi, type PrivateFolderSummary } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { folderName } from '@/lib/private-folders'

/**
 * 公開に戻す (owner/admin): the folder's current contents go into the
 * company's shared folder, i.e. to everyone. Cannot be taken back, so the
 * folder's name has to be typed.
 */
export function MakePublicDialog({
  folder,
  label,
  onOpenChange,
  onDone,
}: {
  folder: PrivateFolderSummary | null
  /** How the folder is shown to people (e.g. 「営業部 / 評価」). */
  label: string
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const { companyId } = useCompany()
  const name = folder ? folderName(folder.path) : ''

  return (
    <ConfirmByTypingDialog
      open={folder !== null}
      onOpenChange={onOpenChange}
      title={`「${label}」を公開に戻す`}
      description={
        <div className="space-y-2">
          <p>
            <strong className="font-medium text-foreground">このフォルダの中身が、会社の全員に届きます。</strong>
            次に同期したときに、全員の手元に配られます。
          </p>
          <p>一度配られた中身は全員の手元に残るため、あとから非公開に戻しても取り消せません。</p>
          <p>編集できる人は変わりません（閲覧だけが全員に広がります）。</p>
        </div>
      }
      confirmText={name}
      confirmLabel="公開に戻す"
      onConfirm={async () => {
        if (!folder) return
        try {
          await privateFoldersApi.makePublic(companyId, folder.scopeId)
          toast.success(`「${label}」を公開に戻しました`, { description: '全員のアプリで、次に同期したときに届きます。' })
          onOpenChange(false)
          onDone()
        } catch (err) {
          toast.error('公開に戻せませんでした', { description: describeError(err) })
          throw err
        }
      }}
    />
  )
}

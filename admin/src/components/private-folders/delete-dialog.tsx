'use client'

import { toast } from 'sonner'

import { ConfirmByTypingDialog } from '@/components/app/confirm-by-typing'
import { privateFoldersApi, type PrivateFolderSummary } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { folderName } from '@/lib/private-folders'

/**
 * 削除 (owner/admin): the folder and its contents leave every viewer's PC at
 * their next sync. The server keeps an archive of its repository that the
 * operator can restore from, but nobody gets it back from this screen — so
 * the folder's name has to be typed.
 */
export function DeletePrivateFolderDialog({
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
      title={`「${label}」を削除`}
      description={
        <div className="space-y-2">
          <p>
            <strong className="font-medium text-foreground">このフォルダとその中身が、見られる人全員のPCから消えます。</strong>
            次に同期したときに削除されます。同期していない変更も一緒に消えます。
          </p>
          <p>
            サーバーには控え（アーカイブ）が残り、誰にも配られません。誤って削除したときは、サーバーの運用担当者に復元を依頼してください。この画面からは元に戻せません。
          </p>
          <p>それまでに各自のPCに届いた内容（コピー、バックアップ、AIとの会話の記録）は取り消せません。</p>
        </div>
      }
      confirmText={name}
      confirmLabel="削除"
      onConfirm={async () => {
        if (!folder) return
        try {
          await privateFoldersApi.remove(companyId, folder.scopeId, name)
          toast.success(`「${label}」を削除しました`, {
            description: '見られる人のPCからは、次に同期したときに消えます。サーバーには控えが残っています。',
          })
          onOpenChange(false)
          onDone()
        } catch (err) {
          toast.error('削除できませんでした', { description: describeError(err) })
          throw err
        }
      }}
    />
  )
}

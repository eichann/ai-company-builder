// The questions git:sync asks, rendered as native message boxes. main.ts
// passes Electron's dialog.showMessageBox; tests pass a scripted one. The
// wording is the member-facing contract — change it deliberately.

import type { SyncDialog } from './types'

/** The subset of Electron's MessageBoxOptions that sync uses. */
export interface SyncMessageBoxOptions {
  type: 'warning'
  buttons: string[]
  defaultId: number
  cancelId: number
  title: string
  message: string
  detail: string
}

export interface MessageBoxHost {
  /** True when a window exists to show the box in (mainWindow alive). */
  hasWindow(): boolean
  showMessageBox(options: SyncMessageBoxOptions): Promise<{ response: number }>
}

export function createMessageBoxSyncDialog(host: MessageBoxHost): SyncDialog {
  return {
    canAsk: () => host.hasWindow(),

    async confirmSharedNestedRepo(repo) {
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['.git を取り除いて共有を続ける（推奨）', '同期対象から除外する', 'キャンセル'],
        defaultId: 0,
        cancelId: 2,
        title: '共有中のフォルダに別のGit情報を検出',
        message: `「${repo}」の中に別のGit管理情報(.git)が見つかりました。`,
        detail: `フォルダをコピーした際に紛れ込んだ可能性があります。\n\n・「取り除いて共有を続ける」: フォルダ内の .git だけを削除し、これまでどおり全員に共有します（ファイルは消えません）\n・「同期対象から除外する」: このフォルダを共有から外します。他のメンバーの画面からはこのフォルダが消えます\n・「キャンセル」: 何も変更せずに同期を中止します`,
      })
      if (response === 2) return 'cancel'
      if (response === 0) return 'keep-sharing'
      return 'exclude'
    },

    async confirmExternalNestedRepo(repo) {
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['同期対象から除外して続行', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
        title: '外部Gitリポジトリを検出',
        message: `「${repo}」は別のGitリポジトリです。`,
        detail: `このフォルダを同期対象外(.gitignoreに追加)にして続行します。フォルダはこのPCに残りますが、他のメンバーには共有されません。\n\n中身を共有したい場合はキャンセルし、フォルダ内の隠しフォルダ「.git」を削除してからもう一度同期してください。`,
      })
      return response === 1 ? 'cancel' : 'exclude'
    },

    async confirmDeletedFiles(deletedFiles) {
      const fileList = deletedFiles.length <= 10
        ? deletedFiles.join('\n')
        : deletedFiles.slice(0, 10).join('\n') + `\n... 他 ${deletedFiles.length - 10} ファイル`

      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['削除を含めて同期', '削除を取り消して同期', 'キャンセル'],
        defaultId: 1,
        cancelId: 2,
        title: 'ファイルの削除を検出',
        message: `${deletedFiles.length}個のファイルが削除されています。\nこの削除は同期すると全メンバーに反映されます。`,
        detail: fileList,
      })
      if (response === 2) return 'cancel'
      if (response === 1) return 'restore'
      return 'sync-deletions'
    },

    async confirmProtectedConfigRestore(protectedFiles) {
      const shown = protectedFiles.length <= 10
        ? protectedFiles
        : [...protectedFiles.slice(0, 10), `... 他 ${protectedFiles.length - 10} ファイル`]
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['サーバーの状態に戻して同期する（推奨）', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
        title: '管理者だけが変更できるファイル',
        message: 'このファイルは管理者だけが変更できます。',
        detail: `次のファイルは、チャットのAIが自動で実行する設定（または、自動実行の設定を含むスキル・エージェント・コマンド）です。会社のオーナー・管理者以外が変更した内容は共有できないため、同期が止まっています。\n\n${shown.join('\n')}\n\n・「サーバーの状態に戻して同期する」: これらのファイルだけをサーバーの状態に戻し（サーバーに無いファイルはこのPCから取り除き）、その他の変更はそのまま共有します。あなたが編集した版は .backups/ に保存されます\n・「キャンセル」: 何も変更せずに同期を中止します（変更はこのPCに残ります）\n\nスキル等は、自動実行の設定（hooks、mcpServers、!\`…\` など）を取り除いてから同期すれば、そのまま共有できます。配布が必要な場合は、管理者に依頼してください。`,
      })
      return response === 1 ? 'cancel' : 'restore'
    },

    async confirmWriteDeniedRestore(deniedFiles) {
      const shown = deniedFiles.length <= 10
        ? deniedFiles
        : [...deniedFiles.slice(0, 10), `... 他 ${deniedFiles.length - 10} ファイル`]
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['元に戻して残りを同期', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
        title: '編集できないファイルがあります',
        message: '編集する権限がないフォルダのファイルが変更されています。',
        detail: `次のファイルは、あなたに編集する権限がないフォルダにあります。これらの変更は共有できないため、同期が止まっています。\n\n${shown.join('\n')}\n\n・「元に戻して残りを同期」: これらのファイルだけをサーバーの状態に戻し（サーバーに無いファイルはこのPCから取り除き）、その他の変更はそのまま共有します。あなたが編集した版は .backups/ に保存されます\n・「キャンセル」: 何も変更せずに同期を中止します（変更はこのPCに残ります）\n\n編集が必要な場合は、そのフォルダの管理者に権限を依頼してください。`,
      })
      return response === 1 ? 'cancel' : 'restore'
    },
  }
}

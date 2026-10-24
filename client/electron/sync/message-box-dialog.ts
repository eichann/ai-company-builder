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

    // Nested repositories (owner decision 2026-10-24): the default never
    // shares anything new and never changes what teammates see. "Exclude"
    // is this computer only (.git/info/exclude, see ./nested-repos.ts).
    async confirmSharedNestedRepo(repo) {
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['このPCで増えたファイルは共有しない（おすすめ）', '.git を削除して中身をすべて共有する', 'キャンセル'],
        defaultId: 0,
        cancelId: 2,
        title: '共有中のフォルダに、別の場所から取り込んだ情報があります',
        message: `共有中のフォルダ「${repo}」の中に、GitHub など別の場所から取り込んだときの管理情報（隠しフォルダ「.git」）が見つかりました。`,
        detail: `・「このPCで増えたファイルは共有しない」: すでに共有されているファイルは、これまでどおり全員と同期します。このPCでこのフォルダに増えたファイルは、ほかのメンバーには共有しません。ほかのメンバーの画面からは何も消えません\n・「.git を削除して中身をすべて共有する」: 隠しフォルダ「.git」（取り込み元とのつながりの記録）を削除し、中のファイルをすべて会社の全員に共有します。パスワードなど、共有してはいけない情報が入っていないか確かめてから選んでください\n・「キャンセル」: 何も変更せずに同期を中止します\n\n会社として管理したい場合は、管理者に『外部リポジトリ』として登録してもらってください。`,
      })
      if (response === 2) return 'cancel'
      if (response === 1) return 'keep-sharing'
      return 'exclude'
    },

    async confirmExternalNestedRepo(repo) {
      const { response } = await host.showMessageBox({
        type: 'warning',
        buttons: ['共有せず、このPCだけに置く（おすすめ）', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
        title: '別の場所から取り込んだフォルダがあります',
        message: `「${repo}」は、GitHub など別の場所から取り込んだフォルダのようです。`,
        detail: `このようなフォルダには、会社で共有してはいけない情報（パスワードなど）が入っていることがあるため、共有しません。\n\n・「共有せず、このPCだけに置く」: フォルダはこのPCにそのまま残り、ほかのメンバーには共有されません。ほかのメンバーの画面には何も起きません\n・「キャンセル」: 何も変更せずに同期を中止します\n\n会社として管理したい場合は、管理者に『外部リポジトリ』として登録してもらってください。`,
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

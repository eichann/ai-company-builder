// 「非公開フォルダについて」 — what a private folder does and does not protect.
//
// The same text is in the desktop app: client/shared/private-folder-help.ts.
// The admin cannot import from client/ or the repo-root shared/ (its Docker
// build copies admin/ only), so the two files are kept identical by hand and
// admin/tests/private-folder-help.test.ts fails when they drift.

export interface PrivateFolderHelpItem {
  title: string
  body: string
}

export const PRIVATE_FOLDER_HELP_TITLE = '非公開フォルダについて'

export const PRIVATE_FOLDER_HELP: readonly PrivateFolderHelpItem[] = [
  {
    title: '見られる人を変えられる人',
    body: 'オーナーと管理者は、すべての非公開フォルダを常に見られます。部署の責任者は、自分の部署の中にある非公開フォルダの「見られる人」を変更でき、自分を加えることもできます。',
  },
  {
    title: '見られる人から外したとき',
    body: '見られる人から外しても、それまでにその人のPCに届いた内容（コピー、バックアップ、AIとの会話の記録）は取り消せません。',
  },
  {
    title: 'あとから移したファイル',
    body: '公開の場所にあったファイルを非公開フォルダへ移しても、それまでに配られた分と過去の版は、全員のPCと会社の履歴に残ります。最初から非公開フォルダで作ってください。',
  },
  {
    title: 'AIとの関係',
    body: '見られる人のAIは、非公開の内容を読めます。公開の場所に書き込もうとすると確認が出ます。AIに送った内容は、各自のAIサービスのアカウントにも送られます。',
  },
  {
    title: 'フォルダの名前',
    body: '非公開フォルダの名前に、個人名や評価・処分の内容を入れないでください。',
  },
  {
    title: '公開に戻すとき',
    body: '「公開に戻す」と、中身は全員に配られます。取り消せません。',
  },
  {
    title: 'パスワードやAPIキー',
    body: 'パスワードやAPIキーは、非公開フォルダにも置かないでください。',
  },
]

/** Appended wherever removing a viewer is described (members dialog, toast). */
export const REMOVED_VIEWER_CAVEAT =
  'ただし、それまでにその人のPCに届いた内容（コピー、バックアップ、AIとの会話の記録）は取り消せません。'

/** Under 見られる人 for a folder inside a department (create / members dialogs). */
export const MANAGERS_MAY_CHANGE_VIEWERS = 'この部署の責任者は、見られる人をあとから変更でき、自分を加えることもできます。'

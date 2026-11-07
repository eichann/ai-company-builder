/**
 * The words for a company with or without the shared company folder (全社フォルダ;
 * shared/core/company-folder.ts, owner decision 2026-11-07). Chosen when the company is
 * created; it cannot be changed afterwards.
 */
import type { CompanyFolderKind } from '../../../shared/core/company-folder'

export const FOLDER_KIND_CHOICES: Array<{ kind: CompanyFolderKind; label: string; help: string }> = [
  {
    kind: 'git',
    label: '全社フォルダを使う（今までどおり）',
    help: '会社の共有フォルダを用意し、メンバーは同期ボタンでファイルをやりとりします。',
  },
  {
    kind: 'none',
    label: '全社フォルダを使わない（各自の PC のフォルダだけ）',
    help: 'ファイルは共有しません。AI は各自の PC のフォルダで作業します。やること・記録・承認・つなぎ先はこれまでどおり使えます。',
  },
]

export const FOLDER_KIND_FIXED = 'あとから変えることはできません。'

/** Shown where a page is about folders, for a company without the shared folder. */
export const NO_COMPANY_FOLDER_NOTE = {
  title: 'この会社は全社フォルダを使わない設定です',
  description: '共有のフォルダがないため、フォルダごとの編集の権限や非公開フォルダはありません。部署は「部署」のページで管理します。',
}

/**
 * Words for pages a company without the shared folder sees, where a git company's words talk
 * about files being synced or downloaded (owner decision 2026-11-07). Git companies keep theirs.
 */
export const NO_FOLDER_WORDS = {
  inviteDepartments:
    '参加すると、選んだ部署に所属します。部署は、所属・記録の置き場所・お願いの届け先に使います。選ばないときは、あとから部署のページで入れられます。',
  memberRole: 'メンバーは、やること・記録・承認や AI スキルを使えます。管理画面の設定は変更できません。',
  memberRoleDescription: 'やること・記録・承認や AI スキルを使えます。管理画面の設定は変更できません。',
  removeMember: 'さんは、この会社のやること・記録などを見られなくなります。本人のPCにあるファイルは削除されません。',
  leaveCompany: '退出すると、この会社のやること・記録などを見られなくなります。PCにあるファイルは削除されません。',
  departmentsStepHint: '部署は、所属・記録の置き場所・お願いの届け先に使います。',
  nothingToDo: '全員のアプリが最新です。',
}

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

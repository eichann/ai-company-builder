// Push-rejection markers written by the server's pre-receive hook
// (server/src/templates/pre-receive-hook.sh), explained for non-engineers.

export interface RejectionExplanation {
  title: string
  /** What the member (or an admin) should do about it. */
  advice: string
}

const EXPLANATIONS: Record<string, RejectionExplanation> = {
  PROTECTED_CONFIG: {
    title: '管理者だけが変更できる設定ファイルが含まれていた',
    advice: 'AIが確認なしにコマンドを実行する設定は、オーナー・管理者だけが共有できます。必要なら管理者が代わりに配布してください。',
  },
  PERSONAL_PATH: {
    title: '個人用フォルダ(.personal)のファイルが含まれていた',
    advice: '.personal の中身は共有できません。アプリが自動で共有対象から外すので、もう一度同期すれば解消します。',
  },
  SECRET_DETECTED: {
    title: 'APIキーやパスワードなどの秘密情報が含まれていた',
    advice: '該当ファイルから秘密情報を削除してから、もう一度同期するよう案内してください。',
  },
  WINPATH_DETECTED: {
    title: 'Windowsで扱えない名前のファイルが含まれていた',
    advice: 'そのまま共有するとWindowsのメンバー全員の同期が失敗します。< > : " \\ | ? * を含む名前や、末尾がドット・スペースの名前を変えてから同期してください。',
  },
  GITLINK_DETECTED: {
    title: '別のGitリポジトリを含むフォルダが含まれていた',
    advice: 'そのフォルダ内の .git を削除して通常のフォルダにするか、共有対象から外してから同期してください。',
  },
}

/** Explanation for a known marker, or null to show the raw marker. */
export function explainRejection(marker: string): RejectionExplanation | null {
  return EXPLANATIONS[marker.replace(/^\[|\]$/g, '').trim()] ?? null
}

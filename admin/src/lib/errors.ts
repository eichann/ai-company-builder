import { ApiError } from './api'

// The API answers in English for developers; the people using this panel are
// non-engineers, so each failure is restated in Japanese with what to do next.
const KNOWN_MESSAGES: Array<[RegExp, string]> = [
  [/folder with this name already exists/i, '同じ名前のフォルダがすでにあります。別のフォルダ名にしてください。'],
  [/invalid folder name/i, 'フォルダ名に使えない文字が含まれています。日本語・英数字・「.」「_」「-」が使えます。'],
  [/department name is required/i, '部署名を入力してください。'],
  [/cannot remove the owner/i, 'オーナーは削除できません。'],
  [/invalid email or password|invalid password|user not found/i, 'メールアドレスまたはパスワードが正しくありません。'],
  [/signup is disabled/i, '新規登録は招待リンクからのみ行えます。管理者に招待リンクを依頼してください。'],
  [/user already exists|already registered/i, 'このメールアドレスはすでに登録されています。ログインしてから招待を受け入れてください。'],
  [/password too short/i, 'パスワードは8文字以上にしてください。'],
  [/not members of this company/i, '選んだ人の中に、この会社のメンバーではない人がいます。ページを再読み込みしてから選び直してください。'],
  [/at most \d+ managers/i, '1つの部署に設定できる責任者は50人までです。'],
  [/already a member/i, 'すでにこの会社のメンバーです。'],
  [/read access is not available yet/i, '閲覧の制限はまだ使えません（今後のアップデートで対応予定）。いまは「編集できる」か「閲覧のみ」を選べます。'],
  [/always read and edit everything/i, 'オーナーと管理者は常にすべて閲覧・編集できるため、ルールは不要です。'],
  [/rule for everyone cannot be removed/i, '「全員」のルールは、ほかのルールがある間は削除できません。「閲覧のみ」に変えるか、「上の階層に合わせる」で個別ルールをまとめて解除してください。'],
  [/company-wide rules? cannot be removed/i, '会社全体のルールは削除できません。「編集できる」「閲覧のみ」を切り替えて調整してください。'],
  [/needs a rule for everyone/i, '個別の設定には「全員」の扱い（編集できる／閲覧のみ）が必要です。ページを再読み込みしてからやり直してください。'],
  [/each subject may appear only once/i, '同じ人や役割が二重に指定されています。ページを再読み込みしてからやり直してください。'],
  [/folder not found in the company repository/i, 'このフォルダは会社の共有フォルダにまだありません。誰かが作成して同期してから設定してください。'],
  [/hidden folders have built-in rules/i, '「.」で始まるフォルダには組み込みのルールがあり、個別に設定できません。'],
  [/managers of this department can change/i, 'この場所の権限を変更できるのは、オーナー・管理者と、その部署の責任者です。'],
  [/cannot recover from a write restriction/i, '古いアプリを使っているメンバーがいるため保存できませんでした。先にアプリを更新してもらってください。'],
  [/can save despite outdated apps/i, '古いアプリを使っているメンバーがいるときに保存できるのは、オーナーと管理者だけです。'],
  [/destination folder .*already has rules/i, '移動先のフォルダ（またはその中のフォルダ）には、すでに個別のルールがあります。別のフォルダを選ぶか、先にそちらのルールを解除してください。'],
  [/cannot be moved into or out of their own folder/i, 'ルールは、元のフォルダの中や、その上のフォルダには移せません。'],
  [/last owner cannot be demoted/i, '最後のオーナーの役割は変更できません。先にほかのメンバーをオーナーにしてください。'],
  [/only owners can change member roles/i, '役割を変更できるのはオーナーだけです。'],
  [/company name is required/i, '会社名を入力してください。'],
  [/company name must be at most/i, '会社名は100文字以内にしてください。'],
  [/company name contains invalid characters/i, '会社名に使えない文字（改行など）が含まれています。'],
  [/invitation.*(expired|used|invalid|not found)/i, 'この招待リンクは無効か、有効期限が切れています。管理者に新しいリンクを依頼してください。'],
]

/** A Japanese sentence explaining a failed request and the next step. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    for (const [re, msg] of KNOWN_MESSAGES) {
      if (re.test(err.message)) return msg
    }
    switch (err.status) {
      case 401:
        return 'ログインの有効期限が切れました。もう一度ログインしてください。'
      case 403:
        return 'この操作を行う権限がありません。オーナーか管理者に依頼してください。'
      case 404:
        return '対象が見つかりません。ページを再読み込みして最新の状態を確認してください。'
      case 409:
        return 'ほかの変更と競合しました。ページを再読み込みしてからやり直してください。'
      default:
        if (err.status >= 500) {
          return 'サーバーでエラーが発生しました。少し待ってからもう一度お試しください。'
        }
        return `操作できませんでした（${err.message}）。`
    }
  }
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError when the network or server is unreachable.
    return 'サーバーに接続できません。ネットワークを確認して、もう一度お試しください。'
  }
  return '予期しないエラーが発生しました。ページを再読み込みしてください。'
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403
}

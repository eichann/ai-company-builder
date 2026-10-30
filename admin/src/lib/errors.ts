import { ApiError, ApiTimeoutError } from './api'

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
  [/parent folder not found/i, '作成する場所のフォルダが見つかりません。ページを再読み込みしてから選び直してください。'],
  [/folders inside a private folder are private already/i, '非公開フォルダの中には、非公開フォルダを作れません。中に作るフォルダは自動的に非公開になります。'],
  [/only owners, admins and department managers can (create|list) private folders/i, '非公開のフォルダを扱えるのは、オーナー・管理者と部署の責任者です。'],
  [/managers can create private folders only inside their own department/i, '部署の責任者が非公開のフォルダを作れるのは、自分の部署の中だけです。'],
  [/every editor must also be a viewer/i, '編集できる人は、見られる人の中から選んでください。'],
  [/^not a member of this company$/i, '選んだ人の中に、この会社のメンバーではない人がいます。ページを再読み込みしてから選び直してください。'],
  [/only owners and admins can make a private folder public/i, '公開に戻せるのは、オーナーと管理者だけです。'],
  [/only owners and admins can delete a private folder/i, '非公開フォルダを削除できるのは、オーナーと管理者だけです。'],
  [/type the folder name to confirm the deletion/i, '確認のフォルダ名が一致しませんでした。ページを再読み込みしてから、もう一度フォルダ名を入力してください。'],
  [/a push to this folder is still running/i, 'いま誰かがこのフォルダを同期しています。少し待ってからもう一度お試しください。'],
  [/something already exists at this path in the company repository/i, '会社の共有フォルダの同じ場所に、すでにフォルダかファイルがあります。そちらの名前を変えてからやり直してください。'],
  [/the company repository kept changing/i, '共有フォルダが同期され続けていて完了できませんでした。少し待ってからもう一度お試しください。'],
  [/private folder always keeps its own rules/i, '非公開フォルダには、見られる人の設定が必ず必要です。「非公開フォルダ」画面で見られる人を変更してください。'],
  [/cannot handle private folders yet/i, '古いアプリを使っているメンバーがいるため作成できませんでした。先にアプリを更新してもらってください。'],
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
  [/only owners and admins can view the ai action log/i, 'AI の操作の記録を見られるのは、オーナーと管理者です（設定によっては部署の責任者も、自分の部署の分だけ見られます）。'],
  [/only owners and admins can manage the ai action log settings/i, 'AI の操作の記録の設定を変えられるのは、オーナーと管理者だけです。'],
  [/^at most \d+ days$/i, '一度に見られる期間は400日までです。期間を短くしてください。'],
  [/host cannot change while keys exist|keys registered for this service go to other hosts/i, 'このサービスに鍵が登録されているため、送り先のホスト名は変えられません。先にそのサービスの鍵を削除してください。'],
  [/delete the keys registered for this service first/i, 'このサービスに鍵が登録されているため、削除できません。先にそのサービスの鍵を削除してください。'],
  [/this service's requests go to .* only/i, 'このサービスの送り先は、登録したときのホストだけです。ほかのホストは書けません。'],
  [/the service refused this key/i, 'この鍵は使えませんでした（発行元の画面で確かめてください）。保存していません。'],
  [/this service has no known destination/i, 'このサービスは送り先が決まっていないため、「詳しい設定」で自分の鍵の送り先を書いてください。'],
  [/invitation.*(expired|used|invalid|not found)/i, 'この招待リンクは無効か、有効期限が切れています。管理者に新しいリンクを依頼してください。'],
]

/** A Japanese sentence explaining a failed request and the next step. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    // Already Japanese and exact (shared/types/private-folders.ts reservedPathMessage).
    if (err.code === 'FOLDER_NAME_UNAVAILABLE' && err.message) return err.message
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
  if (err instanceof ApiTimeoutError) {
    return 'サーバーから応答がありません。少し待ってからもう一度お試しください。'
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

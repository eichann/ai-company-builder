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

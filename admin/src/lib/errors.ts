import { ApiError, ApiTimeoutError, INVALID_RESPONSE } from './api'
import { jobProblemText } from './jobs'
import { JOB_RETRY_BLOCKS } from '../../../shared/core/jobs'
import { jobRetryBlockText } from '../../../shared/core/job-words'

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
  [/only owners, admins and department managers can (create|list) private folders/i, '非公開のフォルダを扱えるのは、オーナー・管理者と部署の管理役です。'],
  [/managers can create private folders only inside their own department/i, '部署の管理役が非公開のフォルダを作れるのは、自分の部署の中だけです。'],
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
  [/at most \d+ managers/i, '1つの部署に設定できる管理役は50人までです。'],
  [/already a member/i, 'すでにこの会社のメンバーです。'],
  [/read access is not available yet/i, '閲覧の制限はまだ使えません（今後のアップデートで対応予定）。いまは「編集できる」か「閲覧のみ」を選べます。'],
  [/^unknown group$/i, '選んだ見える人のまとまりが見つかりません。削除されたかもしれません。ページを再読み込みしてから選び直してください。'],
  [/a rule that lets someone edit must also let them read/i, '記録を置ける人は、見られる人の中から選んでください。'],
  [/^path (contains invalid characters|is too long)$|a folder name in path is too long/i, 'この場所の名前は使えません。短く、記号の少ない名前にしてください。'],
  [/always read and edit everything/i, 'オーナーと管理者は常にすべて閲覧・編集できるため、ルールは不要です。'],
  [/rule for everyone cannot be removed/i, '「全員」のルールは、ほかのルールがある間は削除できません。「閲覧のみ」に変えるか、「上の階層に合わせる」で個別ルールをまとめて解除してください。'],
  [/company-wide rules? cannot be removed/i, '会社全体のルールは削除できません。「編集できる」「閲覧のみ」を切り替えて調整してください。'],
  [/needs a rule for everyone/i, '個別の設定には「全員」の扱い（編集できる／閲覧のみ）が必要です。ページを再読み込みしてからやり直してください。'],
  [/each subject may appear only once/i, '同じ人や役割が二重に指定されています。ページを再読み込みしてからやり直してください。'],
  [/folder not found in the company repository/i, 'このフォルダは会社の共有フォルダにまだありません。誰かが作成して同期してから設定してください。'],
  [/hidden folders have built-in rules/i, '「.」で始まるフォルダには組み込みのルールがあり、個別に設定できません。'],
  [/managers of this department can change/i, 'この場所の権限を変更できるのは、オーナー・管理者と、その部署の管理役です。'],
  [/cannot recover from a write restriction/i, '古いアプリを使っているメンバーがいるため保存できませんでした。先にアプリを更新してもらってください。'],
  [/can save despite outdated apps/i, '古いアプリを使っているメンバーがいるときに保存できるのは、オーナーと管理者だけです。'],
  [/destination folder .*already has rules/i, '移動先のフォルダ（またはその中のフォルダ）には、すでに個別のルールがあります。別のフォルダを選ぶか、先にそちらのルールを解除してください。'],
  [/cannot be moved into or out of their own folder/i, 'ルールは、元のフォルダの中や、その上のフォルダには移せません。'],
  [/last owner cannot be demoted/i, '最後のオーナーの役割は変更できません。先にほかのメンバーをオーナーにしてください。'],
  [/only owners can change member roles/i, '役割を変更できるのはオーナーだけです。'],
  [/company name is required/i, '会社名を入力してください。'],
  [/company name must be at most/i, '会社名は100文字以内にしてください。'],
  [/company name contains invalid characters/i, '会社名に使えない文字（改行など）が含まれています。'],
  [/only owners and admins can view the ai action log/i, 'AI の操作の記録を見られるのは、オーナーと管理者です（設定によっては部署の管理役も、自分の部署の分だけ見られます）。'],
  [/only owners and admins can manage the ai action log settings/i, 'AI の操作の記録の設定を変えられるのは、オーナーと管理者だけです。'],
  [/^at most \d+ days$/i, '一度に見られる期間は400日までです。期間を短くしてください。'],
  [/host cannot change while keys exist|keys registered for this service go to other hosts/i, 'このサービスに鍵が登録されているため、送り先のホスト名は変えられません。先にそのサービスの鍵を削除してください。'],
  [/delete the keys registered for this service first/i, 'このサービスに鍵が登録されているため、削除できません。先にそのサービスの鍵を削除してください。'],
  [/this service's requests go to .* only/i, 'このサービスの送り先は、登録したときのホストだけです。ほかのホストは書けません。'],
  [/the service refused this key/i, 'この鍵は使えませんでした（発行元の画面で確かめてください）。保存していません。'],
  [/this service has no known destination/i, 'このサービスは送り先が決まっていないため、「詳しい設定」で自分の鍵の送り先を書いてください。'],
  [/invitation.*(expired|used|invalid|not found)/i, 'この招待リンクは無効か、有効期限が切れています。管理者に新しいリンクを依頼してください。'],
]

/** Error codes whose `error` the server writes in Japanese for the person (shown as is). */
const JAPANESE_CODES: ReadonlySet<string> = new Set([
  'GROUP_NAME_TAKEN', 'BAD_GROUP_NAME', 'GROUP_IN_USE', 'RESTRICTED_PLACES_INSIDE', 'READERS_OWNER_ONLY', 'MANAGERS_CHANGED',
])

/** A Japanese sentence explaining a failed request and the next step. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    // Not JSON, or not the shape the page expects (api-schemas.ts): nothing broken is shown.
    if (err.code === INVALID_RESPONSE) {
      return 'サーバーからの応答を正しく読み取れなかったため、表示を止めました。ページを再読み込みしてください。続くときはサーバーの運用担当者に知らせてください。'
    }
    // Already Japanese and exact (shared/types/private-folders.ts reservedPathMessage).
    if (err.code === 'FOLDER_NAME_UNAVAILABLE' && err.message) return err.message
    // Japanese already (server/src/services/companies.ts COMPANY_CREATION_FORBIDDEN, COMPANY_CREATION_FAILED).
    if ((err.code === 'COMPANY_CREATION_RESTRICTED' || err.code === 'COMPANY_CREATION_FAILED') && err.message) return err.message
    // Japanese already (server/src/services/groups.ts, departments.ts, task-settings.ts: 見える人のまとまり).
    if (err.code && JAPANESE_CODES.has(err.code) && err.message) return err.message
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

/**
 * The job codes whose `error` the server writes as one fixed Japanese sentence for the person (`server/src/services/jobs.ts`,
 * `job-retry.ts`: never a name, a place or a value) — shown as is by 「定期の仕事」 (stage 4b-3: before, a refusal such as
 * 「画面に出ていた内容と違います…」 read as the generic 「ほかの変更と競合しました」).
 */
const JOB_SENTENCE_CODES: ReadonlySet<string> = new Set([
  'JOB_NOT_FOUND', 'JOB_VERSION_NOT_FOUND', 'JOB_VERSION_FINGERPRINT', 'JOB_OWNER_NOT_MEMBER', 'JOB_GRANT_EXCEEDS', 'JOB_SKILL_MISSING',
  'JOB_SKILL_NOT_HERE', 'JOB_SKILL_CHANGED', 'JOB_NOT_RESPONSIBLE', 'JOB_RETIRED', 'JOB_PLACE_NEEDED', 'JOB_PLACE_NOT_USABLE',
  'JOB_SCHEMA_UNKNOWN', 'JOB_NEEDS_NEWER_SCREEN', 'JOB_TRIGGER_NOT_ALLOWED', 'JOB_ACCEPT_SEPARATELY', 'JOB_NOT_APPROVED',
  'JOB_PAUSED_BY_OTHER', 'JOB_NOT_ACCEPTED', 'JOB_DRAFT_WAITING',
  // A resume whose pause changed while it was checked (SERVERCORE-1, jobs.md "Resume checks again").
  'JOB_PAUSE_CHANGED',
  // Member proposals (jobs.md "Member proposals", services/jobs.ts and job-proposals.ts): fixed sentences, no name or place.
  'JOB_PROPOSAL_ONLY', 'JOB_PROPOSAL_SCHEMA', 'JOB_PROPOSAL_CLOSED', 'JOB_PROPOSAL_RESPONSIBLE_FIXED', 'JOB_VERSION_NOT_LATEST',
  'JOB_PROPOSAL_NOT_FOUND', 'JOB_PROPOSAL_DECIDED',
])

/** A job request refused with a code (or none) this console does not know, whatever the status: never the server's text. */
export const JOB_REFUSED_GENERAL = 'できませんでした。ページを再読み込みしてから、もう一度ためしてください。'

/**
 * A refused job request in plain Japanese (「定期の仕事」, jobs.md "The screens"): a definition the server refused by its
 * problem codes (`jobProblemText`, the form's own words — never a value); a job code with the server's fixed sentence as
 * the server wrote it; a 「もう一度」 refusal by its code (`jobRetryBlockText`); anything else as `describeError`, except
 * that its fallback for an unhandled 4xx (「操作できませんでした（<the server's text>）」) becomes `JOB_REFUSED_GENERAL` —
 * an unknown code's text is never shown (independent review of 4b-3).
 */
export function describeJobError(err: unknown): string {
  if (err instanceof ApiError && err.code) {
    if (err.code === 'BAD_JOB_DEFINITION') {
      const problems = Array.isArray(err.body?.problems) ? (err.body.problems as unknown[]).filter((p): p is string => typeof p === 'string') : []
      return jobProblemText(problems)
    }
    if (JOB_SENTENCE_CODES.has(err.code) && err.message) return err.message
    if ((JOB_RETRY_BLOCKS as readonly string[]).includes(err.code)) return `${jobRetryBlockText(err.code)}。`
  }
  // `describeError`'s own sentences for a status (401, 403, 404, 409, 5xx), a broken answer, a timeout or no network stay;
  // its fallback would print the server's text.
  if (err instanceof ApiError && err.code !== INVALID_RESPONSE && err.status < 500 && ![401, 403, 404, 409].includes(err.status)) return JOB_REFUSED_GENERAL
  return describeError(err)
}

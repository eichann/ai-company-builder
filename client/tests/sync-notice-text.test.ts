// What sync tells a member when the server was out of reach or someone else
// changed the same file (client/shared/sync-notice-text.ts): members have no Git
// vocabulary, so none of these sentences may use it, and each says where their
// work is and what to press.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as notices from '../shared/sync-notice-text'
import { BACKUP_REASONS, backupReasonLabel } from '../shared/backup-reasons'

/** Words a member without Git cannot act on (and the backup folder's path). */
const GIT_WORDS = [
  'コミット', 'プッシュ', 'プル', 'マージ', 'リベース', 'ブランチ', '競合', 'コンフリクト', 'ローカル', 'リモート', 'リポジトリ',
  'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'conflict', 'remote', 'repository', '.backups',
]

function gitWordsIn(text: string): string[] {
  return GIT_WORDS.filter(word => text.toLowerCase().includes(word.toLowerCase()))
}

/** Every sentence the module can produce: its strings, and its functions over the cases they distinguish. */
function everyNoticeText(): Array<[string, string]> {
  const texts: Array<[string, string]> = []
  for (const [name, value] of Object.entries(notices)) {
    if (typeof value === 'string') texts.push([name, value])
    else if (typeof value === 'function') {
      for (const args of [[3, 0], [0, 2], [1, 1], ['管理者だけが変更できる', true], ['編集する権限がないフォルダの', false]]) {
        texts.push([`${name}(${args.join(', ')})`, String((value as (...a: unknown[]) => unknown)(...args))])
      }
    } else assert.fail(`${name}: an export of sync-notice-text.ts is neither a sentence nor makes one`)
  }
  return texts
}

test('no sync notice about the server or a file changed by two people uses a Git word', () => {
  const texts = everyNoticeText()
  assert.ok(texts.length >= 6)
  for (const [name, text] of texts) assert.deepEqual(gitWordsIn(text), [], `${name}: ${text}`)
})

test('a notice whose work did not reach the server says it is kept here and to press the sync button again', () => {
  assert.match(notices.PUSH_FAILED_MESSAGE, /このPCには保存しましたが、サーバーに届けられませんでした/)
  assert.match(notices.SERVER_UNREACHABLE_MESSAGE, /サーバーにつながらなかったため、同期できませんでした/)
  assert.doesNotMatch(notices.SERVER_UNREACHABLE_MESSAGE, /完了/)
  for (const text of [notices.PUSH_FAILED_MESSAGE, notices.SERVER_UNREACHABLE_MESSAGE, notices.refusedThenPushFailedMessage('管理者だけが変更できる', true)]) {
    assert.match(text, /もう一度［サーバーと同期］を押してください/)
  }
})

test('a file someone else changed too: the server version stayed, a deletion is told apart, and the member\'s version is in バックアップ履歴', () => {
  const both = notices.sameFileChangedMessage(2, 1)
  assert.match(both, /2件のファイルは、ほかの人も同じところを変えていたため、サーバーの版を残しました/)
  assert.match(both, /1件のファイルは、あなたが変えている間にほかの人が削除していたため、削除しました/)
  assert.match(both, /タイトルバーの［バックアップ履歴］/)
  assert.doesNotMatch(notices.sameFileChangedMessage(0, 1), /サーバーの版を残しました/)
  assert.doesNotMatch(notices.sameFileChangedMessage(1, 0), /削除/)
  assert.match(notices.SAME_FILE_UNRESOLVED_MESSAGE, /［バックアップ履歴］/)
})

test('every kind of backup the app writes has words of its own in the backup history, never the code or a Git word', () => {
  for (const reason of BACKUP_REASONS) {
    const label = backupReasonLabel(reason)
    assert.notEqual(label, reason)
    assert.match(label, /[぀-ヿ一-鿿]/, `${reason}: ${label}`)
    assert.deepEqual(gitWordsIn(label), [], `${reason}: ${label}`)
  }
  assert.match(backupReasonLabel('conflict'), /ほかの人も同じところを変えていた/)
  // A newer app's kind this one does not know reads as 「その他」, not as its code.
  assert.equal(backupReasonLabel('from_a_newer_app'), 'その他のバックアップ')
})

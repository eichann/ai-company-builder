// What the app tells a member about sync and the copies it keeps: members have
// no Git vocabulary and never see the `.backups` folder (Finder hides it), so no
// sentence there may use a Git word or the folder's path; each points to the title
// bar's ［バックアップ履歴］ instead. Two guards: every export of
// client/shared/sync-notice-text.ts, and every Japanese string in the files that
// say such things (read with the TypeScript parser, so a new sentence there is
// checked without being listed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import * as notices from '../shared/sync-notice-text'
import { BACKUP_REASONS, backupReasonLabel } from '../shared/backup-reasons'

const CLIENT = path.resolve(import.meta.dirname, '..')

/** Words a member without Git cannot act on, and the backup folder's path. */
const GIT_WORDS = [
  'コミット', 'プッシュ', 'プル', 'マージ', 'リベース', 'ブランチ', '競合', 'コンフリクト', 'ローカル', 'リモート', 'リポジトリ',
  'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'conflict', 'remote', 'repository', '.backups',
]

function gitWordsIn(text: string): string[] {
  return GIT_WORDS.filter(word => text.toLowerCase().includes(word.toLowerCase()))
}

/** Where the app's sentences about sync, its stops and its kept copies live. */
const MEMBER_TEXT_SOURCES = [
  'shared/sync-notice-text.ts',
  'electron/sync',
  'electron/services/close-guard.ts',
  'electron/features/backups',
  'electron/features/git-history/ipc.ts',
  'electron/protected-config.ts',
  'src/features/sync',
  'src/features/editor/components/EditorNotices.tsx',
  'src/features/editor/hooks/useFileSaving.ts',
  'src/features/settings/components/DownloadFoldersSection.tsx',
  // The join screen (its place, refusals and the working folder's notes) and the setup screen.
  'src/features/company/components/JoinScreen.tsx',
  'src/features/company/components/SetupProgress.tsx',
  'src/features/company/components/DepartmentPicker.tsx',
  'src/features/company/components/CompanySelector.tsx',
  'src/features/company/folderSetup.ts',
  'src/features/company/folderPlan.ts',
]

/**
 * Sentences that must name the folder itself: they are about the member's own files
 * inside `.backups` / `.workspace`, which can never be shared, so the member has to
 * find that folder.
 */
const NAMES_THE_FOLDER = [
  /^（\.backups \/ \.workspace のファイルは共有対象から外しました）$/,
  /^バックアップ（\.backups）とAIの作業用フォルダ（\.workspace）のファイルは、誰であっても共有できません。/,
  /^バックアップ・作業用フォルダ（\.backups \/ \.workspace）のファイル/,
]

function sourceFiles(rel: string): string[] {
  const abs = path.join(CLIENT, rel)
  if (fs.statSync(abs).isFile()) return [abs]
  return fs.readdirSync(abs, { recursive: true, encoding: 'utf-8' })
    .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map(f => path.join(abs, f))
}

/** Every string a file can show: literals, template parts and JSX text that hold Japanese. */
function japaneseTexts(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Array<{ line: number; text: string }> = []
  const visit = (node: ts.Node) => {
    let text: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map(s => s.literal.text)].join('…')
    else if (ts.isJsxText(node)) text = node.text.trim()
    else if (ts.isJsxElement(node)) {
      // `<code>.backups</code>` inside a sentence: the element's whole text counts.
      text = node.children.map(c => (ts.isJsxText(c) ? c.text : ts.isJsxElement(c) ? c.children.map(g => (ts.isJsxText(g) ? g.text : '')).join('') : '')).join('')
    }
    if (text && /[぀-ヿ一-鿿]/.test(text)) out.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
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

test('no sentence the app shows about sync, its stops or its kept copies names a Git word or the .backups path', () => {
  const found: string[] = []
  let read = 0
  for (const rel of MEMBER_TEXT_SOURCES) {
    for (const file of sourceFiles(rel)) {
      for (const { line, text } of japaneseTexts(file)) {
        read++
        if (gitWordsIn(text).length > 0 && !NAMES_THE_FOLDER.some(re => re.test(text))) {
          found.push(`${path.relative(CLIENT, file)}:${line}: ${gitWordsIn(text).join(', ')} — ${text.slice(0, 80)}`)
        }
      }
    }
  }
  assert.ok(read > 100, `only ${read} sentences read: the sources moved?`)
  assert.deepEqual(found, [])
})

test('every folder-naming exception still matches a sentence (one that went away is dropped from the list)', () => {
  const all = MEMBER_TEXT_SOURCES.flatMap(sourceFiles).flatMap(japaneseTexts).map(t => t.text)
  for (const re of NAMES_THE_FOLDER) assert.ok(all.some(text => re.test(text)), String(re))
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

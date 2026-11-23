// The approval banner and the list say what the AI is about to do in members' words (owner
// decision 2026-11-23: ordinary members never see developer words); the exact call stays behind
// 「くわしく」 for whoever needs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalWordsOf } from '../../../shared/tool-approval-words'
import { DANGEROUS_COMMANDS } from '../../../shared/dangerous-commands'
import { deriveConsultationStatus } from './consultationStatus'
import { ToolApprovalBanner } from './components/ToolApprovalBanner'

const ROOT = '/Users/demo/会社'

test('a command the hook asks about says what it does, never 「Bash」 or the command text', () => {
  const words = approvalWordsOf('Bash', { command: 'rm -rf 営業部/古い資料', description: 'Remove old files' })
  assert.equal(words.action, 'ファイルを消すコマンドを実行します')
  assert.equal(words.technical, 'Bash')
  assert.equal(words.exact, 'rm -rf 営業部/古い資料')
  assert.equal(approvalWordsOf('Bash', { command: 'git push --force origin main' }).action, 'サーバーにある内容を上書きするコマンドを実行します')
  assert.equal(approvalWordsOf('Bash', { command: 'ls -la' }).action, 'コマンドを実行します')
  // Codex reports a command as its argument list.
  assert.equal(approvalWordsOf('Bash', { command: ['rm', '-f', 'a.txt'] }).exact, 'rm -f a.txt')
  assert.equal(approvalWordsOf('Bash', { command: ['rm', '-f', 'a.txt'] }).action, 'ファイルを消すコマンドを実行します')
})

test('every command the hook asks about has words of its own, in Japanese', () => {
  for (const entry of DANGEROUS_COMMANDS) {
    assert.match(entry.action, /コマンドを実行します$/)
    assert.doesNotMatch(entry.action, /[A-Za-z]/, `${entry.pattern} reads in Japanese`)
  }
})

test('other calls read as what is about to happen; a tool the app does not know reads 「ほかの道具を使います」', () => {
  assert.deepEqual(approvalWordsOf('Write', { file_path: `${ROOT}/営業部/一覧.csv` }, ROOT),
    { action: 'ファイルに書きます', detail: '営業部/一覧.csv', technical: 'Write', exact: `${ROOT}/営業部/一覧.csv` })
  assert.equal(approvalWordsOf('Edit', { file_path: 'a.md' }).action, 'ファイルを直します')
  assert.equal(approvalWordsOf('WebFetch', { url: 'https://example.com/x' }).action, 'Webのページを読みます')
  const unknown = approvalWordsOf('mcp__my_crm__find_customer', {})
  assert.equal(unknown.action, 'ほかの道具を使います')
  assert.equal(unknown.technical, 'my_crm・find_customer')
})

test('the banner shows the plain words first and keeps the tool name and command inside 「くわしく」', () => {
  const html = renderToStaticMarkup(React.createElement(ToolApprovalBanner, {
    request: { toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'rm -rf 営業部/古い資料' } },
    onRespond: () => {},
  }))
  assert.match(html, /data-approval-action="true">ファイルを消すコマンドを実行します</)
  const [shown, details] = html.split('<details')
  assert.ok(details, 'the exact call is behind a disclosure')
  assert.doesNotMatch(shown, /Bash|rm -rf/, 'nothing technical before 「くわしく」')
  assert.match(details, /<summary[^>]*>くわしく<\/summary>/)
  assert.match(details, /Bash/)
  assert.match(details, /rm -rf 営業部\/古い資料/)
})

test('the list says the same while a command waits for permission', () => {
  const status = deriveConsultationStatus({ status: 'streaming', unseen: false, rootPath: ROOT, approval: { toolName: 'Bash', toolInput: { command: 'rm -rf x' } } })
  assert.deepEqual(status, { state: 'needs-you', kind: 'approve', line: '許可を待っています：ファイルを消すコマンドを実行します' })
})

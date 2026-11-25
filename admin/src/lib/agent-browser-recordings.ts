// The words of 「ブラウザ操作の記録」 (agent-browser.md "Recording"), and how one recording's steps read on the page — the one
// copy of the line wording is the core's (`browserRecordingLine`), the same the member saw before sending.
import { browserRecordingLine, type BrowserRecordingContent } from '../../../shared/core/browser-recording'

export const RECORDINGS_TITLE = 'ブラウザ操作の記録'
export const RECORDINGS_LINK_DESCRIPTION = 'メンバーが送った作業の記録を見る・消す（30日で自動で消えます）'
export const RECORDINGS_INTRO =
  'メンバーがアプリの窓で1回通してやった作業の記録です。押したボタンと入力した欄の見出し、開いたページの形、送った項目の名前だけが残っています（入力した値・パスワード・ログインの情報は残りません）。見られるのは、送った本人とオーナー・管理者だけです。記録は AI には渡りません。'
export const RECORDINGS_EMPTY = 'まだ届いた記録はありません。'
export const RECORDINGS_MORE = '古い記録は表示していません。'
export const RECORDING_DELETE_TITLE = 'この記録を消しますか？'
export const RECORDING_DELETE_DESCRIPTION = '記録の中身ごと消え、元に戻せません。'
export const RECORDING_ESTIMATED_NOTE = '「推定」は、どの操作のあとに送られたか・どの答えの値と同じかを、アプリが時刻と値の一致から推し量ったものです。'

export const recordingLines = (content: BrowserRecordingContent) => content.steps.map((step) => ({ id: step.id, ...browserRecordingLine(step) }))

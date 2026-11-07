/**
 * Reading a meeting's minutes (`meeting`: received → reading → read, `minutes.md`): the first
 * kind of 「AI の番」 (`.claude/rules/ai-turns.md`).
 */
import { minutesConsultationTitle, minutesFirstMessage } from '../minutes-app'
import type { AiTurnStepDefinition } from './types'

/**
 * The automatic run's first message: the app started it and the member is not watching, so
 * questions are collected at the end instead of asked. The run has no records_get, so the
 * message names the record's version after the start (null when the server did not say).
 */
export function autoMinutesFirstMessage(base: string, version: number | null): string {
  return [
    '（アプリが AI の番として自動で始めた相談です。私はいま画面を見ていません。）',
    '',
    base,
    '',
    '自動で進めるときの決まり：',
    '- 読み始めの印（meeting__start_reading）はアプリがつけました。もう一度つけないでください。',
    ...(version !== null
      ? [`- 読み始めの印をつけたあとの会議の version は ${version} です。会議の操作（meeting__finish_reading など）の expectedVersion にはこれを使い、minutes_link_bundle でまとまりをつないだら、その答えの version を使ってください。`]
      : ['- 会議の操作（meeting__finish_reading など）の expectedVersion には、minutes_read の答えの version を使ってください。']),
    '- 「ほかの人が先に変えました」と断られたら、その答えの version でもう一度だけ試してください。',
    '- 議事録が分かれて渡されたとき（答えの more が true）は、最後の part まで全部読んでから出力を作ってください。途中で読めなかったことにはしないでください。',
    '- 議事録が長すぎて途中や最後を渡せなかったと答えにあるときは、読めたところで出力を作り、要約とお願いに、読めなかったところを答えにある書き方（「議事録が長すぎて、途中（全体のおよそ ◯%〜◯% のところ）を読めませんでした」または「議事録が長すぎて、最後まで読めませんでした」）で書いてください。',
    '- どのまとまり（案件など）の会議か決まらないときや私に聞きたいことがあるときは、作業を止めずに、最後に私へのお願いとしてまとめてください。',
    '- 最後に必ず meeting__finish_reading（読めなかったときは meeting__fail_reading）にしてください。',
  ].join('\n')
}

const meetingAt = (c: { meetingAt?: string | null }) => c.meetingAt ?? null

export const minutesReading = {
  step: 'minutes-reading',
  // `minutes-…` for a meeting made before the type was renamed `meeting`.
  recordId: /^(?:meeting|minutes)-[0-9a-z]{6,32}$/,
  listedBy: 'minutes',
  claim: { action: 'start_reading', from: 'received' },
  settle: { done: ['read'], couldNot: ['failed'], closed: ['skipped'], working: 'reading', putBack: 'retry' },
  tools: {
    // Deliberately no records_get: the run reads only its meeting (versions come from the answers).
    recordTools: [
      'minutes_read', 'minutes_link_bundle', 'meeting__start_reading', 'meeting__finish_reading', 'meeting__fail_reading',
      'records_create', 'decisions_record', 'mail_recipients', 'mail_draft_create', 'mail_draft_update', 'mail_draft_show',
    ],
    // No business plugin's operations: the まとまり's part (a deal's fields, its meeting log) is the business
    // plugin's own step once the meeting is read (plugin-steps.md "After a meeting is read"; the core names none).
    recordToolEndings: [],
    builtinTools: [],
  },
  consultationTitle: c => minutesConsultationTitle({ title: c.title, meetingAt: meetingAt(c) }),
  linksMinutes: true,
  // 決めたこと off: no decision paragraph, like the manual start (startReading.ts).
  firstMessage: (c, version, features) => autoMinutesFirstMessage(minutesFirstMessage({ id: c.id, title: c.title, meetingAt: meetingAt(c) }, features), version),
} as const satisfies AiTurnStepDefinition<'minutes-reading'>

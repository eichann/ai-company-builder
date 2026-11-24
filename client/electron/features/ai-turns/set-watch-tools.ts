// A set watch's run (4b-4 PR5, jobs.md "The set watch" "The app runs it"): its two tools, made only for the consultation main
// holds such a run for (`records/tool-providers.ts`) — `proposal_folder` (the one folder this run writes in, made by the app) and
// `job_report` (the judgement: checked here, kept on this PC, then sent as fixed kinds only). Neither calls the server itself.
import { z } from 'zod'
import { JOB_REPORT_TOOL } from '../../../shared/ai-turn-steps/job'
import { PROPOSAL_FOLDER_TOOL, SET_WATCH_EVIDENCE_MAX, SET_WATCH_UPDATES_FILE } from '../../../shared/ai-turn-steps/set-watch'
import { JOB_SET_UNCONFIRMED } from '../../../../shared/core/jobs'
import { MINUTES_QUOTE_MAX, MINUTES_QUOTE_MIN } from '../../../../shared/core/minutes'
import type { ExtraRecordTools, RecordToolDescriptor } from '../../records/tools'
import { recordToolDisplay } from '../../../shared/acb-tool-displays'
import type { SetHandlers } from './job-runs'

export function createSetWatchTools(handlers: SetHandlers): ExtraRecordTools {
  const folder: RecordToolDescriptor = {
    name: PROPOSAL_FOLDER_TOOL, readOnly: false,
    display: recordToolDisplay(PROPOSAL_FOLDER_TOOL),
    schema: z.object({
      company: z.string().min(1).max(100).describe('お客さんの会社名（フォルダの名前に使う。この PC にだけ残る）'),
      meetingDate: z.string().max(10).optional().describe('会議の日付 YYYY-MM-DD'),
    }).strict(),
    description: '定期の仕事（提案書のたたき台）で、この実行だけのフォルダを作る。書けるのはこのフォルダの中だけ。\n' +
      'Makes this run\'s own folder (the only place it may write).',
  }
  const report: RecordToolDescriptor = {
    name: JOB_REPORT_TOOL, readOnly: false,
    display: recordToolDisplay(JOB_REPORT_TOOL),
    schema: z.object({
      decision: z.enum(['proceed', 'decline', 'ask']).describe('proceed＝作る・decline＝作らない・ask＝作ってから人に聞く'),
      reason: z.string().min(1).max(40).describe('理由の種類（手順書の一覧のコード）'),
      confidence: z.number().min(0).max(1).describe('確からしさ 0〜1'),
      unconfirmed: z.array(z.enum(JOB_SET_UNCONFIRMED)).max(JOB_SET_UNCONFIRMED.length).optional().describe('まだ分からない項目（decline のときは付けない）'),
      evidence: z.array(z.object({
        quote: z.string().min(MINUTES_QUOTE_MIN).max(MINUTES_QUOTE_MAX).describe('議事録の文をそのまま写す'),
        speaker: z.string().max(60).optional(),
        at: z.string().max(20).optional(),
      }).strict()).max(SET_WATCH_EVIDENCE_MAX).optional().describe(`根拠にした発言（この PC にだけ残る）。更新案の数はアプリが ${SET_WATCH_UPDATES_FILE} から数える`),
    }).strict(),
    description: '定期の仕事（提案書のたたき台）の最後に1回だけ呼ぶ：判断を渡す。アプリが根拠を議事録と照らし、ファイルを確かめ、この PC に残してから完了を送る。\n' +
      'Call once at the end: the judgement. The app checks the quotes and files, keeps them on this PC, then reports fixed kinds only.',
  }
  const specs = [folder, report]
  return {
    specs,
    instructions: `提案書のたたき台の定期の仕事は、ファイルを ${PROPOSAL_FOLDER_TOOL} のフォルダにだけ置き、最後に ${JOB_REPORT_TOOL} で判断を渡して終える。`,
    async execute(name, input) {
      const spec = specs.find(s => s.name === name)
      if (!spec) return JSON.stringify({ error: 'この道具はありません。' })
      const parsed = spec.schema.safeParse(input ?? {})
      if (!parsed.success) return JSON.stringify({ error: '入力が正しくありません。', issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`) })
      if (name === PROPOSAL_FOLDER_TOOL) {
        const data = parsed.data as { company: string; meetingDate?: string }
        const made = await handlers.folder(data.company, data.meetingDate)
        return JSON.stringify('error' in made ? made : { folder: made.folder, note: 'このフォルダの中にだけファイルを作ってください。' })
      }
      const refused = await handlers.report(parsed.data)
      return JSON.stringify(refused ? { error: refused } : { ok: true, note: '受け取りました。これで終えてください。' })
    },
  }
}

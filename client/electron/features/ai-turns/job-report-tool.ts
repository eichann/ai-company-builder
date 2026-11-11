// A scheduled job's run hands back the one やること it made (jobs.md "The app's runner"): `job_report` keeps
// its title and summary in main for the run's finish — the server makes the やること (owner-only, one per
// occurrence); the AI never creates one. Only a consultation main holds a job run for gets it (made per turn
// by `records/tool-providers.ts`); it calls nothing on the server.
import { z } from 'zod'
import { JOB_TASK_TITLE_MAX } from '../../../../shared/core/jobs'
import { JOB_REPORT_TOOL } from '../../../shared/ai-turn-steps/job'
import type { ExtraRecordTools, RecordToolDescriptor } from '../../records/tools'
import { recordToolDisplay } from '../../../shared/acb-tool-displays'

export function createJobReportTools(report: (result: unknown) => Promise<string | null>): ExtraRecordTools {
  const spec: RecordToolDescriptor = {
    name: JOB_REPORT_TOOL, readOnly: false,
    display: recordToolDisplay(JOB_REPORT_TOOL),
    schema: z.object({
      title: z.string().min(1).max(JOB_TASK_TITLE_MAX).describe('私へのやることの名前（1行、80文字まで）'),
      summary: z.string().max(300).optional().describe('作ったもの・確かめてほしいことの短い説明（300文字まで）'),
    }).strict(),
    description: '定期の仕事の最後に1回だけ呼ぶ：私へのやることの名前と説明を渡す（やることはアプリが作る。自分で records_create はしない）。\n' +
      'Call once at the end of a scheduled job: the title (and a short summary) of the one task the app makes for the member.',
  }
  return {
    specs: [spec],
    instructions: `定期の仕事は、最後に ${JOB_REPORT_TOOL} でやることの名前を渡して終える。`,
    async execute(name, input) {
      if (name !== spec.name) return JSON.stringify({ error: 'この道具はありません。' })
      const parsed = spec.schema.safeParse(input ?? {})
      if (!parsed.success) return JSON.stringify({ error: '入力が正しくありません。' })
      // The run is finished here: the answer is the server's (made, or refused — the AI must not claim it then).
      const refused = await report({ title: parsed.data.title, summary: parsed.data.summary ?? null })
      return JSON.stringify(refused ? { error: refused } : { ok: true, note: 'やることを作りました。これで終えてください。' })
    },
  }
}

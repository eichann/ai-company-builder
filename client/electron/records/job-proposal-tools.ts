/**
 * The AI's two tools for a member's proposal of a time job (「AIへの相談」から定期の仕事, `.claude/rules/jobs.md` "Member
 * proposals" "The app (PR C)"): `job_proposal_places` (the folders the member may name) and `job_proposal_create` (a
 * candidate the server builds and pins). **Never a submit**: the candidate becomes the app's card in the reply, and only
 * the member's press there sends it to an owner / admin (session-only IPC `jobProposals:submit`). Offered only in a
 * consultation the member is in — never to an unattended run (a job's run, 「AI の番」, a plugin step: the server refuses a
 * run-bound token too, `JOB_PROPOSAL_NOT_IN_RUN`) — and only with an `act` token (Claude).
 */
import { z } from 'zod'
import { JOB_WEEKDAYS } from '../../../shared/core/jobs'
import { recordToolDisplay } from '../../shared/acb-tool-displays'
import type { ToolDisplay } from '../../shared/tool-display'

export const JOB_PROPOSAL_PLACES_TOOL = 'job_proposal_places'
export const JOB_PROPOSAL_CREATE_TOOL = 'job_proposal_create'
export const JOB_PROPOSAL_TOOL_NAMES: readonly string[] = [JOB_PROPOSAL_PLACES_TOOL, JOB_PROPOSAL_CREATE_TOOL]

/** The record-token routes (relative to `/api/records-ai`): the server's places and candidate, nothing else. */
const BASE = '/job-proposals-ai'

const AT = z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/).describe('時刻 HH:MM（5分きざみ、会社の時刻） / HH:MM on 5 minutes, company time')
const PLACE = z.string().min(1).max(500).describe('job_proposal_places が出したフォルダのパス / a folder path listed by job_proposal_places')

const TRIGGER = z.union([
  z.object({ every: z.literal('day'), at: AT, businessDaysOnly: z.boolean().describe('営業日だけ / business days only') }).strict(),
  z.object({ every: z.literal('week'), weekday: z.enum(JOB_WEEKDAYS), at: AT, businessDaysBefore: z.number().int().min(0).max(5).describe('その曜日の何営業日前（ふつうは 0） / business days before (usually 0)') }).strict(),
  z.object({ every: z.literal('month'), day: z.union([z.number().int().min(1).max(28), z.literal('last')]), at: AT, ifHoliday: z.enum(['as_is', 'before', 'after']) }).strict(),
])

const CREATE_SCHEMA = z.object({
  skill: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe('今ある Skill のフォルダ名（会社の .claude/skills/<名前>）。会社のフォルダがない会社では Skill の棚の項目の id / an existing Skill: its folder name, or the shelf item id in a company without the shared folder'),
  trigger: TRIGGER,
  check: z.union([
    z.object({ kind: z.literal('new_files'), path: PLACE }).strict(),
    z.object({ kind: z.literal('new_meetings') }).strict(),
  ]).describe('何があったら動くか（必須）：そのフォルダに新しいファイルがあるとき、またはメンバーが出た新しい会議があるとき / what makes it run (required)'),
  reads: z.array(PLACE).max(10).describe('ほかに読むフォルダ（無ければ []） / other folders to read'),
  deliverable: PLACE.nullable().describe('できたものを置くフォルダ（書ける場所だけ。置かないなら null）。中のフォルダ名はサーバーが決める / where results go (a writable folder) or null'),
  readRecords: z.boolean().describe('やることや記録を読む / read tasks and records'),
  mailDrafts: z.boolean().describe('メールの下書きを作る（送るのは人） / make mail drafts (a person sends them)'),
  minutes: z.number().int().min(1).max(120).describe('1回に使ってよい時間（分） / minutes per run'),
  missed: z.object({
    policy: z.enum(['latest_only', 'skip']).describe('動けなかった回：latest_only＝期限内なら一番新しい回だけ、skip＝見送る'),
    expiresAfterMinutes: z.number().int().min(5).max(7 * 24 * 60).describe('その回の時刻から何分まで動いてよいか / how long after its time a run may still start'),
  }).strict(),
}).strict()

const DESCRIPTION_PLACES =
  '定期の仕事の案に入れられるフォルダ（メンバーが読める、今あるフォルダ）を、under の下について一覧する（under を省くと一番上）。write: true は置く場所にもできる。' +
  'ここに出ないフォルダは案に入れられない：メンバーが読めない・ないフォルダを頼まれたら、案を作る前に「そのフォルダは読めないので入れられません」と伝える。\n' +
  'List the folders a proposal may name (existing folders the member reads) under `under` (omit: the top). write: true = may be the deliverable place. ' +
  'A folder not listed cannot be used: if the member asks for one, say before making a candidate that it cannot be included.'

const DESCRIPTION_CREATE =
  '「毎週月曜の朝に…」のように、決まった時間に動く仕事（定期の仕事）をメンバーが頼んだときに、その案の候補を作る。サーバーが中身を決めて固定し、相談の中にアプリの確認カードが出る。' +
  'これは管理者に出すことではない：出すのはメンバーがカードで「これで管理者に出す」を押したときだけで、あなた（AI）は出せない・承認もできない。「出しました」「承認されました」とは言わない。内容を変えたいときは、新しい候補を作り直す。\n' +
  '守ること：(1) 今ある Skill だけを使う。合う Skill が無ければ「先に Skill を作る必要があります」と伝えて止まる（この流れで Skill を作らない）。' +
  '(2) フォルダは job_proposal_places で出たものだけ（置く場所は write: true のもの）。読めないフォルダは入れられない。' +
  '(3) 会議・記録・メールの題や引用、人の名前などの文を案に入れない（自由な文の欄は無い。仕事の名前はサーバーが「Skill名（いつ）」で作る）。' +
  '(4) できないことは、できないと先に言う：メールは下書きまで（送るのは人）、出来事で動く仕事は作れない（時刻だけ）。' +
  '(5) 必ず「何があったら動くか」を選ぶ。新しいものが無い回は AI は動かない：「毎回必ず動きます」とは言わない。会社の設定や本人の「AI が自動で進める」（自分の設定）で動かないこともある。\n' +
  'Make a candidate for a job that runs at a set time, when the member asks for one. The server builds and pins it and the app shows a card in the chat. ' +
  'This does NOT send it to an admin: only the member\'s press on the card does; you cannot submit or approve it — never say it was sent or approved. To change it, make a new candidate. ' +
  'Rules: existing Skills only (none fits → say a Skill must be made first and stop); folders only from job_proposal_places; never put titles, quotes or names into it; ' +
  'say first what cannot be done (mail: drafts only; no event-triggered jobs); always choose a check — it runs only when something is new, never promise it runs every time.'

export interface JobProposalToolSpec {
  name: string
  description: string
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>
  readOnly: boolean
  display: ToolDisplay
  /** `job_proposal_create`: the answer becomes the app's card (never the AI's text). */
  jobProposalCard?: true
  request(input: Record<string, unknown>): { method: 'GET' | 'POST'; path: string; body?: unknown }
}

export function jobProposalToolSpecs(): JobProposalToolSpec[] {
  return [
    {
      name: JOB_PROPOSAL_PLACES_TOOL, readOnly: true, display: recordToolDisplay(JOB_PROPOSAL_PLACES_TOOL),
      schema: z.object({ under: z.string().max(500).optional().describe('この下を一覧する（省くと一番上） / list under this folder') }).strict(),
      description: DESCRIPTION_PLACES,
      request: input => ({ method: 'GET', path: `${BASE}/places${typeof input.under === 'string' && input.under ? `?under=${encodeURIComponent(input.under)}` : ''}` }),
    },
    {
      name: JOB_PROPOSAL_CREATE_TOOL, readOnly: false, display: recordToolDisplay(JOB_PROPOSAL_CREATE_TOOL), jobProposalCard: true,
      schema: CREATE_SCHEMA as unknown as z.ZodObject<Record<string, z.ZodTypeAny>>,
      description: DESCRIPTION_CREATE,
      request: input => ({ method: 'POST', path: `${BASE}/candidates`, body: input }),
    },
  ]
}

/** What the consultation's AI is told once (with the record tools' instructions) when the tools are offered. */
export const JOB_PROPOSAL_INSTRUCTIONS =
  '\n\n## 定期の仕事の案\nメンバーが「毎週」「毎朝」のように決まった時間に動く仕事を頼んだら、job_proposal_places で使えるフォルダを確かめてから job_proposal_create で案の候補を作れます。' +
  '管理者に出すのはメンバーがカードで押したときだけです（あなたは出せません）。今ある Skill だけを使い、合う Skill が無ければ「先に Skill を作る必要があります」と伝えて止まってください。' +
  'メールは下書きまで、読めないフォルダは入れられません。\n'

/** A refusal as the AI is told it: a server without member proposals (404 with no job code) said as such. */
export function jobProposalRefusalForAi(code: string, message: string): { error: string; code: string } {
  if (code === 'HTTP_404' || code === 'NOT_FOUND') {
    return { code: 'JOB_PROPOSALS_NOT_SUPPORTED', error: 'この会社のサーバーでは、まだ定期の仕事の案を作れません（サーバーの更新が必要です）。メンバーにそう伝えてください。' }
  }
  return { code, error: message }
}

/** What the AI is told after a candidate was made: its server-made name only, and that nothing was sent. */
export function jobCandidateSummaryForAi(candidate: { name?: unknown }): string {
  return JSON.stringify({
    shown: true,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    instruction: 'A card is in the chat. Nothing was sent to an admin and nothing runs: only the member can press 「これで管理者に出す」 on the card; then an admin approves and the member presses 「受け取る」. Never say it was sent, approved or will run every time. To change it, make a new candidate.',
  })
}

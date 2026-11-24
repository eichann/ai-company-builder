/**
 * A set watch's run on this PC (schema 5, 4b-4 PR5; owner memo 「4b-4 商談から提案書」 第6版 §4 / §5 / 付録 B2, `jobs.md` "The set
 * watch" "The app runs it"): the pure part — what the AI may report and how it is checked, the run folder's name, the image
 * names a draft asks for, and the first message. main's part is `electron/features/ai-turns/set-watch-run.ts`.
 *
 * What reaches the server is fixed kinds only (`parseJobSetReport`'s shape: the decision, a reason of the pinned list, a
 * confidence, fixed unconfirmed words, and a count of update proposals). The quotes (`evidence`), the company's name and the
 * folder stay on this PC (I6).
 */
import {
  JOB_SET_UNCONFIRMED, parseJobSetReport,
  type JobDecision, type JobSetReport,
} from '../../../shared/core/jobs'
import { MINUTES_QUOTE_MAX, MINUTES_QUOTE_MIN, quoteAppearsIn } from '../../../shared/core/minutes'
import { isValidFolderName } from '../../../shared/core/names'
import { outsideTitle } from '../../../shared/core/outside-text'
import { AUTOMATIC_NO_SHELL_RULE } from './plugin'

/** The files a draft is made of (§5-1), in the order the Skill writes them: the last one says the folder is whole. */
export const SET_WATCH_DRAFT_FILES = ['voices.md', '骨子（仮）.md', 'proposal.html', '確認してほしいこと.md'] as const
/** The file whose images the app copies (`assets/<name>`). */
export const SET_WATCH_DRAFT_HTML = 'proposal.html'
/** At most this many update proposals a run may count (PR3b's `updates`, an integer 0–20). */
export const SET_WATCH_UPDATES_MAX = 20
/** At most this many quotes a report keeps on the PC. */
export const SET_WATCH_EVIDENCE_MAX = 10

/** The tools of a set watch's run besides the record tools its grant gives. */
export const PROPOSAL_FOLDER_TOOL = 'proposal_folder'

/** One quote the AI rests its judgement on: kept on this PC only, checked against the minutes it read. */
export interface SetEvidence { quote: string; speaker?: string; at?: string }

/** The run's report as the app checks it: `report` goes to the server (fixed kinds), `evidence` stays here. */
export interface SetReportInput { report: Exclude<JobSetReport, { decision: 'gate_failed' }>; evidence: SetEvidence[] }

const UNCONFIRMED_WORDS: Record<typeof JOB_SET_UNCONFIRMED[number], string> = {
  headcount: '人数', budget: '予算', company_size: '企業規模', subsidy: '助成金', monthly_fee: '月額',
}

/**
 * The AI's `job_report` of a set watch, checked against the pinned reasons (the Skill's `decision.json` in the pinned copy —
 * the same file the server pinned): an error sentence the AI can act on, or the report. The server's part goes through the
 * server's own parser (`parseJobSetReport`), so the app never sends what the server would refuse for its shape.
 */
export function parseSetReportInput(v: unknown, decision: JobDecision): SetReportInput | { error: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: '入力が正しくありません。' }
  const input = v as Record<string, unknown>
  const allowed = new Set(['decision', 'reason', 'confidence', 'unconfirmed', 'evidence'])
  if (!Object.keys(input).every(k => allowed.has(k))) return { error: 'decision・reason・confidence・unconfirmed・evidence のほかは渡せません（更新案の数はアプリが更新案のファイルから数えます）。' }
  const server = { decision: input.decision, reason: input.reason, confidence: input.confidence, ...(input.unconfirmed !== undefined ? { unconfirmed: input.unconfirmed } : {}) }
  const report = parseJobSetReport(server, decision)
  if (!report || report.decision === 'gate_failed') {
    return { error: `decision は proceed・decline・ask のどれか、reason は ${decision.reasons.map(r => r.code).join('・')} のどれか、confidence は 0〜1 の数、unconfirmed は ${JOB_SET_UNCONFIRMED.join('・')} から（decline のときは付けない）にしてください。` }
  }
  const raw = input.evidence === undefined ? [] : input.evidence
  if (!Array.isArray(raw) || raw.length > SET_WATCH_EVIDENCE_MAX) return { error: `evidence は ${SET_WATCH_EVIDENCE_MAX} 件までの配列にしてください。` }
  const evidence: SetEvidence[] = []
  for (const e of raw as unknown[]) {
    const x = (typeof e === 'object' && e !== null && !Array.isArray(e) ? e : null) as Record<string, unknown> | null
    if (!x || !Object.keys(x).every(k => k === 'quote' || k === 'speaker' || k === 'at')) return { error: 'evidence の各項目は quote（と speaker・at）だけにしてください。' }
    if (typeof x.quote !== 'string' || x.quote.trim().length < MINUTES_QUOTE_MIN || x.quote.length > MINUTES_QUOTE_MAX) return { error: `evidence の quote は議事録の文をそのまま ${MINUTES_QUOTE_MIN}〜${MINUTES_QUOTE_MAX} 字で写してください。` }
    if (x.speaker !== undefined && (typeof x.speaker !== 'string' || x.speaker.length > 60)) return { error: 'evidence の speaker は60字までにしてください。' }
    if (x.at !== undefined && (typeof x.at !== 'string' || x.at.length > 20)) return { error: 'evidence の at は20字までにしてください。' }
    evidence.push({ quote: x.quote, ...(typeof x.speaker === 'string' ? { speaker: x.speaker } : {}), ...(typeof x.at === 'string' ? { at: x.at } : {}) })
  }
  return { report, evidence }
}

/**
 * The quotes that are not in the minutes this run read (I7, `quoteAppearsIn`, spacing aside). Without minutes read, every quote
 * is "not there": a quote of minutes nobody read here is never trusted.
 */
export function quotesNotInMinutes(evidence: readonly SetEvidence[], minutes: string | null): SetEvidence[] {
  return evidence.filter(e => minutes === null || !quoteAppearsIn(minutes, e.quote))
}

/**
 * What the server is sent: the fixed kinds, and `updates` — the update proposals the app counted in the run's file (G-1, PR3b) —
 * only when there are some, so a server before PR3b never sees the key on a run that made none.
 */
export function setJobResult(input: SetReportInput, updates: number): Record<string, unknown> {
  const r = input.report
  return {
    decision: r.decision, reason: r.reason, confidence: r.confidence,
    ...(r.unconfirmed.length > 0 ? { unconfirmed: [...r.unconfirmed] } : {}),
    ...(updates > 0 ? { updates } : {}),
  }
}

/**
 * The update proposals' file (owner memo 「本体を動かさない見直し」 §F / §G, シナリオ集 S9 / S11 #11): one file in the run folder,
 * versioned, read by the app before the completion is sent — a file that is not this shape is never counted (the card, PR6, reads
 * the same file). Nothing in it reaches the server: only how many.
 *
 * ```json
 * { "版": 1, "会議": "meeting-…", "更新案": [
 *   { "書き先": "hubspot", "取引": "<HubSpot の取引の番号、または 新規:<会社名>>", "項目": "確度", "値": "B", "根拠": "議事録の文", "理由": "…" },
 *   { "書き先": "係数表", "取引": "…", "項目": "計上月", "値": [{ "月": "2026-12", "金額": 300000 }] } ] }
 * ```
 * Each item is told apart by meeting + deal + item (S11 #11: never "the same day"): one item per 取引 and 項目 in a file.
 */
export const SET_WATCH_UPDATES_FILE = '更新案.json'
export const SET_WATCH_UPDATES_VERSION = 1
/** What a HubSpot item may change (the plugin's operations, applied later in the person's consultation). */
export const SET_WATCH_HUBSPOT_ITEMS = ['確度', '金額', '計上月', '次のアクション', '商談の記録', '取引を作る'] as const
export const SET_WATCH_UPDATE_TARGETS = ['hubspot', '係数表'] as const
/** The largest update proposals' file read (a few dozen short items). */
export const SET_WATCH_UPDATES_FILE_MAX = 64 * 1024

export type SetUpdateValue = string | number | Array<{ 月: string; 金額: number }>
export interface SetUpdateItem { 書き先: typeof SET_WATCH_UPDATE_TARGETS[number]; 取引: string; 項目: string; 値: SetUpdateValue; 根拠?: string; 理由?: string }

// eslint-disable-next-line no-control-regex
const ONE_LINE = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v)
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function updateValue(v: unknown): v is SetUpdateValue {
  if (typeof v === 'string') return v.length <= 2000
  if (typeof v === 'number') return Number.isFinite(v)
  return Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every(x => typeof x === 'object' && x !== null && !Array.isArray(x)
    && Object.keys(x).length === 2 && typeof (x as Record<string, unknown>).月 === 'string' && MONTH_RE.test((x as Record<string, string>).月)
    && typeof (x as Record<string, unknown>).金額 === 'number' && Number.isFinite((x as Record<string, number>).金額))
}

/**
 * The update proposals' file checked (§G, S9): the version, this run's meeting, at most `SET_WATCH_UPDATES_MAX` items of the fixed
 * shape, each 取引 + 項目 once, every 根拠 found in the minutes this run read (I7). A problem in words the AI can act on.
 */
export function parseUpdateProposals(text: string, meetingId: string, minutes: string | null): { items: SetUpdateItem[] } | { problem: string } {
  if (text.length > SET_WATCH_UPDATES_FILE_MAX) return { problem: 'ファイルが大きすぎます。' }
  let v: unknown
  try { v = JSON.parse(text) } catch { return { problem: 'JSON として読めません。' } }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { problem: 'いちばん外側は { } にしてください。' }
  const o = v as Record<string, unknown>
  if (!Object.keys(o).every(k => k === '版' || k === '会議' || k === '更新案')) return { problem: '「版」「会議」「更新案」のほかの鍵は書けません。' }
  if (o.版 !== SET_WATCH_UPDATES_VERSION) return { problem: `「版」は ${SET_WATCH_UPDATES_VERSION} にしてください。` }
  if (o.会議 !== meetingId) return { problem: `「会議」はこの会議の番号（${meetingId}）にしてください。` }
  if (!Array.isArray(o.更新案) || o.更新案.length > SET_WATCH_UPDATES_MAX) return { problem: `「更新案」は ${SET_WATCH_UPDATES_MAX} 件までの配列にしてください。` }
  const items: SetUpdateItem[] = []
  const seen = new Set<string>()
  for (const [i, raw] of (o.更新案 as unknown[]).entries()) {
    const at = `${i + 1}件目`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: `${at}が { } ではありません。` }
    const x = raw as Record<string, unknown>
    if (!Object.keys(x).every(k => ['書き先', '取引', '項目', '値', '根拠', '理由'].includes(k))) return { problem: `${at}：「書き先」「取引」「項目」「値」「根拠」「理由」のほかは書けません。` }
    if (!(SET_WATCH_UPDATE_TARGETS as readonly unknown[]).includes(x.書き先)) return { problem: `${at}：「書き先」は hubspot か 係数表 にしてください。` }
    if (!ONE_LINE(x.取引, 100)) return { problem: `${at}：「取引」は1行・100字までにしてください。` }
    const item = x.書き先 === 'hubspot' ? (SET_WATCH_HUBSPOT_ITEMS as readonly unknown[]).includes(x.項目) : ONE_LINE(x.項目, 40)
    if (!item) return { problem: `${at}：「項目」は ${x.書き先 === 'hubspot' ? SET_WATCH_HUBSPOT_ITEMS.join('・') + ' のどれか' : '1行・40字まで'}にしてください。` }
    if (!updateValue(x.値)) return { problem: `${at}：「値」は文（2000字まで）・数・または [{ "月": "YYYY-MM", "金額": 数 }] にしてください。` }
    if (x.根拠 !== undefined && (typeof x.根拠 !== 'string' || minutes === null || !quoteAppearsIn(minutes, x.根拠))) return { problem: `${at}：「根拠」が議事録に見つかりません。議事録の文をそのまま写してください。` }
    if (x.理由 !== undefined && (typeof x.理由 !== 'string' || x.理由.length > 300)) return { problem: `${at}：「理由」は300字までにしてください。` }
    const key = `${x.書き先}\n${(x.取引 as string).normalize('NFC')}\n${(x.項目 as string).normalize('NFC')}`
    if (seen.has(key)) return { problem: `${at}：同じ取引の同じ項目が2回あります（取引と項目ごとに1つにしてください）。` }
    seen.add(key)
    items.push({ 書き先: x.書き先 as SetUpdateItem['書き先'], 取引: x.取引 as string, 項目: x.項目 as string, 値: x.値 as SetUpdateValue, ...(typeof x.根拠 === 'string' ? { 根拠: x.根拠 } : {}), ...(typeof x.理由 === 'string' ? { 理由: x.理由 } : {}) })
  }
  return { items }
}

/** The longest company part of a run folder's name. */
export const RUN_FOLDER_COMPANY_MAX = 30
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A run folder's name `<YYYY-MM-DD>_<company>` (§4-1, B2): the company's name made to fit the department folder rule
 * (`isValidFolderName`: every other character becomes `_`, runs of them one, at most `RUN_FOLDER_COMPANY_MAX`), NFC. null when the
 * day is not a day. A name left empty is 「会社名なし」.
 */
export function runFolderName(day: string, company: string): string | null {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null
  const chars = [...company.normalize('NFC')].map(c => (isValidFolderName(`a${c}`) ? c : '_'))
  const cleaned = chars.join('').replace(/[._-]{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '')
  const part = [...cleaned].slice(0, RUN_FOLDER_COMPANY_MAX).join('').replace(/[._-]+$/, '') || '会社名なし'
  const name = `${day}_${part}`
  return isValidFolderName(name) ? name : null
}

/** An image name a draft may ask for: one plain file name (no `/`, never `.` / `..`). */
const ASSET_NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * The images a draft names as `assets/<name>` (B2): only plain names; the app copies only those the pinned Skills' `tools/assets/`
 * list. Anything else (`assets/../../x`, a sub folder, a URL's query) is left out here.
 */
export function draftAssetNames(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/assets\/([^"'()\s<>?#\\]+)/g)) {
    const name = m[1]
    if (ASSET_NAME_RE.test(name) && name !== '.' && name !== '..' && !name.startsWith('.')) out.add(name)
  }
  return [...out].slice(0, 200)
}

/**
 * What judges (§5-0, owner decision 2026-11-23): one seam in the app, never part of a definition or the consent. Claude now —
 * the run's own AI judges inside the run and hands its judgement back with `job_report` (`in_run`). A local model later (PR8)
 * judges before the AI; when it cannot (`failed`: missing, a wrong fingerprint, an error) the run ends as `gate_failed` with no
 * draft and no file check — never handed to Claude instead.
 */
export interface DecisionGate { judge(): Promise<'in_run' | 'failed'> }
/** The gate today: Claude, inside the run. */
export const CLAUDE_IN_RUN_GATE: DecisionGate = { judge: async () => 'in_run' }

export interface SetWatchMessageInput {
  name: string
  recordId: string
  meetingId: string
  /** The pinned procedure (the run's Skill's SKILL.md from the pinned copy). */
  procedure: string
  /** The pinned copy's folder (absolute) and where each pinned Skill is inside it. */
  copyDir: string
  skills: Array<{ place: string; skill: string; dir: string }>
  reasons: JobDecision['reasons']
  /** `<place>/.personal/<folder>` — where run folders are made (readable as a whole, writable only in this run's). */
  base: string
  deadline: string
}

/** The run's first message (B2): the record and its meeting, the procedure, the pinned copy, the run folder, the report. */
export function setWatchFirstMessage(input: SetWatchMessageInput): string {
  return [
    '（アプリが定期の仕事として自動で始めた相談です。私はいま画面を見ていません。）',
    '',
    `定期の仕事「${input.name}」を、次の手順書どおりに進めてください。`,
    '',
    `きっかけ：あなたが担当の「議事録を確認する」（${input.recordId}）が完了しました。`,
    `読める議事録は、その会議（${input.meetingId}）のものだけです。minutes_read で読んでください。ほかの会議の議事録は読めません。`,
    '',
    '手順書（部署の Skill。承認された版の写しです）:',
    '-----',
    input.procedure.trim(),
    '-----',
    '',
    '自動で進めるときの決まり：',
    `- Skill のファイルは、承認された版の写し「${input.copyDir}」の中だけを読んでください（作業中のフォルダの Skill は読みません）：`,
    ...input.skills.map(s => `  - ${s.place} の ${s.skill}：${s.dir}`),
    `- これまでの提案書のフォルダ「${input.base}/」は読めますが、書き換えられません。`,
    `- ファイルを作るときは、先に ${PROPOSAL_FOLDER_TOOL} を1回呼んで（company に会社名、meetingDate に会議の日付 YYYY-MM-DD）、この実行だけのフォルダをもらってください。書けるのはそのフォルダの中だけです。`,
    `- 提案書を作るときは、そのフォルダに ${SET_WATCH_DRAFT_FILES.join('・')} を作ってください（${SET_WATCH_DRAFT_FILES[SET_WATCH_DRAFT_FILES.length - 1]} は最後に）。画像は proposal.html に assets/<ファイル名> と書くだけにしてください（コピーはアプリがします）。`,
    `- HubSpot や係数表の更新案は、そのフォルダの ${SET_WATCH_UPDATES_FILE} に1つのファイルで置いてください（どこにも書き込まないでください）。形：{ "版": ${SET_WATCH_UPDATES_VERSION}, "会議": "${input.meetingId}", "更新案": [{ "書き先": "hubspot" または "係数表", "取引": 取引の番号（無ければ 新規:会社名）, "項目": HubSpot なら ${SET_WATCH_HUBSPOT_ITEMS.join('・')}, "値": 文・数・[{ "月": "YYYY-MM", "金額": 数 }], "根拠": 議事録の文そのまま, "理由": 短い説明 }] }（${SET_WATCH_UPDATES_MAX} 件まで、同じ取引の同じ項目は1つ）。`,
    '- 送る・承認するは人がします。やることや記録は自分で作らないでください。',
    AUTOMATIC_NO_SHELL_RULE,
    `- ${input.deadline} までに終えてください。それを過ぎると止まります。`,
    '',
    `終わったら、必ず job_report を1回呼んでください：decision（proceed＝作る・decline＝作らない・ask＝作ってから人に聞く）、reason（次のどれか：${input.reasons.map(r => `${r.code}＝${outsideTitle(r.label)}`).join('・')}）、confidence（0〜1）、` +
      `unconfirmed（まだ分からない項目。${JOB_SET_UNCONFIRMED.map(u => `${u}＝${UNCONFIRMED_WORDS[u]}`).join('・')}。decline のときは付けない）、evidence（根拠にした発言。議事録の文をそのまま写す。quote・speaker・at）。更新案の数はアプリが ${SET_WATCH_UPDATES_FILE} から数えます。` +
      ' 会社名や発言はサーバーには送られず、この PC にだけ残ります。job_report が断ったときは、言われたとおり直して、もう一度呼んでください。',
  ].join('\n')
}

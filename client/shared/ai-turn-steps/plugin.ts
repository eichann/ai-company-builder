/**
 * A business plugin's step as a kind of 「AI の番」 (plan C5, `.claude/rules/plugin-steps.md`).
 * Unlike the static kinds of this folder, it is made from the server's answers, not declared
 * here: the steps come from the plugin's contract-2 declaration (`steps`), and the server says
 * which records wait at one (`GET /me/plugin-step-turns`), which procedure the work is pinned to
 * (the claim's `run.procedure.pin`) and the step it runs (`GET /me/plugin-steps/records/:id`:
 * its tools, narrowed by the pinned version). Pure: parsers of those answers, the step's tool
 * ceiling in the app's tool names, and the first message.
 *
 * The run is named `<pluginId>__<step>` (the server's C4 gate allows its tokens only that
 * plugin's operations the step declares, and the connector roles it declares).
 */
import { PLUGIN_ID_RE } from '../../../shared/core/plugin-declaration'
import { STEP_FILE_RE } from '../../../shared/core/plugin-flow-declaration'
import { ONTOLOGY_NAME_RE as STEP_NAME_RE } from '../../../shared/core/record-types'
import { RECORD_ID_RE } from '../../../shared/core/records'
import { automaticStepCeiling, deliverableFolderOf, deliverableFolderProblem } from '../../../shared/core/plugin-step-runs'
import { parseProcedurePin } from '../../../shared/core/ai-runs'
import type { PluginStepProcedurePin } from '../../../shared/core/plugin-declaration'
import type { PluginStepOnRecord } from '../../../shared/types/plugins'
import type { AiTurnCandidate } from './types'

export { parseProcedurePin }
export type { PluginStepOnRecord, PluginStepProcedurePin }

/** `<pluginId>__<step>`: a plugin id has no `_`, a step name no `-`; at most 40 characters (the server's run step). */
export type PluginRunStep = `${string}__${string}`

export function pluginRunStep(pluginId: string, step: string): PluginRunStep | null {
  const name = `${pluginId}__${step}`
  return PLUGIN_ID_RE.test(pluginId) && STEP_NAME_RE.test(step) && name.length <= 40 ? name as PluginRunStep : null
}

export function isPluginRunStep(value: unknown): value is PluginRunStep {
  if (typeof value !== 'string') return false
  const at = value.indexOf('__')
  return at > 0 && pluginRunStep(value.slice(0, at), value.slice(at + 2)) === value
}

/** One record waiting at a `start: ai_turn` step (`GET /me/plugin-step-turns`, the contract's `PluginStepTurn`), as the runner's queue keeps it. */
export interface QueuedPluginStep {
  recordId: string
  version: number
  pluginId: string
  step: string
  runStep: PluginRunStep
  label: string
  /** A `start: person` step the company starts by itself (plugin-steps.md "Starting by itself"): the automatic ceiling, settled by what it made. */
  auto: boolean
  /** Where the run may write: `<department>/.personal/<this>/` (the server's, else from the label). */
  deliverableFolder: string
}

/** The step's deliverable folder from the server's answer, else the core's default from its label. */
export function stepDeliverableFolder(v: { step: string; label: string; deliverableFolder?: unknown }): string {
  const given = typeof v.deliverableFolder === 'string' && deliverableFolderProblem(v.deliverableFolder) === null ? v.deliverableFolder : null
  return deliverableFolderOf(v.step, v.label, given)
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** The answer's turns, each checked (a malformed one is left out); null when the answer is not one. */
export function parsePluginStepTurns(data: unknown): QueuedPluginStep[] | null {
  const turns = typeof data === 'object' && data !== null ? (data as { turns?: unknown }).turns : undefined
  if (!Array.isArray(turns)) return null
  const out: QueuedPluginStep[] = []
  for (const t of turns.slice(0, 500)) {
    if (typeof t !== 'object' || t === null) continue
    const v = t as Record<string, unknown>
    if (!str(v.recordId, 80) || !RECORD_ID_RE.test(v.recordId) || typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version < 1) continue
    // A person's step only when the server says the company starts it by itself.
    const auto = v.start === 'person' && v.auto === true
    if (!str(v.pluginId, 40) || !str(v.step, 40) || !str(v.label, 200) || (v.start !== 'ai_turn' && !auto)) continue
    const runStep = pluginRunStep(v.pluginId, v.step)
    if (!runStep) continue
    out.push({
      recordId: v.recordId, version: v.version, pluginId: v.pluginId, step: v.step, runStep, label: v.label, auto,
      deliverableFolder: stepDeliverableFolder({ step: v.step, label: v.label, deliverableFolder: v.deliverableFolder }),
    })
  }
  return out
}

export function parsePluginStepsOn(data: unknown): PluginStepOnRecord[] | null {
  const steps = typeof data === 'object' && data !== null ? (data as { steps?: unknown }).steps : undefined
  if (!Array.isArray(steps)) return null
  const out: PluginStepOnRecord[] = []
  for (const s of steps.slice(0, 100)) {
    if (typeof s !== 'object' || s === null) continue
    const v = s as Record<string, unknown>
    if (!str(v.pluginId, 40) || !str(v.step, 40) || !pluginRunStep(v.pluginId, v.step) || !str(v.label, 200)) continue
    if ((v.start !== 'ai_turn' && v.start !== 'person') || typeof v.procedure !== 'string' || !STEP_FILE_RE.test(v.procedure)) continue
    const names = (x: unknown) => Array.isArray(x) && x.every(n => typeof n === 'string' && n.length <= 60) ? x as string[] : null
    const tools = names(v.tools)
    const roles = names(v.connectorRoles)
    if (!tools || !roles) continue
    out.push({
      pluginId: v.pluginId, step: v.step, label: v.label, start: v.start, procedure: v.procedure, tools, connectorRoles: roles, pin: parseProcedurePin(v.pin),
      deliverableFolder: stepDeliverableFolder({ step: v.step, label: v.label, deliverableFolder: v.deliverableFolder }),
    })
  }
  return out
}

/**
 * The step's ceiling in the app's tool names (plugins.md `PLUGIN_STEP_TOOLS`): the record tools it
 * may see and the Claude Code built-in tools it gets. Never more than the step declares, whichever
 * procedure runs (a company Skill asks for nothing here). The server's gate decides each call too.
 */
export interface PluginStepToolAccess {
  allowsRecordTool(name: string): boolean
  builtinTools: string[]
}

const RECORD_TOOLS: Record<string, readonly string[]> = {
  records: ['records_get', 'records_query', 'records_history', 'records_types', 'records_create', 'records_link_file', 'records_unlink_file', 'decisions_record'],
  approvals: ['approvals_list', 'approvals_show'],
  outbound_draft: ['mail_recipients', 'mail_draft_create', 'mail_draft_update', 'mail_draft_show'],
}
const BUILTIN_TOOLS: Record<string, readonly string[]> = {
  web_research: ['WebSearch', 'WebFetch'],
  files_read: ['Read', 'Glob', 'Grep'],
  files_write: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit'],
}

export function pluginStepToolAccess(declared: { pluginId: string; tools: readonly string[] }, recordType: string, options: { automatic?: boolean } = {}): PluginStepToolAccess {
  // A person's step run by itself never gets a tool that reaches outside (shared/core/plugin-step-runs.ts).
  const step = options.automatic ? automaticStepCeiling({ ...declared, connectorRoles: [] }) : declared
  const exact = new Set(step.tools.flatMap(t => RECORD_TOOLS[t] ?? []))
  const typeActions = step.tools.includes('records') && STEP_NAME_RE.test(recordType) ? `${recordType}__` : null
  const operations = step.tools.includes('plugin_operations') ? `${step.pluginId}__` : null
  const own = (name: string, prefix: string | null) => prefix !== null && name.startsWith(prefix) && STEP_NAME_RE.test(name.slice(prefix.length))
  return {
    allowsRecordTool: name => exact.has(name) || own(name, typeActions) || own(name, operations),
    builtinTools: [...new Set(step.tools.flatMap(t => BUILTIN_TOOLS[t] ?? []))],
  }
}

/** The record's type from its id (`deal-…` → `deal`). */
export function recordTypeOf(recordId: string): string | null {
  const at = recordId.lastIndexOf('-')
  const type = at > 0 ? recordId.slice(0, at) : ''
  return STEP_NAME_RE.test(type) ? type : null
}

/** The queue's entry for a turn. */
export function pluginTurnCandidate(turn: QueuedPluginStep): AiTurnCandidate {
  return { id: turn.recordId, title: turn.label, version: turn.version, pluginStep: turn.runStep }
}

/** The hidden consultation's title: 「<手順の名前>（M/D）」. */
export function pluginStepConsultationTitle(label: string, now = new Date()): string {
  return `${label}（${now.getMonth() + 1}/${now.getDate()}）`
}

/**
 * The automatic run's first message: the step, the record and its version, and the procedure
 * (the plugin's file, or the company Skill's SKILL.md at the pinned version) as the instructions.
 */
export function pluginStepFirstMessage(input: {
  label: string; recordId: string; version: number | null; procedure: string; source: PluginStepProcedurePin['source']
  /** Where the run may write; with `auto`, also how it reports what it made. */
  deliverableFolder?: string; auto?: boolean
}): string {
  return [
    '（アプリが AI の番として自動で始めた相談です。私はいま画面を見ていません。）',
    '',
    `手順「${input.label}」を、記録 ${input.recordId} について進めてください。`,
    ...(input.version !== null ? [`この記録のいまの version は ${input.version} です。記録の操作の expectedVersion にはこれを使ってください。`] : []),
    '',
    input.source === 'company_skill' ? '会社の手順書（スキル）:' : '手順書:',
    '-----',
    input.procedure.trim(),
    '-----',
    '',
    '自動で進めるときの決まり：',
    '- 使えるのはこの手順の道具だけです。使えない道具や足りない情報があっても止まらず、最後に私へのお願いとしてまとめてください。',
    '- 送る・承認するは人がします。下書きや承認のお願いまでにしてください。',
    '- 「ほかの人が先に変えました」と断られたら、その答えの version でもう一度だけ試してください。',
    AUTOMATIC_NO_SHELL_RULE,
    ...(input.deliverableFolder ? [deliverableFolderRule(input.deliverableFolder)] : []),
    ...(input.auto ? ['', PREPARE_ONLY_RULE] : []),
    ...(input.auto && input.deliverableFolder ? ['', deliverablesReport(input.recordId, input.label)] : []),
  ].join('\n')
}

/** Every automatic run of a plugin step (the app gives it no shell): said by the core, whatever the procedure says. */
export const AUTOMATIC_NO_SHELL_RULE =
  '- この自動の実行では、スクリプトやコマンド（シェル）は動かせません。手順書にスクリプトや PDF を作る手順があっても、ここでは実行しないでください。'

/** The words of the person's button that finishes what an automatic run prepared (plugin-steps.md "続きをする"). */
export const CONTINUE_LABEL = '続きをする'

/**
 * A person's step the company starts by itself (owner decision 2026-11-06, option B): the run only
 * prepares; the member finishes in their own consultation with 「続きをする」. Overrides the
 * procedure only in what this run cannot do anyway.
 */
export const PREPARE_ONLY_RULE = [
  'この実行は準備だけです（そのあとは私が「' + CONTINUE_LABEL + '」で仕上げます）：',
  '- 材料を集め、下書き（たとえば提案書の HTML）を上の置き場所のフォルダに書いてください。',
  '- 確かめる点を書いてください。そのうち1つは必ず「残り（スクリプトの実行・PDF にすること など）は「' + CONTINUE_LABEL + '」で一緒に仕上げます」とはっきり書いてください。',
  '- 手順書のうち、スクリプトや PDF など自動ではできない部分は飛ばし、できたところまでで渡してください。',
].join('\n')

/** Where a step's run or consultation saves files (the app refuses anywhere else). */
export function deliverableFolderRule(folder: string): string {
  return `- ファイルを保存できるのは「（部署のフォルダ）/.personal/${folder}/」の中だけです（その人だけのフォルダで、共有されません）。その中に「日付_相手の名前」のフォルダを作って保存してください。`
}

/**
 * How an automatic run reports what it made (plugin-steps.md "What the step made"): one やること for
 * the member, linked to the record, carrying the files, the mail draft and the points to check —
 * the card shows it at the top (tasks-ui.md 「AI が用意したもの」). The run counts as done only then.
 */
export function deliverablesReport(recordId: string, label: string): string {
  return [
    '終わったら、作ったものを1つのやることにまとめて私に渡してください：',
    `- records_create で type: task、title は「${label}：（相手の名前）」、assignee は私、links.bundle に ${recordId}、links.prepared に作ったメールの下書きの id を入れます。`,
    '- fields.prep_summary に「確かめる点」（分からなかったこと・私に確かめてほしいこと）を箇条書きで書きます。なければ「確かめる点はありません」と書きます。',
    '- 作ったファイル（提案書の下書きなど）は、そのやることに records_link_file でつなぎます。',
    '- メールの下書きを作るときは、できているファイルを attachments に付けます。送るのは私です。',
  ].join('\n')
}

/** The person step a consultation was started from (the server binds that consultation to it). */
export interface PluginPersonStep {
  recordId: string
  pluginId: string
  step: string
}

/** A `start: person` step offered on a record's card. */
export interface PluginStepButton {
  pluginId: string
  step: string
  label: string
}

/** The answer of a person's start: the consultation's title and first message, or why not. */
export type PluginStepStartResult = { ok: true; title: string; message: string } | { ok: false; error: string }

/**
 * Where an automatic run of a person's step prepared something (the server's `continuation`, its
 * やること made by that run): 「続きをする」 opens the person's consultation of that step and record.
 */
export interface PluginStepContinuation {
  /** The record the step runs on (the deal). */
  recordId: string
  pluginId: string
  step: string
  label: string
  /** The やること the automatic run handed over. */
  taskId: string
}

/** The server's `continuation` (on `GET /me/plugin-steps/records/:id`), strictly; null when absent or malformed. */
export function parsePluginStepContinuation(data: unknown): PluginStepContinuation | null {
  const c = typeof data === 'object' && data !== null ? (data as { continuation?: unknown }).continuation : undefined
  if (typeof c !== 'object' || c === null) return null
  const v = c as Record<string, unknown>
  if (typeof v.recordId !== 'string' || !RECORD_ID_RE.test(v.recordId) || typeof v.taskId !== 'string' || !RECORD_ID_RE.test(v.taskId)) return null
  if (!str(v.pluginId, 40) || !str(v.step, 40) || !pluginRunStep(v.pluginId, v.step) || !str(v.label, 200)) return null
  return { recordId: v.recordId, pluginId: v.pluginId, step: v.step, label: v.label, taskId: v.taskId }
}

/** The start of 「続きをする」: the consultation's title and first message and the step it binds, or why not. */
export type PluginStepContinueResult = { ok: true; title: string; message: string; pluginStep: PluginPersonStep } | { ok: false; error: string }

/**
 * The first message of 「続きをする」 (the member's own consultation, bound to the step): what the
 * automatic run left — the やること, its files, its 確かめる点, its mail drafts — then the step's
 * person message. The person is there, so the procedure's scripts may run now.
 */
export function pluginStepContinueMessage(input: {
  person: string
  left: { taskId: string; questions: string | null; files: readonly string[]; drafts: ReadonlyArray<{ id: string; title: string }> }
}): string {
  const { left } = input
  return [
    `AI が自動で準備したところから、${CONTINUE_LABEL}つもりです。準備したものはやること ${left.taskId} にまとまっています。`,
    left.files.length > 0 ? ['置き場所にあるファイル：', ...left.files.map(f => `- ${f}`)].join('\n') : '置き場所にファイルはまだありません。',
    left.questions ? `確かめる点：\n${left.questions.trim()}` : '確かめる点はありません。',
    left.drafts.length > 0 ? ['メールの下書き：', ...left.drafts.map(d => `- ${d.id}（${d.title}）`)].join('\n') : 'メールの下書きはまだありません。',
    'いまは私がいるので、自動ではできなかった部分（スクリプトの実行・PDF にすることなど）も手順書どおりに進めてください。確かめる点は私に聞いてください。終わったら、できたファイルをそのやることにつなぎ、メールの下書きに付け直してください。',
    '',
    input.person,
  ].join('\n\n')
}

/**
 * The first message of a consultation a person starts from a step (the member's own message, made
 * by the app): the step, the record and the pinned procedure to follow together.
 */
export function pluginStepPersonMessage(input: { label: string; recordId: string; procedure: string; source: PluginStepProcedurePin['source']; deliverableFolder?: string }): string {
  return [
    ...(input.deliverableFolder ? [`（この相談でファイルを保存できるのは「（部署のフォルダ）/.personal/${input.deliverableFolder}/」の中だけです）`, ''] : []),
    `手順「${input.label}」を、記録 ${input.recordId} について一緒に進めたいです。まず records_get で記録を確かめてから、次の${input.source === 'company_skill' ? '会社の手順書（スキル）' : '手順書'}に沿って進めてください。`,
    '',
    '-----',
    input.procedure.trim(),
    '-----',
  ].join('\n')
}

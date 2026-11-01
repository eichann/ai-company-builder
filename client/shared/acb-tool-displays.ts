/**
 * The app's own tools (ACB) in plain Japanese, by the name the agent reports
 * (`mcp__<server>__<tool>`): the one place their labels live (chat-ui-and-history.md
 * 「Tool rows」). Pure, so the renderer resolves every ACB row by name alone — live,
 * in an unattended 「AI の番」, and in restored history — without depending on the
 * line the main process puts on the stream. The tool definitions (records/tools.ts,
 * the providers, company-files, …) take their `display` from here.
 *
 * Tools made per company: a record type's action (`<type>__<action>`) reads its
 * action's Japanese label in the past tense (「議事録を読み終えました」, from the core
 * types here, from the company's definition in main); a plugin operation reads its
 * label; anything not known here still gets a plain sentence, never the raw id.
 */
import { coreTypeDefinitions } from '../../shared/core/core-types'
import { companyPath, countOf, shortText } from './tool-display-text'
import type { ToolDisplay } from './tool-display'

// --- Past tense and progressive of an action label (dictionary form) -----------------------
const E_OR_I_ROW = 'えけげせぜてでねへべぺめれいきぎしじちぢにひびぴみり'
const GODAN: Record<string, [string, string]> = {
  う: ['い', 'って'], く: ['き', 'いて'], ぐ: ['ぎ', 'いで'], す: ['し', 'して'], つ: ['ち', 'って'],
  ぬ: ['に', 'んで'], ぶ: ['び', 'んで'], む: ['み', 'んで'],
}
const NOUN_END = /[㐀-鿿゠-ヿ]$/
/** The label without a trailing note in brackets (「やることにしない（自分で決める）」). */
const plain = (label: string) => label.trim().replace(/（[^（）]*）$/, '').trim()

/** 「議事録を読み終える」 → 「議事録を読み終えました」; a label it cannot conjugate is quoted. */
export function pastTense(label: string): string {
  const s = plain(label)
  if (s.endsWith('する')) return `${s.slice(0, -2)}しました`
  if (s.endsWith('なかった')) return `${s.slice(0, -4)}ませんでした`
  if (s.endsWith('ない')) return `${s}ことにしました`
  if (/[^っ]た$/.test(s)) return `${s.slice(0, -1)}ました`
  if (s.endsWith('る')) {
    const before = s.at(-2) ?? ''
    return `${s.slice(0, -1)}${E_OR_I_ROW.includes(before) ? '' : 'り'}ました`
  }
  const godan = GODAN[s.at(-1) ?? '']
  if (godan && !s.endsWith('ない')) return `${s.slice(0, -1)}${godan[0]}ました`
  if (NOUN_END.test(s)) return `${s}しました`
  return `「${s}」にしました`
}

/** 「議事録を読み終える」 → 「議事録を読み終えています」. */
export function progressive(label: string): string {
  const s = plain(label)
  if (s.endsWith('する')) return `${s.slice(0, -2)}しています`
  if (s.endsWith('なかった')) return `「${s}」にしています`
  if (s.endsWith('ない')) return `${s}ことにしています`
  if (/[^っ]た$/.test(s)) return `${s.slice(0, -1)}ています`
  if (s.endsWith('る')) {
    const before = s.at(-2) ?? ''
    return `${s.slice(0, -1)}${E_OR_I_ROW.includes(before) ? '' : 'っ'}ています`
  }
  const godan = GODAN[s.at(-1) ?? '']
  if (godan && !s.endsWith('ない')) return `${s.slice(0, -1)}${godan[1]}います`
  if (NOUN_END.test(s)) return `${s}しています`
  return `「${s}」にしています`
}

/** A record type's action (`task__start`, `meeting__finish_reading`): its Japanese label, past tense. */
export function actionToolDisplay(actionLabel: string): ToolDisplay {
  const done = pastTense(actionLabel)
  return { label: done, running: progressive(actionLabel), many: `${done}（{n} 件）` }
}

/** A connector plugin's operation (`corporate-sales__update_deal`): where, and its label. */
export function pluginOperationDisplay(system: string, opLabel: string, kind: 'read' | 'update' | 'create' | 'request'): ToolDisplay {
  if (kind === 'read') return { label: `${system} から最新の値を取り込みました`, running: `${system} から最新の値を取り込んでいます`, many: `${system} から {n} 件取り込みました` }
  if (kind === 'request') return { label: `${system}に「${opLabel}」をお願いしました`, running: `${system}に「${opLabel}」をお願いしています`, many: `${system}に「${opLabel}」を {n} 件お願いしました` }
  const done = `${system}で${pastTense(opLabel)}`
  return { label: done, running: `${system}で${progressive(opLabel)}`, many: `${done}（{n} 件）` }
}

/** 「宛先 2 人」: the count only, never an address or the subject. */
function mailDetail(input: Record<string, unknown>): string | undefined {
  const n = countOf(input.toRefs)
  return n > 0 ? `宛先 ${n} 人` : undefined
}

const JUDGEMENT_WORDS: Record<string, string> = { reply: '返事が要る', task: 'やることにした', no_reply: '読めば済む', set_aside: 'やることにしない', unsure: '確認待ち' }

const say = (label: string, running: string, many: string, describe?: ToolDisplay['describe']): ToolDisplay => ({ label, running, many, ...(describe ? { describe } : {}) })
const records = (name: string) => `mcp__acb_records__${name}`

/** Every fixed ACB tool. A tool made from a type or a plugin is not listed (see `acbToolDisplay`). */
export const ACB_TOOL_DISPLAYS: Readonly<Record<string, ToolDisplay>> = {
  // The company map (records/tools.ts).
  [records('records_my_turn')]: say('「あなたの番」を見ました', '「あなたの番」を見ています', '「あなたの番」を {n} 回見ました'),
  [records('records_ai_turn')]: say('「AI の番」を見ました', '「AI の番」を見ています', '「AI の番」を {n} 回見ました'),
  [records('records_query')]: say('会社の記録を探しました', '会社の記録を探しています', '会社の記録を {n} 回探しました', input => shortText(input.text)),
  [records('records_get')]: say('記録を読みました', '記録を読んでいます', '記録を {n} 件読みました'),
  [records('records_history')]: say('記録の台帳を見ました', '記録の台帳を見ています', '記録の台帳を {n} 件見ました'),
  [records('records_types')]: say('記録の種類を確かめました', '記録の種類を確かめています', '記録の種類を {n} 回確かめました'),
  [records('records_create')]: say('記録を作りました', '記録を作っています', '記録を {n} 件作りました', input => {
    const kind = coreTypeDefinitions().find(t => t.name === input.type)?.label
    const title = shortText(input.title, 30)
    return kind && title ? `${kind}「${title}」` : title
  }),
  [records('records_link_file')]: say('記録にファイルをつなぎました', '記録にファイルをつないでいます', '記録にファイルを {n} 件つなぎました', input => companyPath(input.path)),
  [records('records_unlink_file')]: say('記録からファイルを外しました', '記録からファイルを外しています', '記録からファイルを {n} 件外しました', input => companyPath(input.path)),
  [records('minutes_read')]: say('議事録を読みました', '議事録を読んでいます', '議事録を {n} 件読みました'),
  [records('minutes_link_bundle')]: say('会議を案件などにつなぎました', '会議を案件などにつないでいます', '会議を {n} 件つなぎました'),
  [records('decisions_record')]: say('決めたことを残しました', '決めたことを残しています', '決めたことを {n} 件残しました', input => shortText(input.title)),
  [records('mail_recipients')]: say('宛先の候補を調べました', '宛先の候補を調べています', '宛先の候補を {n} 回調べました'),
  [records('mail_draft_show')]: say('メールの下書きを出しました', 'メールの下書きを出しています', 'メールの下書きを {n} 件出しました'),
  [records('mail_draft_create')]: say('メールの下書きを作りました', 'メールの下書きを作っています', 'メールの下書きを {n} 件作りました', mailDetail),
  [records('mail_draft_update')]: say('メールの下書きを直しました', 'メールの下書きを直しています', 'メールの下書きを {n} 回直しました', mailDetail),
  [records('approvals_list')]: say('承認のお願いを見ました', '承認のお願いを見ています', '承認のお願いを {n} 回見ました'),
  [records('approvals_show')]: say('承認のお願いを出しました', '承認のお願いを出しています', '承認のお願いを {n} 件出しました'),
  // Connector providers on the same server (records/tool-providers.ts).
  [records('drive_pick_folder')]: say('Google Drive の置き場所を選んでもらいました', 'Google Drive の置き場所を選んでもらっています', 'Google Drive の置き場所を {n} 回選んでもらいました'),
  [records('drive_pick_files')]: say('Google Drive のファイルを選んでもらいました', 'Google Drive のファイルを選んでもらっています', 'Google Drive のファイルを {n} 回選んでもらいました'),
  [records('drive_picked')]: say('選んだ Google Drive のファイルを確かめました', '選んだ Google Drive のファイルを確かめています', '選んだ Google Drive のファイルを {n} 回確かめました'),
  [records('drive_read')]: say('Google Drive のファイルを読みました', 'Google Drive のファイルを読んでいます', 'Google Drive のファイルを {n} 件読みました'),
  [records('drive_put')]: say('Google Drive にファイルを置きました', 'Google Drive にファイルを置いています', 'Google Drive にファイルを {n} 件置きました', (input, ctx) => companyPath(input.path, ctx.root)),
  [records('inbox_read')]: say('来た連絡を読みました', '来た連絡を読んでいます', '来た連絡を {n} 件読みました'),
  // The outcome only: the reason may quote the outside message.
  [records('inbox_judge')]: say('来た連絡の判断を残しました', '来た連絡の判断を残しています', '来た連絡の判断を {n} 件残しました', input => JUDGEMENT_WORDS[String(input.outcome)]),
  // The fixed app servers.
  mcp__acb_consultations__search_consultations: say('過去の相談を探しました', '過去の相談を探しています', '過去の相談を {n} 回探しました', input => shortText(input.query)),
  mcp__acb_consultations__read_consultation: say('過去の相談を読みました', '過去の相談を読んでいます', '過去の相談を {n} 件読みました'),
  mcp__acb_company_files__company_search: say('会社全体を検索しました', '会社全体を検索しています', '会社全体を {n} 回検索しました', input => shortText(input.query)),
  mcp__acb_company_files__company_read_file: say('会社のファイルを読みました', '会社のファイルを読んでいます', '会社のファイルを {n} 件読みました', input => companyPath(input.path)),
  mcp__acb_company_files__company_list: say('会社のフォルダの中を見ました', '会社のフォルダの中を見ています', '会社のフォルダの中を {n} 回見ました', input => companyPath(input.path)),
  mcp__acb_review__request_review: say('確認をお願いしました', '確認をお願いしています', '確認を {n} 回お願いしました', input => shortText(input.title)),
  // The question is the member's topic, never a URL path.
  mcp__acb_web__web_research: say('Webで調べました', 'Webで調べています', 'Webで {n} 回調べました', input => shortText(input.question)),
  mcp__acb_ask__ask_user: say('質問しました', '質問しています', '{n} 回質問しました'),
}

/** A fixed tool's display, for its definition; throws at load if it is missing here. */
export function fixedToolDisplay(toolId: string): ToolDisplay {
  const display = ACB_TOOL_DISPLAYS[toolId]
  if (!display) throw new Error(`No display for ${toolId}: add it to client/shared/acb-tool-displays.ts`)
  return display
}

/** The same for a tool on the company map's server (`acb_records`). */
export const recordToolDisplay = (name: string) => fixedToolDisplay(records(name))

/** What an operation's name says, when its plugin is not known here (`update_deal` → 「記録を更新しました」). */
const OPERATION_WORDS: Array<[RegExp, string]> = [
  [/^(update|set|edit)_/, '更新する'], [/^(create|add|log|new)_/, '作る'], [/^(refresh|sync|pull|fetch)_/, '最新にする'],
  [/^(read|get|list|find|search)_/, '読む'], [/^(start)_/, '始める'], [/^(finish|complete|close)_/, '終える'], [/^(cancel|delete|remove)_/, '取り消す'],
]

/** An ACB tool's display by name, or undefined when it is not one of the app's tools. */
export function acbToolDisplay(toolName: string): ToolDisplay | undefined {
  const fixed = ACB_TOOL_DISPLAYS[toolName]
  if (fixed) return fixed
  const m = /^mcp__acb_records__([a-z][a-z0-9_-]*?)__([a-z0-9_]+)$/.exec(toolName)
  if (!m) return /^mcp__acb_[a-z_]+__/.test(toolName) ? say('アプリの道具を使いました', 'アプリの道具を使っています', 'アプリの道具を {n} 回使いました') : undefined
  const [, owner, action] = m
  const type = coreTypeDefinitions().find(t => t.name === owner)
  const declared = type?.actions[action]?.label
  if (declared) return actionToolDisplay(declared)
  const word = OPERATION_WORDS.find(([re]) => re.test(`${action}_`))?.[1]
  return type
    ? actionToolDisplay(word ? `${type.label}を${word}` : `${type.label}の作業をする`)
    : actionToolDisplay(word ? `記録を${word}` : 'つながっているサービスで作業する')
}

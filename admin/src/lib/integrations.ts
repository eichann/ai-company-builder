// 「つなぎ先」 (connector plugins, milestone 3 P8): the words the page shows and
// the table view of the mapping (読み替え表). The mapping's YAML is the stored
// form; the table edits it by parsing it (shared/core/yaml-lite, the same
// strict subset the server reads), changing one field and writing it back.
// The server decides: everything here is for the screen (`plugins.md`).

import { isYamlMap, parseYamlLite, type YamlValue } from '../../../shared/core/yaml-lite'
import { MILESTONE3_UNWRITABLE_FIELDS } from '../../../shared/core/plugins'
import type { FieldPolicy, ImportReport, PluginFieldPolicyView, PluginProblem } from './api'

/** Why it does not run, for people (no jargon). */
export const PROBLEM_TEXT: Record<PluginProblem, string> = {
  off: 'オフになっています',
  stopped: '運用担当者が全社で止めています',
  'not-on-shelf': '選んだ版が使えなくなりました。版を選び直してください',
  'package-changed': '中身が変わったため止めています。版を選び直してください',
  'no-key': '使う鍵が選ばれていないか、鍵が削除されました',
  'key-stopped': '選んだ鍵が止められています（「API キー」で再開できます）',
  'key-destination': '選んだ鍵は、この送り先に使えない設定です（「API キー」で送り先を確かめてください）',
  'mapping-invalid': '読み替え表に直すところがあります',
  'auto-not-acknowledged': '自動で書き戻す欄の確認がまだです（読み替え表を保存するときに確認します）',
}

/** The fixed words of 「HubSpot に聞いて確かめる」 and the import, for people. */
export const REASON_TEXT: Record<string, string> = {
  'key-rejected': '鍵が受け付けられませんでした（鍵が取り消されたか、間違っている可能性があります）',
  'not-permitted': '鍵の権限が足りませんでした（鍵を作るときの権限を確かめてください）',
  'rate-limited': '短い時間に呼び出しが多すぎました。少し待ってからもう一度お試しください',
  'server-error': '相手のサーバーでエラーが起きました。少し待ってからもう一度お試しください',
  'unreadable-answer': '相手の答えが読めませんでした',
  'account-changed': '鍵が別のアカウントのものになっています',
  'account-unreadable': '相手のアカウントを確かめられませんでした',
  'not-allowed': '権限が変わったため、途中で止めました',
  'connection-changed': 'つなぎ先が切り替わったため、途中で止めました',
  'records-off': '記録の仕組みがオフになったため、途中で止めました',
  'practice-real-secret': '練習用の送り先には本物の鍵を送れないため、送りませんでした',
  timeout: '時間内に答えがありませんでした',
  dns: '相手のサーバーが見つかりませんでした',
  connect: '相手のサーバーにつながりませんでした',
}
export const describeReason = (reason: string | null) =>
  reason === null ? '' : REASON_TEXT[reason] ?? (reason in PROBLEM_TEXT ? PROBLEM_TEXT[reason as PluginProblem] : `うまくいきませんでした（${reason}）`)

export const IMPORT_STATUS_TEXT: Record<ImportReport['status'], string> = {
  complete: '取り込みました',
  truncated: '件数の上限で途中までになりました（読み替え表の max で増やせます）',
  stopped: '途中で止まりました',
  failed: '取り込めませんでした',
  'timed-out': '時間の上限（5分）で途中までになりました',
}

export const HISTORY_LABELS: Record<string, string> = {
  install: '使い始めた（版と鍵を選んだ）',
  change: '版または鍵を変えた',
  enable: 'オンにした',
  disable: 'オフにした（止めた）',
  mapping: '読み替え表を保存した',
  restore: '読み替え表を前の版に戻した',
  acknowledge: '自動で書き戻す欄を確認した',
  account: '相手のアカウントと結びついた',
  connection: '新しいつなぎ先として始めた',
  import: '取り込んだ',
  'read-scope': '読める人を変えた',
}

/**
 * A refusal of the 「つなぎ先」 routes in this page's words (the server's own
 * sentences name the mechanism; these do not), else null for describeError.
 */
export function integrationRefusal(code: string | undefined, body: Record<string, unknown> | null): string | null {
  const problem = typeof body?.problem === 'string' ? (body.problem as PluginProblem) : null
  switch (code) {
    case 'PLUGIN_NOT_READY': return `まだオンにできません：${problem && PROBLEM_TEXT[problem] ? PROBLEM_TEXT[problem] : '設定が足りません'}`
    case 'PLUGIN_NOT_ACTIVE': return `いまは動いていません：${problem && PROBLEM_TEXT[problem] ? PROBLEM_TEXT[problem] : '設定が足りません'}`
    case 'PLUGIN_WOULD_STOP': return 'この設定にすると止まってしまうため、変えていません（先にオフにするか、読み替え表を直してください）'
    case 'NOT_INSTALLED': return '先に版と鍵を選んで保存してください'
    case 'READ_SCOPE_REQUIRED': return '先に「読める人」（部署かメンバー）を選んで保存してください。誰も選ばないままではオンにできず、オンの間は空にできません'
    case 'READ_SCOPE_INVALID': return 'この会社にない部署か、メンバーではない人が含まれています'
    case 'KEY_NOT_USABLE': return 'この鍵は使えません（「API キー」で登録した、このサービスの会社の鍵を選んでください）'
    case 'VERSION_NOT_ON_SHELF': return 'この版はもう使えません。版を選び直してください'
    case 'SERVICE_CHANGED': return 'この版は別のサービスにつなぐため、選べません'
    case 'RECORDS_DISABLED': return '記録の仕組みがオフのため、取り込めません（「会社の設定」で確かめてください）'
    case 'IMPORT_RUNNING': return 'いま取り込み中です。終わってからもう一度お試しください'
    case 'ACCOUNT_CHANGED': return '鍵が、これまでとは別のアカウントのものになっています。取り込みを止めました'
    case 'MAPPING_VERSION_NOT_FOUND': return 'この版の読み替え表はありません'
    case 'PLUGIN_NOT_FOUND': return 'このつなぎ先は使えません'
    default: return null
  }
}

/** How a field is written back, as the table offers it. */
export type WriteChoice = 'read' | 'prior' | 'auto'
export const WRITE_CHOICE_LABELS: Record<WriteChoice, string> = {
  read: '書き戻さない（読むだけ）',
  prior: '承認が要る（いまは書き戻さない）',
  auto: '自動で書き戻す',
}

export interface MappingRow {
  object: string
  field: string
  /** The outside property. */
  from: string
  choice: WriteChoice
  /** The field can never be written back now (the stage: it can make a deal won / lost). */
  locked: boolean
}

type YamlMap = { [key: string]: YamlValue }

/** The mapping's sections that are objects (everything but `people` / `policy`). */
const objectNames = (doc: YamlMap) => Object.keys(doc).filter(k => k !== 'people' && k !== 'policy' && isYamlMap(doc[k]))

function choiceOf(field: string, write: boolean, policy: YamlMap, policies: PluginFieldPolicyView[]): WriteChoice {
  if (!write) return 'read'
  const explicit = policy[field]
  const p = (typeof explicit === 'string' ? explicit : policies.find(v => v.field === field)?.policy ?? 'prior') as FieldPolicy
  return p === 'auto' ? 'auto' : p === 'off' ? 'read' : 'prior'
}

/**
 * The table view of a mapping text, or the YAML error (line and sentence).
 * `policies`: the server's effective policies of the mapping in force (for
 * fields whose policy the text leaves to the package's defaults).
 */
export function mappingRows(text: string, policies: PluginFieldPolicyView[]): { ok: true; rows: MappingRow[] } | { ok: false; error: string } {
  const parsed = parseYamlLite(text)
  if (!parsed.ok) return { ok: false, error: `${parsed.line} 行目: ${parsed.error}` }
  if (!isYamlMap(parsed.value)) return { ok: false, error: '読み替え表の形ではありません' }
  const doc = parsed.value
  const policy = isYamlMap(doc.policy) ? doc.policy : {}
  const rows: MappingRow[] = []
  for (const object of objectNames(doc)) {
    const fields = (doc[object] as YamlMap).fields
    if (!isYamlMap(fields)) continue
    for (const [field, rule] of Object.entries(fields)) {
      if (!isYamlMap(rule)) continue
      rows.push({
        object, field, from: typeof rule.from === 'string' ? rule.from : '',
        choice: choiceOf(field, rule.write === true, policy, policies),
        locked: MILESTONE3_UNWRITABLE_FIELDS.includes(field),
      })
    }
  }
  return { ok: true, rows }
}

/**
 * The mapping text with one field changed (outside property and/or how it is
 * written back). Writing back always states the policy explicitly, so what
 * the table shows is what is saved. Comments in the text are not kept.
 */
export function changeMappingField(text: string, object: string, field: string, change: { from?: string; choice?: WriteChoice }): string {
  const parsed = parseYamlLite(text)
  if (!parsed.ok || !isYamlMap(parsed.value)) return text
  const doc = structuredClone(parsed.value) as YamlMap
  const section = doc[object]
  const fields = isYamlMap(section) ? section.fields : undefined
  const rule = isYamlMap(fields) ? fields[field] : undefined
  if (!isYamlMap(rule)) return text
  if (change.from !== undefined) rule.from = change.from
  if (change.choice !== undefined) {
    rule.write = change.choice !== 'read'
    const policy: YamlMap = isYamlMap(doc.policy) ? doc.policy : {}
    if (change.choice === 'read') delete policy[field]
    else policy[field] = change.choice
    if (Object.keys(policy).length > 0) doc.policy = policy
    else delete doc.policy
  }
  return mappingToYaml(doc)
}

// ── Writing YAML the server's strict reader takes back as the same value ──

const PLAIN_RE = /^[\p{L}_][\p{L}\p{N}_.\-/]*$/u
const RESERVED = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off'])

function scalar(v: YamlValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') return PLAIN_RE.test(v) && !RESERVED.has(v.toLowerCase()) ? v : JSON.stringify(v)
  return JSON.stringify(v)
}
const key = (k: string) => scalar(k)

function flow(v: YamlValue): string {
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`
  if (isYamlMap(v)) {
    const entries = Object.entries(v)
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${key(k)}: ${flow(x)}`).join(', ')} }`
  }
  return scalar(v)
}

/** Two levels in block form (object → fields / import / links, people → table), the rest on one line. */
function block(v: YamlMap, indent: number, depth: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const [k, x] of Object.entries(v)) {
    if (isYamlMap(x) && Object.keys(x).length > 0 && depth < 2) {
      lines.push(`${pad}${key(k)}:`)
      lines.push(...block(x, indent + 2, depth + 1))
    } else {
      lines.push(`${pad}${key(k)}: ${flow(x)}`)
    }
  }
  return lines
}

/** A mapping value as YAML: sections in block form, each field's rule on one line. */
export function mappingToYaml(doc: YamlMap): string {
  return `${block(doc, 0, 0).join('\n')}\n`
}

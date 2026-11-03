/**
 * A contract-2 business plugin's flow part of `plugin.yaml` (plan C1, design
 * 節目5 §2-5 / §4): `roles`, `settings` (`plugin-settings.ts`), `steps`, `ui`
 * and `upgrade`. The syntax of stages
 * 4a and 4b is fixed here once; later items add behaviour, not keys.
 *
 * ```yaml
 * contract: 2
 * types: [program_plan]
 * roles:
 *   plan_approver: { label: 企画の承認者 }
 * settings:
 *   plans_per_day: { label: 1日の企画案の数, kind: number, default: 4, min: 1, max: 10 }
 * steps:
 *   make_plans:
 *     label: 今日の企画案を作る
 *     for: { type: program_plan, state: drafting }
 *     start: ai_turn                  # or person: opens a consultation with the procedure
 *     procedure: { default: steps/make-plans.md, overridable: true }
 *     tools: [records, web_research]
 *     connector_roles: [calendar.read]
 * ui:
 *   bridge: 1
 *   tab: { label: 番組, icon: FilmSlate, entry: ui/index.html }
 *   peek: { implements: request, state_group: mine }
 *   record_sections:
 *     - { type: program_plan, label: 構成, entry: ui/plan.html }
 *   file_actions:                     # the file list's right-click menu (stage 4b A6)
 *     - { label: 企画の資料にする, entry: ui/attach.html, kinds: [markdown, pdf] }
 * upgrade:
 *   from: 0.1.0
 *   at: [{ type: program_plan, state: drafting }]
 * ```
 *
 * Steps always run on the member's PC: there is no key that places one on the
 * server, and the keys someone might reach for (`runs_on`, `server`, `cron`…)
 * are refused with that reason. No scripts in 4a (§5-11), no conditions or
 * expressions (owner rule §8-1). What depends on the types (a step's type and
 * state, a section's type, the files named) is checked with the package
 * (`plugin-package.ts`).
 */
import { isValidSkillName } from './names'
import {
  PLUGIN_STEP_STARTS, PLUGIN_VERSION_RE, ROLE_WHO_PREFIX,
  type FlowPart, type PluginRoleDeclaration, type PluginStatePoint, type PluginStep, type PluginStepStart, type PluginUi, type PluginUpgrade,
} from './plugin-declaration'
import { isStr, strList, unknownKeys } from './plugin-declaration-rules'
import { PLUGIN_FILE_KINDS } from './plugin-file-kinds'
import { parseSettings } from './plugin-settings'
import { INTERFACES, ONTOLOGY_NAME_RE } from './record-types'
import { isYamlMap, type YamlValue } from './yaml-lite'

/** Top-level keys only a contract-2 business plugin may write. */
export const FLOW_KEYS: readonly string[] = ['roles', 'settings', 'steps', 'ui', 'upgrade']

/**
 * What a step may be given (design 節目5 §4-2, 統合版 §5-4: the step's ACB
 * tools only; the web and file writes only when declared). A fixed list; a
 * name not on it makes the package unusable.
 * - `records`: the typed record tools (query, get, act) — through the server's checks
 * - `plugin_operations`: this business plugin's declared connector operations
 * - `approvals`: ask for an approval (never approve)
 * - `outbound_draft`: put a draft to send outside (never send)
 * - `web_research`: search and read the web
 * - `files_read` / `files_write`: the company folder, within the member's rights
 */
export const PLUGIN_STEP_TOOLS: readonly string[] = [
  'records', 'plugin_operations', 'approvals', 'outbound_draft', 'web_research', 'files_read', 'files_write',
]

/** Bridge versions this build knows (design 節目5 §2-4). */
export const PLUGIN_BRIDGE_VERSIONS: readonly number[] = [1]

/** What the core's peek can list (design 節目5 §2-1 ②): the member's turn, what they wait on, the AI's turn. */
export const PLUGIN_PEEK_STATE_GROUPS: readonly string[] = ['mine', 'waiting', 'ai_turn']

/** At most this many right-click items per plugin (the menu is the core's and stays short). */
export const MAX_PLUGIN_FILE_ACTIONS = 3

/** `steps/<file>.md`: one level, plain names. */
export const STEP_FILE_RE = /^steps\/[a-z0-9][a-z0-9_-]{0,63}\.md$/
/** `ui/…/<file>.html` as a frame's entry: plain segments, at most three folders deep. */
export const UI_ENTRY_RE = /^ui\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/){0,3}[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.html$/
/** Connector role names (`mail.send`, `calendar.read`); the list itself is the core's. */
export const CONNECTOR_ROLE_NAME_RE = /^[a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})?$/
/** An icon name of the app's icon set (`FilmSlate`): letters and digits only, drawn by the core. */
const ICON_RE = /^[A-Z][A-Za-z0-9]{0,39}$/

const ON_PC = '手順は必ずメンバーの PC で動きます。サーバーで動かす指定はありません'
const BY_STATE = 'きっかけは記録の状態（for）だけです。時刻や条件は書けません'
/** Keys refused inside a step, with why (the general list in `plugin-declaration-rules.ts` applies too). */
const NOT_IN_STEP: Record<string, string> = {
  scripts: 'スクリプトはまだ使えません（隔離して動かす道具ができてから足します）',
  script: 'スクリプトはまだ使えません（隔離して動かす道具ができてから足します）',
  runs_on: ON_PC, run_on: ON_PC, runtime: ON_PC, server: ON_PC, where: ON_PC, location: ON_PC, on_server: ON_PC,
  schedule: BY_STATE, cron: BY_STATE, trigger: BY_STATE, every: BY_STATE, at: BY_STATE,
  model: 'AI の種類は会社とメンバーの設定で決まります',
  instructions: '手順書は procedure の default に書きます',
  skill: '会社のスキルを使うかどうかは会社の設定です。宣言には overridable だけを書きます',
}

function parseStatePoint(where: string, v: YamlValue | undefined, err: (m: string) => void): PluginStatePoint | null {
  if (!isYamlMap(v)) { err(`${where}は { type: 型, state: 状態 } の形で書いてください`); return null }
  unknownKeys(`${where}: `, v, ['type', 'state'], err)
  if (typeof v.type !== 'string' || !ONTOLOGY_NAME_RE.test(v.type)) { err(`${where}の type は型の名前です`); return null }
  if (typeof v.state !== 'string' || !ONTOLOGY_NAME_RE.test(v.state)) { err(`${where}の state は状態の名前です`); return null }
  return { type: v.type, state: v.state }
}

function parseRoles(v: YamlValue | undefined, err: (m: string) => void): Record<string, PluginRoleDeclaration> {
  const roles: Record<string, PluginRoleDeclaration> = {}
  if (v === undefined) return roles
  if (!isYamlMap(v)) { err('roles は「役割の名前: { label: … }」の形で書いてください'); return roles }
  for (const [name, r] of Object.entries(v)) {
    const where = `役割「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`役割の名前「${name}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(r)) { err(`${where}は { label: … } の形で書いてください`); continue }
    unknownKeys(`${where}: `, r, ['label', 'description'], err)
    if (!isStr(r.label)) err(`${where}の label（画面に出す名前）を書いてください`)
    if (r.description !== undefined && typeof r.description !== 'string') err(`${where}の description は文字で書いてください`)
    roles[name] = { label: typeof r.label === 'string' ? r.label : '', description: typeof r.description === 'string' ? r.description : null }
  }
  if (Object.keys(roles).length > 50) err('roles は50個までです')
  return roles
}

function parseSteps(v: YamlValue | undefined, err: (m: string) => void): Record<string, PluginStep> {
  const steps: Record<string, PluginStep> = {}
  if (v === undefined) return steps
  if (!isYamlMap(v)) { err('steps は「手順の名前: { label, for, start, procedure, tools }」の形で書いてください'); return steps }
  for (const [name, s] of Object.entries(v)) {
    const where = `手順「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`手順の名前「${name}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(s)) { err(`${where}は { label, for, start, procedure, tools } の形で書いてください`); continue }
    unknownKeys(`${where}: `, s, ['label', 'for', 'start', 'procedure', 'tools', 'connector_roles'], err, NOT_IN_STEP)
    if (!isStr(s.label)) err(`${where}の label（画面に出す名前）を書いてください`)
    const target = parseStatePoint(`${where}の for `, s.for, err)
    if (typeof s.start !== 'string' || !(PLUGIN_STEP_STARTS as readonly string[]).includes(s.start)) err(`${where}の start は ${PLUGIN_STEP_STARTS.join(' / ')} です（AI の番で自動に始める／人が始める）`)
    let procedure: PluginStep['procedure'] | null = null
    if (!isYamlMap(s.procedure)) err(`${where}の procedure は { default: steps/<名前>.md, overridable: true か false } の形で書いてください`)
    else {
      unknownKeys(`${where}の procedure: `, s.procedure, ['default', 'overridable'], err, { skill: NOT_IN_STEP.skill })
      const def = s.procedure.default
      if (typeof def !== 'string' || !STEP_FILE_RE.test(def)) err(`${where}の procedure の default は包みの中の手順書（steps/<名前>.md）です`)
      const overridable = s.procedure.overridable ?? false
      if (typeof overridable !== 'boolean') err(`${where}の procedure の overridable は true か false です`)
      procedure = { default: typeof def === 'string' ? def : '', overridable: overridable === true }
    }
    const tools = strList(s.tools)
    if (!tools) err(`${where}の tools は道具の名前の並びです（${PLUGIN_STEP_TOOLS.join(' / ')}）`)
    else {
      for (const t of tools) if (!PLUGIN_STEP_TOOLS.includes(t)) err(`${where}の tools「${t}」という道具はありません（${PLUGIN_STEP_TOOLS.join(' / ')}）`)
      if (new Set(tools).size !== tools.length) err(`${where}の tools に同じ道具が2回書かれています`)
    }
    const connectorRoles = strList(s.connector_roles)
    if (!connectorRoles || !connectorRoles.every(r => CONNECTOR_ROLE_NAME_RE.test(r))) err(`${where}の connector_roles は、つなぎ先の役目の名前の並びです（例：mail.send）`)
    else if (new Set(connectorRoles).size !== connectorRoles.length) err(`${where}の connector_roles に同じ役目が2回書かれています`)
    if (!target || !procedure) continue
    steps[name] = {
      label: typeof s.label === 'string' ? s.label : '', for: target, start: s.start as PluginStepStart, procedure,
      tools: tools ?? [], connectorRoles: connectorRoles ?? [],
    }
  }
  if (Object.keys(steps).length > 100) err('steps は100個までです')
  return steps
}

function parseEntry(where: string, v: YamlValue | undefined, err: (m: string) => void): string {
  if (typeof v !== 'string' || !UI_ENTRY_RE.test(v)) { err(`${where}の entry は包みの中の画面のファイル（ui/<名前>.html）です。外の場所は書けません`); return '' }
  return v
}

function parseUi(v: YamlValue | undefined, err: (m: string) => void): PluginUi | null {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('ui は { bridge, tab, peek, record_sections, file_actions } の形で書いてください'); return null }
  unknownKeys('ui: ', v, ['bridge', 'tab', 'peek', 'record_sections', 'file_actions'], err, {
    csp: '画面の枠の決まり（通信なし）は本体が決めます', connect: '画面の枠から外へは通信できません（本体への橋だけです）',
    permissions: '画面の枠には権限（カメラ・マイクなど）を渡しません', preload: '画面の枠には何も渡しません',
  })
  if (typeof v.bridge !== 'number' || !PLUGIN_BRIDGE_VERSIONS.includes(v.bridge)) err(`ui の bridge は橋の版（${PLUGIN_BRIDGE_VERSIONS.join(' / ')}）です`)
  let tab: PluginUi['tab'] = null
  if (v.tab !== undefined) {
    if (!isYamlMap(v.tab)) err('ui の tab は { label, icon, entry } の形で書いてください')
    else {
      unknownKeys('ui の tab: ', v.tab, ['label', 'icon', 'entry'], err)
      if (!isStr(v.tab.label)) err('ui の tab の label（タブの名前）を書いてください')
      if (typeof v.tab.icon !== 'string' || !ICON_RE.test(v.tab.icon)) err('ui の tab の icon はアイコンの名前です（例：FilmSlate）')
      tab = { label: typeof v.tab.label === 'string' ? v.tab.label : '', icon: typeof v.tab.icon === 'string' ? v.tab.icon : '', entry: parseEntry('ui の tab ', v.tab.entry, err) }
    }
  }
  let peek: PluginUi['peek'] = null
  if (v.peek !== undefined) {
    if (!isYamlMap(v.peek)) err('ui の peek は { implements, state_group } の形で書いてください')
    else {
      unknownKeys('ui の peek: ', v.peek, ['implements', 'state_group'], err, { entry: 'のぞき見は本体が描きます。出すものだけを書きます' })
      if (typeof v.peek.implements !== 'string' || !Object.prototype.hasOwnProperty.call(INTERFACES, v.peek.implements)) err(`ui の peek の implements は共通の型の名前です（${Object.keys(INTERFACES).join(' / ')}）`)
      if (typeof v.peek.state_group !== 'string' || !PLUGIN_PEEK_STATE_GROUPS.includes(v.peek.state_group)) err(`ui の peek の state_group は ${PLUGIN_PEEK_STATE_GROUPS.join(' / ')} です`)
      peek = { implements: String(v.peek.implements), stateGroup: String(v.peek.state_group) }
    }
  }
  const recordSections: PluginUi['recordSections'] = []
  const rawSections = v.record_sections ?? []
  if (!Array.isArray(rawSections)) err('ui の record_sections は { type, label, entry } の並びです')
  else rawSections.forEach((sec, i) => {
    const where = `ui の record_sections の ${i + 1} 番目`
    if (!isYamlMap(sec)) { err(`${where}は { type, label, entry } の形で書いてください`); return }
    unknownKeys(`${where}: `, sec, ['type', 'label', 'entry'], err)
    if (typeof sec.type !== 'string' || !ONTOLOGY_NAME_RE.test(sec.type)) err(`${where}の type は型の名前です`)
    if (!isStr(sec.label)) err(`${where}の label（欄の名前）を書いてください`)
    recordSections.push({ type: String(sec.type), label: typeof sec.label === 'string' ? sec.label : '', entry: parseEntry(where, sec.entry, err) })
  })
  const fileActions: PluginUi['fileActions'] = []
  const rawActions = v.file_actions ?? []
  if (!Array.isArray(rawActions)) err('ui の file_actions は { label, entry, kinds } の並びです')
  else {
    if (rawActions.length > MAX_PLUGIN_FILE_ACTIONS) err(`ui の file_actions は ${MAX_PLUGIN_FILE_ACTIONS} つまでです（右クリックのメニューは本体が描き、短く保ちます）`)
    rawActions.forEach((act, i) => {
      const where = `ui の file_actions の ${i + 1} 番目`
      if (!isYamlMap(act)) { err(`${where}は { label, entry, kinds } の形で書いてください`); return }
      unknownKeys(`${where}: `, act, ['label', 'entry', 'kinds'], err, {
        extensions: '拡張子ではなく、ファイルの種類（kinds）で書きます', paths: '出す場所は書けません。どのファイルに出すかは種類（kinds）で決まります',
        icon: '右クリックの項目の印は本体が決めます', shortcut: '右クリックの項目にキーは割り当てられません',
      })
      if (!isStr(act.label) || String(act.label).length > 30) err(`${where}の label（メニューに出す名前、30文字まで）を書いてください`)
      const kinds = strList(act.kinds)
      if (!kinds || kinds.length === 0) err(`${where}の kinds（出すファイルの種類：${PLUGIN_FILE_KINDS.join(' / ')}）を書いてください`)
      else for (const k of kinds) if (!(PLUGIN_FILE_KINDS as readonly string[]).includes(k)) err(`${where}の kinds の「${k}」は知らない種類です（${PLUGIN_FILE_KINDS.join(' / ')}）`)
      fileActions.push({ label: typeof act.label === 'string' ? act.label : '', entry: parseEntry(where, act.entry, err), kinds: kinds ?? [] })
    })
  }
  if (!tab && !peek && recordSections.length === 0 && fileActions.length === 0) err('ui を書いたら、tab・peek・record_sections・file_actions のどれかを書いてください')
  return { bridge: typeof v.bridge === 'number' ? v.bridge : 0, tab, peek, recordSections, fileActions }
}

function parseUpgrade(v: YamlValue | undefined, version: unknown, err: (m: string) => void): PluginUpgrade | null {
  if (v === undefined) return null
  if (!isYamlMap(v)) { err('upgrade は { from: 版, at: [{ type, state }] } の形で書いてください'); return null }
  unknownKeys('upgrade: ', v, ['from', 'at'], err)
  if (typeof v.from !== 'string' || !PLUGIN_VERSION_RE.test(v.from)) { err('upgrade の from は "0.1.0" のような版です'); return null }
  if (typeof version === 'string' && PLUGIN_VERSION_RE.test(version)) {
    const [a, b] = [v.from.split('.').map(Number), version.split('.').map(Number)]
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    if (cmp >= 0) err('upgrade の from は、この版より古い版です')
  }
  if (!Array.isArray(v.at) || v.at.length === 0) { err('upgrade の at は、途中の仕事がこの版に移ってよい { type, state } の並びです'); return null }
  const at: PluginStatePoint[] = []
  v.at.forEach((p, i) => { const point = parseStatePoint(`upgrade の at の ${i + 1} 番目`, p, err); if (point) at.push(point) })
  return { from: v.from, at }
}

/** A contract-2 business plugin's flow part. `who` entries `role:<name>` are checked against `roles` here. */
export function parseFlow(raw: { [k: string]: YamlValue }, err: (m: string) => void): FlowPart {
  const roles = parseRoles(raw.roles, err)
  const ops = raw.operations
  if (isYamlMap(ops)) for (const [opname, op] of Object.entries(ops)) {
    if (!isYamlMap(op)) continue
    for (const w of strList(op.who) ?? []) {
      if (w.startsWith(ROLE_WHO_PREFIX) && !Object.prototype.hasOwnProperty.call(roles, w.slice(ROLE_WHO_PREFIX.length))) {
        err(`操作「${opname}」の who「${w}」: 役割「${w.slice(ROLE_WHO_PREFIX.length)}」が roles にありません`)
      }
    }
  }
  return { roles, settings: parseSettings(raw.settings, roles, err), steps: parseSteps(raw.steps, err), ui: parseUi(raw.ui, err), upgrade: parseUpgrade(raw.upgrade, raw.version, err) }
}

/**
 * Whether a company may run its Skill `skill` as step `stepName`'s procedure
 * (the company setting of a later item checks with this): the step must say
 * `overridable: true` and the name must be a Skill name. null = allowed.
 */
export function companySkillOverrideProblem(manifest: Pick<FlowPart, 'steps'>, stepName: string, skill: string): string | null {
  const step = Object.prototype.hasOwnProperty.call(manifest.steps, stepName) ? manifest.steps[stepName] : undefined
  if (!step) return `手順「${stepName}」はありません`
  if (!step.procedure.overridable) return `手順「${stepName}」は会社のスキルに置き換えられません`
  if (!isValidSkillName(skill)) return `スキルの名前「${skill}」は英小文字・数字・- _ で書いてください`
  return null
}

/**
 * The tools a step's run gets: the step's declared tools, whichever procedure
 * runs — a company Skill used as the procedure never adds any (what the Skill
 * asks for is cut to this list).
 */
export function stepToolsFor(step: Pick<PluginStep, 'tools'>, requested?: readonly string[]): string[] {
  return requested === undefined ? [...step.tools] : step.tools.filter(t => requested.includes(t))
}

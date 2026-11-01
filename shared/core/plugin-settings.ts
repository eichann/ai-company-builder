/**
 * A contract-2 business plugin's `settings` (the first rung of the owner's
 * "fit ladder", plugins.md "Fitting a company"): typed parameters with a
 * default and bounds that an owner/admin may change per company later, read by
 * the plugin's steps and approval rules.
 *
 * ```yaml
 * settings:
 *   approval_amount: { label: 承認が要る金額, kind: number, default: 1000000, min: 0 }
 *   reply_within:    { label: 返事の目安, kind: duration, default: 1d, min: 1h, max: 14d }
 *   tone:            { label: 文面, kind: choice, options: [formal, casual], default: formal }
 *   cc_manager:      { label: 責任者を CC に入れる, kind: boolean, default: true }
 *   approver:        { label: 金額を承認する人, kind: role, default: sales_manager }
 *   mail_service:    { label: メールを送るサービス, kind: connector, connector_role: mail.send }
 * ```
 *
 * **Parameters only** (owner rule §8-1): a setting holds a value. Nothing
 * that branches the flow — a condition, an expression, a state, an action or a
 * step it would select — has a place; those keys are refused with that reason.
 * A plugin that needs a different flow for a company is a different plugin
 * (rung ⑤), not a setting.
 */
import {
  PLUGIN_SETTING_KINDS, PLUGIN_ACTORS,
  type PluginRoleDeclaration, type PluginSetting,
} from './plugin-declaration'
import { isStr, unknownKeys } from './plugin-declaration-rules'
import { ONTOLOGY_NAME_RE } from './record-types'
import { isYamlMap, type YamlValue } from './yaml-lite'

/** `<n>m` / `<n>h` / `<n>d`. */
export const SETTING_DURATION_RE = /^([1-9]\d{0,5})(m|h|d)$/
const CONNECTOR_ROLE_RE = /^[a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})?$/
/** Built-in people a `role` setting may point at, besides the plugin's own roles. */
const BUILTIN_ROLE_REFS: readonly string[] = PLUGIN_ACTORS.filter(a => a === 'dept_manager' || a === 'admin')

const NO_BRANCH = '設定は値だけです。流れ（状態・操作・手順）を分ける書き方はありません。流れが違うなら別のプラグインにします'
const NOT_IN_SETTING: Record<string, string> = Object.fromEntries(
  ['when', 'if', 'then', 'else', 'expression', 'formula', 'states', 'state', 'actions', 'action', 'steps', 'step', 'next', 'goto', 'branch', 'selects', 'affects', 'enables', 'disables']
    .map(k => [k, NO_BRANCH]),
)

/** Minutes of a `SETTING_DURATION_RE` value (null when it is not one). */
export function settingDurationMinutes(v: unknown): number | null {
  const m = typeof v === 'string' ? SETTING_DURATION_RE.exec(v) : null
  if (!m) return null
  return Number(m[1]) * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440)
}

/**
 * Why `value` cannot be setting `setting`'s value (null: it can). The default
 * is checked with it here; a company's value will be checked with it too.
 */
export function settingValueProblem(setting: PluginSetting, value: unknown, roles: Record<string, PluginRoleDeclaration>): string | null {
  switch (setting.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return '数で書いてください'
      if (setting.min !== null && value < setting.min) return `${setting.min} 以上です`
      if (setting.max !== null && value > setting.max) return `${setting.max} 以下です`
      return null
    case 'duration': {
      const mins = settingDurationMinutes(value)
      if (mins === null) return '時間は 30m・2h・3d のように書いてください'
      if (setting.min !== null && mins < settingDurationMinutes(setting.min)!) return `${setting.min} 以上です`
      if (setting.max !== null && mins > settingDurationMinutes(setting.max)!) return `${setting.max} 以下です`
      return null
    }
    case 'choice':
      return typeof value === 'string' && setting.options.includes(value) ? null : `${setting.options.join(' / ')} のどれかです`
    case 'boolean':
      return typeof value === 'boolean' ? null : 'true か false です'
    case 'role':
      return typeof value === 'string' && (Object.prototype.hasOwnProperty.call(roles, value) || BUILTIN_ROLE_REFS.includes(value))
        ? null : `このプラグインの roles の名前か ${BUILTIN_ROLE_REFS.join(' / ')} です`
    case 'connector':
      // The value is the company's choice of a connected service, made later; the declaration has none.
      return value === null ? null : 'つなぎ先は会社が選びます（宣言には書きません）'
  }
}

export function parseSettings(v: YamlValue | undefined, roles: Record<string, PluginRoleDeclaration>, err: (m: string) => void): Record<string, PluginSetting> {
  const settings: Record<string, PluginSetting> = {}
  if (v === undefined) return settings
  if (!isYamlMap(v)) { err('settings は「設定の名前: { label, kind, default, … }」の形で書いてください'); return settings }
  for (const [name, raw] of Object.entries(v)) {
    const where = `設定「${name}」`
    if (!ONTOLOGY_NAME_RE.test(name)) { err(`設定の名前「${name}」は英小文字・数字・_ で書いてください`); continue }
    if (!isYamlMap(raw)) { err(`${where}は { label, kind, default, … } の形で書いてください`); continue }
    const kind = raw.kind
    if (typeof kind !== 'string' || !(PLUGIN_SETTING_KINDS as readonly string[]).includes(kind)) {
      err(`${where}の kind は ${PLUGIN_SETTING_KINDS.join(' / ')} です`)
      continue
    }
    const extra: Record<string, readonly string[]> = {
      number: ['min', 'max'], duration: ['min', 'max'], choice: ['options', 'option_labels'], boolean: [], role: [], connector: ['connector_role'],
    }
    unknownKeys(`${where}: `, raw, ['label', 'kind', 'default', ...extra[kind]], err, NOT_IN_SETTING)
    if (!isStr(raw.label)) err(`${where}の label（画面に出す名前）を書いてください`)
    const label = typeof raw.label === 'string' ? raw.label : ''
    let setting: PluginSetting
    if (kind === 'number') {
      const bound = (b: YamlValue | undefined, k: string): number | null => {
        if (b === undefined || b === null) return null
        if (typeof b !== 'number' || !Number.isFinite(b)) { err(`${where}の ${k} は数です`); return null }
        return b
      }
      setting = { kind, label, default: raw.default as number, min: bound(raw.min, 'min'), max: bound(raw.max, 'max') }
      if (setting.min !== null && setting.max !== null && setting.min > setting.max) err(`${where}: min が max より大きくなっています`)
    } else if (kind === 'duration') {
      const bound = (b: YamlValue | undefined, k: string): string | null => {
        if (b === undefined || b === null) return null
        if (settingDurationMinutes(b) === null) { err(`${where}の ${k} は 30m・2h・3d のような時間です`); return null }
        return b as string
      }
      setting = { kind, label, default: raw.default as string, min: bound(raw.min, 'min'), max: bound(raw.max, 'max') }
      if (setting.min !== null && setting.max !== null && settingDurationMinutes(setting.min)! > settingDurationMinutes(setting.max)!) err(`${where}: min が max より長くなっています`)
    } else if (kind === 'choice') {
      const options = Array.isArray(raw.options) && raw.options.every(o => typeof o === 'string' && ONTOLOGY_NAME_RE.test(o)) ? raw.options as string[] : null
      if (!options || options.length < 2 || options.length > 50) err(`${where}の options は選べる値の名前の並び（2〜50個）です`)
      else if (new Set(options).size !== options.length) err(`${where}の options に同じ値が2回書かれています`)
      const optionLabels: Record<string, string> = {}
      if (raw.option_labels !== undefined) {
        if (!isYamlMap(raw.option_labels)) err(`${where}の option_labels は「値: 画面に出す名前」の形です`)
        else for (const [o, l] of Object.entries(raw.option_labels)) {
          if (!(options ?? []).includes(o) || typeof l !== 'string') err(`${where}の option_labels の「${o}」は options にある値の名前です`)
          else optionLabels[o] = l
        }
      }
      setting = { kind, label, default: raw.default as string, options: options ?? [], optionLabels }
    } else if (kind === 'boolean') {
      setting = { kind, label, default: raw.default as boolean }
    } else if (kind === 'role') {
      setting = { kind, label, default: raw.default as string }
    } else {
      if (typeof raw.connector_role !== 'string' || !CONNECTOR_ROLE_RE.test(raw.connector_role)) err(`${where}の connector_role は、つなぎ先の役目の名前です（例：mail.send）`)
      setting = { kind: 'connector', label, connectorRole: typeof raw.connector_role === 'string' ? raw.connector_role : '', default: null }
      if (raw.default !== undefined && raw.default !== null) { err(`${where}: つなぎ先は会社が選びます。default は書けません`); continue }
    }
    if (setting.kind !== 'connector') {
      if (raw.default === undefined) { err(`${where}の default（会社が変えないときの値）を書いてください`); continue }
      const problem = settingValueProblem(setting, raw.default, roles)
      if (problem) { err(`${where}の default: ${problem}`); continue }
    }
    settings[name] = setting
  }
  if (Object.keys(settings).length > 50) err('settings は50個までです')
  return settings
}

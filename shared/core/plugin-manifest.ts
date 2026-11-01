/**
 * Reading `plugin.yaml` (`parsePluginManifest`): the keys common to both
 * roles, then a connector's part (`plugin-connector-declaration.ts`) or a
 * business plugin's (`plugin-business-declaration.ts`), chosen by whether it
 * names a `service`. Type-dependent checks are in `plugin-package.ts`.
 */
import { BUSINESS_KEYS, NOT_IN_BUSINESS, parseBusiness } from './plugin-business-declaration'
import { CONNECTOR_KEYS, NOT_IN_CONNECTOR, parseConnector } from './plugin-connector-declaration'
import {
  PLUGIN_CONTRACT, PLUGIN_ID_RE, PLUGIN_VERSION_RE, type PluginKind, type PluginManifest, type PluginParsed, type PluginRole,
} from './plugin-declaration'
import { COMPANY_ID_RE, isStr, strList, unknownKeys } from './plugin-declaration-rules'
import { isYamlMap, parseYamlLite } from './yaml-lite'

const COMMON_KEYS: readonly string[] = ['id', 'label', 'version', 'kind', 'contract', 'description', 'available_to']

/** Parse and validate `plugin.yaml`. Type-dependent checks are in `validatePluginPackage`, a business plugin's use of its connector in `combineUse`. */
export function parsePluginManifest(text: string): PluginParsed<PluginManifest> {
  const yaml = parseYamlLite(text)
  if (!yaml.ok) return { ok: false, errors: [`${yaml.line} 行目: ${yaml.error}`] }
  const raw = yaml.value
  if (!isYamlMap(raw)) return { ok: false, errors: ['宣言は「項目名: 値」の形で書いてください'] }
  const errors: string[] = []
  const err = (m: string) => { if (errors.length < 50) errors.push(m) }
  // One with a service connects; one without owns types (owner decision 2026-11-01).
  const role: PluginRole = raw.service === undefined ? 'business' : 'connector'
  if (role === 'connector') unknownKeys('', raw, [...COMMON_KEYS, ...CONNECTOR_KEYS], err, NOT_IN_CONNECTOR)
  else unknownKeys('', raw, [...COMMON_KEYS, ...BUSINESS_KEYS], err, NOT_IN_BUSINESS)

  const id = raw.id
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id) || id.length > 40) err('id は英小文字・数字・- で書いてください（40文字まで）')
  if (!isStr(raw.label)) err('label（画面に出す名前）を書いてください')
  if (typeof raw.version !== 'string' || !PLUGIN_VERSION_RE.test(raw.version)) err('version は "0.1.0" のように書いてください')
  if (raw.contract !== PLUGIN_CONTRACT) err(`contract が ${String(raw.contract)} です。このサーバーが分かるのは ${PLUGIN_CONTRACT} です`)
  const kind = raw.kind ?? 'official'
  if (kind !== 'official' && kind !== 'company') err('kind は official か company です')
  if (raw.description !== undefined && typeof raw.description !== 'string') err('description は文字で書いてください')

  let availableTo: string[] | null = null
  if (raw.available_to !== undefined) {
    const list = strList(raw.available_to)
    if (!list || list.length === 0 || list.length > 200 || !list.every(c => COMPANY_ID_RE.test(c))) err('available_to は使える会社の id の並び（1〜200件）で書いてください')
    else if (new Set(list).size !== list.length) err('available_to に同じ会社が2回書かれています')
    else availableTo = list
  }
  if (kind === 'company' && availableTo === null) err('kind: company の包みには available_to（使える会社）が要ります')

  const common = {
    id: id as string, label: raw.label as string, version: raw.version as string, kind: kind as PluginKind, contract: PLUGIN_CONTRACT,
    description: typeof raw.description === 'string' ? raw.description : null, availableTo,
  }
  const value = role === 'connector' ? parseConnector(raw, err, common) : parseBusiness(raw, err, common)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

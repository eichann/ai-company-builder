/**
 * The small rules a declaration (and a mapping) is read with: the strict
 * reading helpers, keys that are refused with a specific reason
 * (`FORBIDDEN_KEY_REASONS`), plain-token patterns, type names that carry no
 * layer (owner rule §8-2) and the path template rule of a connector's calls.
 */
import type { PluginEndpointName } from './plugin-declaration'
import { checkUpstreamPath } from './upstream-path'
import type { YamlValue } from './yaml-lite'

/** Endpoints that address one object (`{id}` exactly once); the others take none. */
const ENDPOINTS_WITH_ID: readonly PluginEndpointName[] = ['get', 'update', 'archive']

/** Company ids as the server makes them (UUIDs today); kept loose but plain. */
export const COMPANY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const SCOPE_RE = /^[a-z][a-z0-9._-]{0,99}$/
/** Outside property / association / value names: plain tokens, no paths or expressions. */
export const EXTERNAL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const PATH_TEMPLATE_RE = /^[A-Za-z0-9/_.{}-]{1,300}$/

/**
 * Words that name a layer or an origin. A type name made of several words may
 * not use one (nor the plugin's own id): `pack_deal`, `hubspot_deal` are
 * refused, `deal` and a type simply called `company` are fine (§8-2).
 */
export const TYPE_LAYER_WORDS: readonly string[] = [
  'core', 'base', 'builtin', 'std', 'standard', 'pack', 'industry', 'vertical', 'company', 'custom', 'tenant',
  'org', 'local', 'official', 'plugin', 'ext', 'external', 'acb',
]

/** Keys someone might reach for to put a program, a destination, a key or approval rights into a declaration. */
const FORBIDDEN_KEY_REASONS: Record<string, string> = {
  script: 'プログラムは書けません', scripts: 'プログラムは書けません', code: 'プログラムは書けません', program: 'プログラムは書けません',
  command: 'プログラムを起動する項目は書けません', commands: 'プログラムを起動する項目は書けません', exec: 'プログラムを起動する項目は書けません',
  run: 'プログラムを起動する項目は書けません', start: 'プログラムを起動する項目は書けません', tools: 'プログラムを起動する項目は書けません',
  hooks: 'プログラムを起動する項目は書けません', expression: '式は書けません', formula: '式は書けません', when: '条件は書けません', if: '条件は書けません',
  url: '送り先は base_url だけです', host: '送り先は base_url だけです', hosts: '送り先は base_url だけです', redirect: '送り先は base_url だけです',
  key: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）', api_key: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）',
  token: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）', secret: '鍵の値は書けません（鍵は「API キー」の金庫に入れます）',
  approve: '承認する権限は書けません', approver: '承認する権限は書けません', approvers: '承認する権限は書けません',
}

export const isStr = (v: YamlValue | undefined): v is string => typeof v === 'string' && v.trim() !== ''
export const strList = (v: YamlValue | undefined): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null

export function unknownKeys(where: string, obj: { [k: string]: YamlValue }, allowed: readonly string[], err: (m: string) => void, reasons: Record<string, string> = {}): void {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue
    const why = reasons[k] ?? FORBIDDEN_KEY_REASONS[k.toLowerCase()]
    err(why ? `${where}「${k}」: ${why}` : `${where}知らない項目「${k}」があります`)
  }
}

/** Why a type name carries its layer, or null when it is fine (§8-2). */
export function typeNameLayerProblem(name: string, pluginId?: string): string | null {
  const words = name.split('_').filter(Boolean)
  const own = pluginId ? pluginId.replace(/-/g, '_').split('_') : []
  if (pluginId && (name === pluginId.replace(/-/g, '_') || (words.length > 1 && own.some(w => words.includes(w))))) {
    return `型の名前「${name}」にプラグインの名前を入れないでください（例：deal）`
  }
  if (words.length > 1 && words.some(w => TYPE_LAYER_WORDS.includes(w))) {
    return `型の名前「${name}」に置き場所（本体・業種のパック・会社など）を表す言葉を入れないでください（例：deal）`
  }
  return null
}

/** A path template: under the relay's path rule, `{id}` the only placeholder (exactly once where one object is addressed). */
export function checkPluginPathTemplate(path: unknown, endpoint: PluginEndpointName): string | null {
  if (typeof path !== 'string' || !PATH_TEMPLATE_RE.test(path)) return '道は / で始まる英数字・/ _ . - と {id} だけで書いてください（? や # は使えません）'
  const placeholders = path.match(/\{[^}]*\}/g) ?? []
  if (/[{}]/.test(path.replace(/\{id\}/g, ''))) return '道に書ける差し込みは {id} だけです'
  const wantsId = ENDPOINTS_WITH_ID.includes(endpoint)
  if (wantsId && placeholders.length !== 1) return `${endpoint} の道には {id} をちょうど1つ書いてください`
  if (!wantsId && placeholders.length !== 0) return `${endpoint} の道に {id} は書けません`
  if (!checkUpstreamPath(path.replace('{id}', '1'))) return '道の書き方が正しくありません（//・..・%2f などは使えません）'
  return null
}

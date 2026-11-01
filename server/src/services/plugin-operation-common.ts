/**
 * What every part of the typed operations shares (plugins.md "Typed
 * operations"): the words shown for an undo / a recreate, the actor of a run,
 * the answer's shape, the refusals several parts give, the per-object
 * serialisation, and small value helpers. The service is composed in
 * `plugin-operations.ts`.
 */
import type { AcbValue, ExternalProperties } from '../../shared/core/plugins'
import type { PluginOperationRecordView } from '../../shared/types/plugins'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import { refuse } from './outcome'
import type { PluginConnector } from './plugin-connector'
import type { PluginImportService } from './plugin-import'
import type { PluginService } from './plugins'
import type { ExternalRecordWriter } from './record-engine'
import { RECORD_NOT_FOUND } from './records'

/** The words for an undo, on the screens and to the AI (review §5.4 / §6.4). */
export const UNDO_LABEL = '変更前の値を書き戻す'
export const UNDO_NOTICE = 'HubSpot のワークフローや通知など、変更のあとに HubSpot 側で起きたことは元に戻りません。'
/** The undo of a create: an archive (HubSpot's recycling bin). */
export const CREATE_UNDO_LABEL = '作ったものを取り消す'
export const CREATE_UNDO_NOTICE = 'HubSpot のごみ箱に移します。作ったあとに HubSpot 側で起きたこと（ワークフローや通知など）は元に戻りません。'
/** What a person confirms before 「もう一度作る」 (design §4-4). */
export const RECREATE_WARNING = 'HubSpot で見つからなかったため、もう一度作ります。前に送ったものがあとから HubSpot に現れると、二つになることがあります。HubSpot の画面で無いことを確かめてから押してください。'
/** A create looked up by search only this long after it was sent (HubSpot's search does not see a new object at once). */
export const CREATE_SEARCH_DELAY_MS = 60_000

export interface OperationActor {
  kind: 'human' | 'ai'
  /** For the AI: the agent of its token. */
  source?: string
  conversationId?: string | null
  /** A person confirming what their AI suggested (informational, self-reported by the app; records.md "Provenance"). */
  proposedBy?: 'ai' | null
  /** For the AI: the execution run its token is bound to (S10b; from the token). */
  runId?: string | null
}

/** An operation record as its record's readers see it (contract: shared/types/plugins.ts). */
export type OperationView = PluginOperationRecordView

export type RecordRef = { id: string; version: number }
export type RunAnswer = { operation: OperationView | null; record: RecordRef | null }

export interface PluginOperationDeps {
  companyData: CompanyDataSource
  clock: Clock
  ids: IdGenerator
  plugins: PluginService
  connector: PluginConnector
  writer: ExternalRecordWriter
  importer: PluginImportService
  roleOf: (companyId: string, userId: string) => string | null
  managedFolders: (companyId: string, userId: string) => string[]
  /** The company's whole AI is stopped (M2). */
  aiStopped: (companyId: string) => boolean
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const conflict = (error: string, code: string, extra: Record<string, unknown> = {}) => refuse('conflict', error, { code, ...extra })
export const notFound = () => refuse('not-found', RECORD_NOT_FOUND.error, { code: RECORD_NOT_FOUND.code })
export const opNotFound = () => refuse('not-found', 'その操作はありません', { code: 'OPERATION_RECORD_NOT_FOUND' })
export const notActive = (problem: string) => conflict('いまは HubSpot とつながっていません（止められているか、設定が足りません）', 'PLUGIN_NOT_ACTIVE', { problem })
export const approvalRequired = (fields?: string[]) => conflict(
  fields ? `承認が必要な欄のため、変えていません：${fields.join('、')}（ほかの欄も変えていません。承認を頼んでください）` : 'この操作は承認が必要です。承認されるまで何も送っていません',
  'APPROVAL_REQUIRED', fields ? { fields } : {})
export const operationOff = () => refuse('bad-request', 'この操作はいまは使わない設定です（何も送っていません）', { code: 'OPERATION_OFF' })

/** The plugin's `who` in the engine's words (`viewer` is anyone who reaches the record: it was read-checked first). */
export const engineWho = (who: string[]) => who.map(w => (w === 'viewer' ? 'anyone' : w))

/** The ISO time of an epoch-milliseconds outside value (`at` slot), or the raw value. */
export const isoOf = (raw: string) => (/^\d{1,15}$/.test(raw) ? new Date(Number(raw)).toISOString() : raw)

/** The raw outside values of `names` (absent / null → ''). */
export const rawOf = (props: ExternalProperties, names: string[]) =>
  Object.fromEntries(names.map(n => [n, props[n] === undefined || props[n] === null ? '' : String(props[n])]))
export const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).every(k => (a[k] ?? '') === (b[k] ?? ''))

/** ACB values without the record's title / summary (those are not fields of a created record). */
export function stripTitle(values: Record<string, AcbValue>): Record<string, AcbValue> {
  const { title: _t, summary: _s, ...rest } = values
  void _t; void _s
  return rest
}

/**
 * One write (or undo) per outside object at a time inside this server (review
 * §5.5). One serialiser is shared by every part of the service: a run, an
 * undo and an approved write on the same object wait for each other.
 */
export function createSerialiser() {
  const locks = new Map<string, Promise<unknown>>()
  return async function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = locks.get(key) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(run)
    locks.set(key, mine)
    try { return await mine } finally { if (locks.get(key) === mine) locks.delete(key) }
  }
}
export type Serialised = ReturnType<typeof createSerialiser>

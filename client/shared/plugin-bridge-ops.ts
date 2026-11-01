/**
 * The calls a plugin's screen may make on its bridge, as the app reads them
 * (stage 4b A5, `.claude/rules/plugin-frame.md`): the server's ops
 * (`shared/types/plugin-bridge.ts` `PLUGIN_BRIDGE_OPS`, B6) plus `ui.open`,
 * which the core screen handles itself and never sends. Each op's arguments
 * have exactly the keys the server takes, so a frame cannot slip in anything
 * the list does not name (an actor, provenance, attachments, another plugin);
 * deeper rules (types, `via`, the person's rights) are the server's. Pure;
 * used by the renderer's bridge host and again by main before sending.
 */
import { RECORD_ID_RE } from '../../shared/core/records'
import { PLUGIN_BRIDGE_OPS, PLUGIN_BRIDGE_VERSION, type PluginBridgeOp } from '../../shared/types/plugin-bridge'

/** The bridge versions this app speaks (`ui.bridge` in the declaration). */
export const APP_BRIDGE_VERSION = PLUGIN_BRIDGE_VERSION

/** Handled by the core app's screen (opens what the person may open there); never sent to the server. */
export const BRIDGE_LOCAL_OPS = ['ui.open'] as const
export type BridgeLocalOp = typeof BRIDGE_LOCAL_OPS[number]
/** Every op a frame may call: the server's and the local ones. */
export const BRIDGE_OPS: readonly string[] = [...PLUGIN_BRIDGE_OPS, ...BRIDGE_LOCAL_OPS]

/** `ui.open`: open something in the core app (only what the person may open there). */
export type BridgeUiOpenArgs =
  | { target: 'record'; recordId: string }
  | { target: 'file'; path: string }
  | { target: 'consultation'; recordId: string }

/** A call after its arguments were read: a server op with its args, or `ui.open`. */
export type BridgeCall =
  | { op: PluginBridgeOp; args: Record<string, unknown> }
  | { op: 'ui.open'; args: BridgeUiOpenArgs }

/** What a call answers (main → renderer → frame, with the frame's `id` added). */
export type PluginBridgeAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } }

/** Codes the app itself answers with (the server's own codes, `PLUGIN_BRIDGE_REFUSED` first, pass through). */
export const BRIDGE_ERROR = {
  badRequest: 'BAD_REQUEST',
  unknownOp: 'UNKNOWN_OP',
  busy: 'BUSY',
  notAvailable: 'NOT_AVAILABLE',
  offline: 'OFFLINE',
  failed: 'FAILED',
} as const

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_TEXT = 2000
const MAX_PATH = 1000
/** Arguments of one call, as JSON. */
export const MAX_BRIDGE_ARGS_CHARS = 64_000

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
type FieldValue = string | number | boolean | null

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v)
const isRecordId = (v: unknown): v is string => typeof v === 'string' && RECORD_ID_RE.test(v)
const extraKeys = (o: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(o).filter(k => !allowed.includes(k))
  return extra.length > 0 ? `unknown keys: ${extra.slice(0, 5).join(', ')}` : null
}
const isFieldValue = (v: unknown): v is FieldValue => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
/** A company path as the person sees it: relative, `/`-separated, no `.` / `..` segments. */
const isCompanyPath = (p: unknown): p is string =>
  str(p, MAX_PATH) && !/[\0\\]/.test(p) && !p.startsWith('/') && p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
const fieldValues = (v: unknown): boolean =>
  isObj(v) && Object.keys(v).length <= 100 && Object.entries(v).every(([k, x]) => NAME_RE.test(k) && isFieldValue(x))
const linkValues = (v: unknown): boolean =>
  isObj(v) && Object.keys(v).length <= 50 && Object.entries(v).every(([k, x]) => NAME_RE.test(k) &&
    (x === null || isRecordId(x) || (Array.isArray(x) && x.length <= 200 && x.every(isRecordId))))

/** Each server op's keys (B6's `PluginBridgeRequest` args) and the check of each value the app can make. */
const SERVER_ARGS: Record<PluginBridgeOp, { required: readonly string[]; checks: Record<string, (v: unknown) => boolean> }> = {
  'records.query': {
    required: ['type'],
    checks: {
      type: isName,
      state: v => Array.isArray(v) && v.length <= 50 && v.every(isName),
      // The value shapes of `fields` are the records query's (the server checks them); here only the names.
      fields: v => isObj(v) && Object.keys(v).length <= 50 && Object.keys(v).every(k => NAME_RE.test(k)),
      linkedTo: v => isObj(v) && !extraKeys(v, ['id', 'hops']) && isRecordId(v.id) && (v.hops === undefined || v.hops === 1 || v.hops === 2),
      link: v => isObj(v) && !extraKeys(v, ['name', 'id']) && isName(v.name) && isRecordId(v.id),
      sort: v => isObj(v) && !extraKeys(v, ['field', 'order']) && isName(v.field) && (v.order === undefined || v.order === 'asc' || v.order === 'desc'),
      text: v => str(v, 200),
      limit: v => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 200,
      offset: v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000,
      countOnly: v => typeof v === 'boolean',
    },
  },
  'records.get': { required: ['recordId'], checks: { recordId: isRecordId } },
  'records.act': {
    required: ['recordId', 'action', 'expectedVersion'],
    checks: {
      recordId: isRecordId,
      action: isName,
      expectedVersion: v => Number.isInteger(v) && (v as number) >= 0,
      note: v => str(v, MAX_TEXT),
      args: fieldValues,
      links: linkValues,
      // An action marked `decision`: what it rests on (references; the server checks the shape).
      decision: isObj,
    },
  },
  'approvals.request': {
    required: ['recordId', 'operation', 'input'],
    checks: {
      recordId: v => v === null || isRecordId(v),
      operation: isName,
      // The operation's own body (`{ expectedVersion, fields, note?, basis? }`, or a create's).
      input: isObj,
    },
  },
}

function uiOpenArgs(a: Record<string, unknown>): Parsed<BridgeUiOpenArgs> {
  if (a.target === 'record' || a.target === 'consultation') {
    const extra = extraKeys(a, ['target', 'recordId'])
    if (extra) return { ok: false, error: extra }
    if (!isRecordId(a.recordId)) return { ok: false, error: 'recordId' }
    return { ok: true, value: { target: a.target, recordId: a.recordId } }
  }
  if (a.target === 'file') {
    const extra = extraKeys(a, ['target', 'path'])
    if (extra) return { ok: false, error: extra }
    if (!isCompanyPath(a.path)) return { ok: false, error: 'path' }
    return { ok: true, value: { target: 'file', path: a.path } }
  }
  return { ok: false, error: 'target' }
}

/** Read one call's op and arguments; `error` is `unknown op` for an op the bridge does not have. */
export function parseBridgeCall(op: unknown, args: unknown): Parsed<BridgeCall> {
  if (typeof op !== 'string' || !BRIDGE_OPS.includes(op)) return { ok: false, error: 'unknown op' }
  const a = args === undefined ? {} : args
  if (!isObj(a)) return { ok: false, error: 'args must be an object' }
  let size = 0
  try { size = JSON.stringify(a).length } catch { return { ok: false, error: 'args must be JSON' } }
  if (size > MAX_BRIDGE_ARGS_CHARS) return { ok: false, error: 'args too large' }
  if (op === 'ui.open') {
    const ui = uiOpenArgs(a)
    return ui.ok ? { ok: true, value: { op: 'ui.open', args: ui.value } } : ui
  }
  const shape = SERVER_ARGS[op as PluginBridgeOp]
  const extra = extraKeys(a, Object.keys(shape.checks))
  if (extra) return { ok: false, error: extra }
  for (const key of shape.required) if (!(key in a)) return { ok: false, error: key }
  for (const [key, value] of Object.entries(a)) if (!shape.checks[key](value)) return { ok: false, error: key }
  return { ok: true, value: { op: op as PluginBridgeOp, args: a } }
}

/** True for an op the core screen handles itself. */
export const isLocalBridgeOp = (op: string): op is BridgeLocalOp => (BRIDGE_LOCAL_OPS as readonly string[]).includes(op)

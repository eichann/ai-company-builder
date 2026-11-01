/**
 * A business plugin's screen in the app (stage 4b, plan A5,
 * `.claude/rules/plugin-frame.md`): the `acb-plugin://` addresses, the
 * frame's content security policy, which navigations a frame may make, and
 * the envelope of the bridge's messages. Pure; used by main (the protocol,
 * the window's navigation guard, the bridge's IPC) and the renderer (the
 * frame and its bridge host).
 *
 * Address: `acb-plugin://<plugin id>/<version>/ui/<file>`. The version is the
 * first path segment, not `<id>@<version>` in the host: `@` in an address's
 * authority is the URL's user-info (`acb-plugin://a@1.2.3/` has host `1.2.3`),
 * and a dotted-number host is read as an IPv4 address. Only files under `ui/`
 * of a verified package are served (`electron/features/plugins/protocol.ts`).
 */
import { isPluginPackagePath, PLUGIN_PACKAGE_DIR_RE } from '../../shared/core/plugin-package-paths'
import { APP_BRIDGE_VERSION, BRIDGE_ERROR, parseBridgeCall, type BridgeCall, type PluginBridgeAnswer } from './plugin-bridge-ops'

export const PLUGIN_SCHEME = 'acb-plugin'
const PREFIX = `${PLUGIN_SCHEME}://`

export interface PluginPackageRef {
  id: string
  version: string
}

export interface PluginFileAddress extends PluginPackageRef {
  /** The package path (`ui/…`). */
  path: string
}

const isRef = (ref: PluginPackageRef): boolean => typeof ref.id === 'string' && typeof ref.version === 'string' && PLUGIN_PACKAGE_DIR_RE.test(`${ref.id}@${ref.version}`)

/** The frame's address of a package's `ui/` file; null for anything a package's screen cannot be. */
export function pluginFrameUrl(ref: PluginPackageRef, entry: string): string | null {
  if (!isRef(ref) || !entry.startsWith('ui/') || !isPluginPackagePath(entry)) return null
  return `${PREFIX}${ref.id}/${ref.version}/${entry}`
}

/** The base every file of the package's screen is under (the CSP's only source). */
export const pluginUiBase = (ref: PluginPackageRef): string => `${PREFIX}${ref.id}/${ref.version}/ui/`

/**
 * Read an `acb-plugin://` address: the package and the `ui/` file, or null.
 * Query and fragment are ignored. Refused: any `%` escape or `\` (a package
 * path never needs one, so `%2e%2e` or `%2f` cannot smuggle a step out), a
 * user-info or port, and any path that is not a `ui/` file a package may hold
 * — `plugin.yaml`, `steps/`, `types/` are never served to a frame.
 */
export function parsePluginFrameUrl(url: string): PluginFileAddress | null {
  if (typeof url !== 'string' || !url.startsWith(PREFIX) || url.length > 600) return null
  const rest = url.slice(PREFIX.length).split(/[?#]/)[0]
  if (/[%\\@:\s]/.test(rest)) return null
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const id = rest.slice(0, slash)
  const segments = rest.slice(slash + 1).split('/')
  const version = segments.shift() ?? ''
  if (!isRef({ id, version })) return null
  const path = segments.join('/')
  if (!path.startsWith('ui/') || !isPluginPackagePath(path)) return null
  return { id, version, path }
}

/** True for any `acb-plugin:` address (well formed or not). */
export const isPluginAddress = (url: string | undefined | null): boolean => typeof url === 'string' && url.toLowerCase().startsWith(`${PLUGIN_SCHEME}:`)

/**
 * The content security policy of every answer `acb-plugin://` gives: nothing
 * from the network, ever (`default-src 'none'`, no `connect-src`: fetch, XHR,
 * WebSocket, EventSource and beacons are all refused), scripts, styles, images
 * and fonts only from this package version's `ui/` (another version or another
 * plugin is refused too), no frames, forms, `<base>`, plugins or workers.
 * Inline styles are allowed (screens are built with them); inline scripts are
 * not. Checked in Chromium by `tests/ui/plugin-frame.spec.ts`.
 */
export function pluginFrameCsp(base: string): string {
  return [
    "default-src 'none'",
    `script-src ${base}`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data:`,
    `font-src ${base}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/**
 * Whether a frame may navigate (`will-frame-navigate`). A frame showing a
 * plugin's page navigates nowhere — not to another page of its own package
 * either (it was handed its bridge once; the core app shows another page in a
 * new frame). A frame of the app's own page (empty, `about:blank`) may load a
 * plugin's page; other frames (the PDF preview) are not this rule's.
 */
export function pluginFrameNavigationAllowed(frameUrl: string | undefined | null, targetUrl: string): boolean {
  if (isPluginAddress(frameUrl)) return false
  if (isPluginAddress(targetUrl)) return parsePluginFrameUrl(targetUrl) !== null
  return true
}

// ---------------------------------------------------------------------------
// The bridge's envelope (frame ⇄ core app over the one MessagePort)

/**
 * Where a frame is shown and what it is about (A6, the four slots), handed in
 * the hello: a record section gets only the record's id (it reads the record
 * with `records.get`), a file action only the chosen company path. Nothing
 * else of the core screen reaches the frame.
 */
export type BridgeFrameContext =
  | { slot: 'tab' }
  | { slot: 'record_section'; recordId: string }
  | { slot: 'file_action'; path: string; isFolder: boolean }

/** The message the core app posts to the frame once, with the port. */
export const BRIDGE_HELLO_TYPE = 'acb-bridge'
export interface BridgeHello { type: typeof BRIDGE_HELLO_TYPE; bridge: number; context?: BridgeFrameContext }
export const bridgeHello = (context?: BridgeFrameContext): BridgeHello =>
  ({ type: BRIDGE_HELLO_TYPE, bridge: APP_BRIDGE_VERSION, ...(context ? { context } : {}) })

/** The caller's id of a call (echoed in the answer). */
export type BridgeCallId = string | number
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export type BridgeEnvelope =
  | { ok: true; id: BridgeCallId; call: BridgeCall }
  /** `id` null: the message had no usable id, so it gets no answer. */
  | { ok: false; id: BridgeCallId | null; code: string; message: string }

/** A frame's answer: the call's id and what main (or the host) answered. */
export type BridgeReply = { id: BridgeCallId } & PluginBridgeAnswer

/**
 * Read one message from the frame: `{ id, op, args }` and nothing else, the
 * op one of bridge 1's, the arguments exactly its shape
 * (`parseBridgeCall`, `plugin-bridge-ops.ts`).
 */
export function parseBridgeMessage(data: unknown): BridgeEnvelope {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, id: null, code: BRIDGE_ERROR.badRequest, message: 'message must be { id, op, args }' }
  const m = data as Record<string, unknown>
  const id = m.id
  const usableId = (typeof id === 'string' && ID_RE.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id)) ? id : null
  if (usableId === null) return { ok: false, id: null, code: BRIDGE_ERROR.badRequest, message: 'id' }
  const extra = Object.keys(m).filter(k => k !== 'id' && k !== 'op' && k !== 'args')
  if (extra.length > 0) return { ok: false, id: usableId, code: BRIDGE_ERROR.badRequest, message: `unknown keys: ${extra.slice(0, 5).join(', ')}` }
  const parsed = parseBridgeCall(m.op, m.args)
  if (!parsed.ok) {
    return { ok: false, id: usableId, code: parsed.error === 'unknown op' ? BRIDGE_ERROR.unknownOp : BRIDGE_ERROR.badRequest, message: parsed.error }
  }
  return { ok: true, id: usableId, call: parsed.value }
}

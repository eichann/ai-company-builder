// This PC's registration for 「ブラウザ操作」, the app's half (agent-browser.md "This PC's registration"; design memo
// 「ブラウザ操作を担当者の PC で使う」 v2 §3-2, §7-1, §8-2; the server's half is D2).
//
// - **The key**: 32 random bytes made the first time the member registers this PC, kept **only encrypted** by the OS
//   keychain (`SecretBox`: Electron's safeStorage, handed in by main.ts — features never import Electron) in
//   `<userData>/browser-device-key`. It is sent only as `X-ACB-Browser-Device: v1.<base64url>` (the server keeps its
//   sha256): by this module's own calls to the PC routes, and by the plan clients (plans-api.ts, lines-api.ts) on the
//   steps the server's gate asks (create, approve, claim, permit). Never in an IPC answer, a log, a URL, a body or a
//   company folder. No keychain → the PC cannot be registered (plain sentence on the screen); a key that cannot be read
//   back (another computer, a reset keychain) counts as none, and registering makes a new one (a new registration).
// - **The remembered state** (synchronous, for the switch: ai-switch.ts `createRegisteredPcSwitch`): per server ×
//   member × company, what `GET /browser-devices-me` last said. Asked again when the settings open, after the member's
//   press, and when the company's policy is answered (start, push, the periodic check; at most once a minute per
//   company). The server stays the authority: a stale `enabled` here is refused there.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_DEVICE_HEADER, BROWSER_DEVICE_STATES, normalizeBrowserDeviceLabel, parseBrowserDeviceKey, BROWSER_DEVICE_WORDS, type BrowserDeviceState } from '../../../../shared/core/browser-device'
import { BROWSER_COMPANY_ID_RE } from '../../../shared/browser-plans'
import { BROWSER_PC_WORDS, type BrowserPcResult, type BrowserPcView } from '../../../shared/browser-device'
import type { SecretBox } from '../../services/api-key-store'

export const BROWSER_DEVICE_KEY_FILE = 'browser-device-key'
/** The sealed key is small; anything larger is not ours. */
const SEALED_MAX_BYTES = 4096

/** The key as only main holds it. `header()` is the one way out (the plan clients and this module's calls). */
export interface BrowserDeviceKey {
  /** The header value, or null when this PC has no readable key (synchronous: read once, then kept in memory). */
  header(): string | null
  /** The key, made and saved (encrypted) when there is none; null when the keychain cannot keep it. */
  ensure(): string | null
  /** Whether the OS keychain can keep a key on this PC. */
  available(): boolean
}

/** 32 random bytes as `v1.` + unpadded base64url (its last character's unused bits are zero: the server's one spelling). */
export function newBrowserDeviceKey(random: (n: number) => Buffer = crypto.randomBytes): string {
  return `v1.${random(32).toString('base64url')}`
}

export function createBrowserDeviceKey(deps: { box: SecretBox; file: () => string; random?: (n: number) => Buffer; log?: (message: string) => void }): BrowserDeviceKey {
  let held: string | null = null
  const log = deps.log ?? (() => {})

  function read(): string | null {
    if (held) return held
    if (!deps.box.available()) return null
    try {
      // A link is never followed; only a small regular file counts.
      const fd = fs.openSync(deps.file(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      let sealed: Buffer
      try {
        const st = fs.fstatSync(fd)
        if (!st.isFile() || st.size > SEALED_MAX_BYTES) return null
        sealed = fs.readFileSync(fd)
      } finally { fs.closeSync(fd) }
      const key = parseBrowserDeviceKey(deps.box.decrypt(sealed))
      if (key) held = key
      return key
    } catch {
      // None yet, or unreadable (another computer, a reset keychain): this PC is not registered.
      return null
    }
  }

  return {
    header: read,
    available: () => deps.box.available(),
    ensure() {
      const existing = read()
      if (existing) return existing
      if (!deps.box.available()) return null
      const key = newBrowserDeviceKey(deps.random)
      if (!parseBrowserDeviceKey(key)) return null
      try {
        const file = deps.file()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, deps.box.encrypt(key), { mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch {
        log('[browser-device] the PC key could not be saved')
        return null
      }
      held = key
      return key
    },
  }
}

/** One answer from the server (the plan clients' three kinds). */
type Answer = { kind: 'ok'; value: unknown } | { kind: 'refused'; code: string | null; error: string | null } | { kind: 'no-answer' }

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const REFRESH_EVERY_MS = 60_000

export interface BrowserDeviceDeps {
  key: BrowserDeviceKey
  baseUrl: () => string
  cookies: () => string[]
  userId: () => string | null
  /** This computer's name (the 「登録する」 field's first value). */
  computerName: () => string
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

export interface BrowserDevice {
  /** The screen's view: this PC's state in that company and the member's usable combinations (asks the server). */
  view(companyId: string): Promise<BrowserPcView>
  register(companyId: string, label: unknown): Promise<BrowserPcResult>
  withdraw(companyId: string): Promise<BrowserPcResult>
  /** Ask the server again (the policy answered); at most once a minute per company, and only once this PC has a key. */
  refresh(companyId: string): void
  /** Synchronous: this PC is `enabled` for the signed-in member on this server, in some company. */
  enabledHere(): boolean
  /** Signed out: forget every remembered state. */
  clear(): void
}

export function createBrowserDevice(deps: BrowserDeviceDeps): BrowserDevice {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  /** server \n member \n company → the state the server last said. */
  const remembered = new Map<string, BrowserDeviceState | 'none'>()
  const askedAt = new Map<string, number>()

  const base = () => deps.baseUrl().replace(/\/+$/, '')
  const scope = (companyId: string): string | null => {
    const user = deps.userId()
    const server = base()
    return user && server ? `${server}\n${user}\n${companyId}` : null
  }

  async function call(method: 'GET' | 'POST' | 'DELETE', companyId: string, route: string, opts: { key?: string; body?: unknown } = {}): Promise<Answer> {
    const server = base()
    const cookies = deps.cookies()
    if (!server || cookies.length === 0 || !BROWSER_COMPANY_ID_RE.test(companyId)) return { kind: 'no-answer' }
    const headers: Record<string, string> = { Cookie: cookies.join('; ') }
    if (opts.key !== undefined) headers[BROWSER_DEVICE_HEADER] = opts.key
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const res = await doFetch(`${server}/api/companies/${companyId}${route}`, {
        method, redirect: 'error', cache: 'no-store', headers, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (res.status >= 200 && res.status < 300 && json && json.data !== undefined) return { kind: 'ok', value: json.data }
      if (res.status >= 400 && res.status < 500) {
        return {
          kind: 'refused',
          code: typeof json?.code === 'string' && CODE_RE.test(json.code) ? json.code : null,
          error: typeof json?.error === 'string' && json.error.length <= 300 ? json.error : null,
        }
      }
      return { kind: 'no-answer' }
    } catch {
      return { kind: 'no-answer' }
    }
  }

  /** The registration's state and name from the server's answer (nothing else of it is kept or passed on). */
  function mineOf(value: unknown): { state: BrowserDeviceState | 'none'; label: string | null } | null {
    if (!value || typeof value !== 'object') return null
    const v = value as { state?: unknown; label?: unknown }
    if (v.state === 'none') return { state: 'none', label: null }
    if (!(BROWSER_DEVICE_STATES as readonly unknown[]).includes(v.state)) return null
    return { state: v.state as BrowserDeviceState, label: typeof v.label === 'string' ? v.label : null }
  }

  function remember(companyId: string, state: BrowserDeviceState | 'none'): void {
    const k = scope(companyId)
    if (k) remembered.set(k, state)
  }

  async function lines(companyId: string): Promise<BrowserPcView['lines']> {
    const r = await call('GET', companyId, '/browser-lines-mine')
    if (r.kind !== 'ok' || !r.value || typeof r.value !== 'object') return []
    const list = (r.value as { lines?: unknown }).lines
    if (!Array.isArray(list)) return []
    return list.flatMap(l => l && typeof l === 'object' && typeof (l as { label?: unknown }).label === 'string'
      ? [{ label: (l as { label: string }).label, writes: (l as { writes?: unknown }).writes === true }] : [])
  }

  const suggestedLabel = () => normalizeBrowserDeviceLabel(deps.computerName().replace(/\.local$/i, '')) ?? 'この PC'

  /** This PC's state for the member in that company (none without a key: there can be no registration of it). */
  async function mine(companyId: string): Promise<{ state: BrowserPcView['state']; label: string | null }> {
    if (!deps.key.available()) return { state: 'unavailable', label: null }
    const key = deps.key.header()
    if (!key) { remember(companyId, 'none'); return { state: 'none', label: null } }
    const r = await call('GET', companyId, '/browser-devices-me', { key })
    const m = r.kind === 'ok' ? mineOf(r.value) : null
    if (!m) return { state: 'unknown', label: null }
    remember(companyId, m.state)
    return m
  }

  async function view(companyId: string): Promise<BrowserPcView> {
    const [m, l] = await Promise.all([mine(companyId), lines(companyId)])
    return { state: m.state, label: m.label, suggestedLabel: suggestedLabel(), lines: l }
  }

  /** A refusal's plain sentence: the server's own when it gave one (released words), else ours. */
  const refusalText = (r: Answer): string => {
    if (r.kind === 'refused') {
      const words = BROWSER_DEVICE_WORDS as unknown as { refusals: Record<string, string> }
      if (r.code && words.refusals[r.code]) return words.refusals[r.code]
      if (r.error) return r.error
    }
    return BROWSER_PC_WORDS.failed
  }

  return {
    view,
    async register(companyId, label) {
      const name = normalizeBrowserDeviceLabel(label)
      if (!name) return { ok: false, message: BROWSER_DEVICE_WORDS.badLabel }
      if (!deps.key.available()) return { ok: false, message: BROWSER_PC_WORDS.unavailable }
      const key = deps.key.ensure()
      if (!key) return { ok: false, message: BROWSER_PC_WORDS.unavailable }
      const r = await call('POST', companyId, '/browser-devices', { key, body: { label: name } })
      if (r.kind !== 'ok') return { ok: false, message: refusalText(r) }
      return { ok: true, view: await view(companyId) }
    },
    async withdraw(companyId) {
      const key = deps.key.header()
      if (!key) return { ok: true, view: await view(companyId) }
      const r = await call('DELETE', companyId, '/browser-devices-me', { key })
      if (r.kind !== 'ok') return { ok: false, message: refusalText(r) }
      return { ok: true, view: await view(companyId) }
    },
    refresh(companyId) {
      const k = scope(companyId)
      if (!k || !BROWSER_COMPANY_ID_RE.test(companyId) || !deps.key.header()) return
      const last = askedAt.get(k)
      if (last !== undefined && now() - last < REFRESH_EVERY_MS) return
      askedAt.set(k, now())
      void mine(companyId).catch(() => undefined)
    },
    enabledHere() {
      const user = deps.userId()
      const server = base()
      if (!user || !server) return false
      const prefix = `${server}\n${user}\n`
      for (const [k, state] of remembered) if (state === 'enabled' && k.startsWith(prefix)) return true
      return false
    },
    clear() {
      remembered.clear()
      askedAt.clear()
    },
  }
}

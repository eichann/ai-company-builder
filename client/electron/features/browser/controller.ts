// 「ブラウザ操作」 in the app (agent-browser.md "The app's window"): which sites the member may open
// now, the windows open, and when a window closes and its login is cleared. No Electron: the shell's
// window (electron/browser-window.ts) comes in as `BrowserShell`.
//
// - Only a valid policy answer opens anything: no answer, an error or an answer that does not
//   validate = off until the next valid one (`policyFailed` closes the company's windows).
// - A valid answer that drops a site or turns the mode off closes its window and clears its login;
//   one whose sandbox left 「囲う」 closes the windows keeping a login on disk and clears every login
//   kept on disk for that company.
// - Signing out clears every login; signing in as another account clears the others' kept logins.
import { createHash } from 'node:crypto'
import { browserLoginStorage, type BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import type { AgentSandboxMode } from '../../../../shared/core/agent-sandbox'
import type { AgentPolicy } from '../../../../shared/types/agent-sandbox'
import { BROWSER_WORDS, type BrowserActionResult, type BrowserSitesResult } from '../../../shared/browser-operation'
import type { KeptLogins } from './logins'

export type LoginStorage = 'disk' | 'memory'

export interface BrowserWindowSpec {
  partition: string
  site: BrowserSiteSetting
  /** The window is gone (closed by the member or by the app). */
  onClosed: () => void
}

export interface BrowserWindowHandle {
  focus(): void
  close(): void
  /** The site's setting changed (its asset hosts): the request rule reads the new one at once. */
  updateSite(site: BrowserSiteSetting): void
}

/** What the shell provides (electron/browser-window.ts). */
export interface BrowserShell {
  open(spec: BrowserWindowSpec): BrowserWindowHandle
  /** Cookies, storage, caches and service workers of that partition. */
  clearPartition(partition: string): Promise<void>
}

export interface BrowserState {
  /** The sites the member may open (empty: off). */
  sites: BrowserSiteSetting[]
  storage: LoginStorage
}

/**
 * Where a login is kept: on disk only when the member's sandbox is 「囲う」 (`browserLoginStorage`)
 * and really runs here — on a platform the sandbox supports, with an agent that takes it (an agent
 * without one runs `enforce` as observe: its commands could read the app's data).
 */
export function loginStorageFor(mode: AgentSandboxMode, here: { platformSandbox: boolean; agentSandbox: boolean }): LoginStorage {
  return browserLoginStorage(mode) === 'disk' && here.platformSandbox && here.agentSandbox ? 'disk' : 'memory'
}

/** The member's browser state from a valid policy answer (absent / off `browser` = no sites). */
export function browserStateOf(policy: AgentPolicy, storageFor: (mode: AgentSandboxMode) => LoginStorage): BrowserState {
  const browser = policy.browser
  return { sites: browser?.mode === 'on' ? browser.sites : [], storage: storageFor(policy.sandbox.mode) }
}

/**
 * The window's session: one per account × company × site, `persist:` only when the login is kept
 * on disk (a partition without it lives in memory and is gone when the app quits).
 */
export function browserPartition(userId: string, companyId: string, host: string, storage: LoginStorage): string {
  const hash = createHash('sha256').update(JSON.stringify([userId, companyId, host])).digest('hex').slice(0, 32)
  return storage === 'disk' ? `persist:acb-browser-${hash}` : `acb-browser-mem-${hash}`
}

export interface BrowserControllerDeps {
  shell: BrowserShell
  logins: KeptLogins
  /** The signed-in account (null while signed out). */
  userId: () => string | null
  storageFor: (mode: AgentSandboxMode) => LoginStorage
  /** The member's sites for this company may have changed (the settings re-read). */
  onChanged?: (companyId: string) => void
  log?: Pick<Console, 'warn'>
}

interface OpenWindow {
  userId: string
  companyId: string
  host: string
  partition: string
  storage: LoginStorage
  handle: BrowserWindowHandle
}

export function createBrowserController(deps: BrowserControllerDeps) {
  const log = deps.log ?? console
  /** `${user}\0${company}` → the state from the last valid answer; absent = unknown = off. */
  const known = new Map<string, BrowserState>()
  const windows = new Map<string, OpenWindow>()
  /** Memory partitions used this run (their login lives until the app quits or they are cleared). */
  const memoryPartitions = new Map<string, { userId: string; companyId: string; host: string }>()
  const keyOf = (userId: string, companyId: string) => `${userId}\0${companyId}`

  const clear = (partition: string) => {
    memoryPartitions.delete(partition)
    deps.logins.remove(partition)
    void deps.shell.clearPartition(partition).catch(error => {
      log.warn(`[browser] a login could not be cleared (${error instanceof Error ? error.message : 'unknown'})`)
    })
  }
  const closeWindow = (win: OpenWindow) => {
    windows.delete(win.partition)
    try { win.handle.close() } catch { /* already gone */ }
  }

  function apply(userId: string, companyId: string, state: BrowserState) {
    const site = (host: string) => state.sites.find(s => s.host === host)
    for (const win of [...windows.values()]) {
      if (win.userId !== userId || win.companyId !== companyId) continue
      const now = site(win.host)
      // Its login is cleared below, with the kept logins and the memory ones.
      if (!now || (win.storage === 'disk' && state.storage !== 'disk')) {
        closeWindow(win)
      } else {
        win.handle.updateSite(now)
      }
    }
    for (const login of deps.logins.all()) {
      if (login.userId !== userId || login.companyId !== companyId) continue
      if (!site(login.host) || state.storage !== 'disk') clear(login.partition)
    }
    for (const [partition, owner] of [...memoryPartitions]) {
      if (owner.userId === userId && owner.companyId === companyId && !site(owner.host)) clear(partition)
    }
  }

  const sitesOf = (companyId: string): BrowserState | undefined => {
    const user = deps.userId()
    return user ? known.get(keyOf(user, companyId)) : undefined
  }

  return {
    /** A valid policy answer (200, or 304 for the one held). */
    policyAnswered(companyId: string, policy: AgentPolicy) {
      const user = deps.userId()
      if (!user) return
      const state = browserStateOf(policy, deps.storageFor)
      const before = known.get(keyOf(user, companyId))
      known.set(keyOf(user, companyId), state)
      apply(user, companyId, state)
      if (JSON.stringify(before) !== JSON.stringify(state)) deps.onChanged?.(companyId)
    },

    /** A refresh without a valid answer: off until the next one; windows close, logins stay. */
    policyFailed(companyId: string) {
      const user = deps.userId()
      if (!user) return
      const had = known.delete(keyOf(user, companyId))
      for (const win of [...windows.values()]) {
        if (win.userId === user && win.companyId === companyId) closeWindow(win)
      }
      if (had) deps.onChanged?.(companyId)
    },

    sites(companyId: string): BrowserSitesResult {
      const state = sitesOf(companyId)
      return { sites: (state?.sites ?? []).map(s => ({ host: s.host, loginKept: state?.storage === 'disk' })) }
    },

    /** 「開いてログイン」: only a site of the member's current, valid policy (the renderer's host is only a name). */
    open(companyId: string, host: string): BrowserActionResult {
      const user = deps.userId()
      const state = sitesOf(companyId)
      const site = state?.sites.find(s => s.host === host)
      if (!user || !state || !site) return { ok: false, message: BROWSER_WORDS.notAllowed }
      const existing = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      if (existing) { existing.handle.focus(); return { ok: true } }
      const partition = browserPartition(user, companyId, host, state.storage)
      if (state.storage === 'disk') deps.logins.record({ partition, userId: user, companyId, host })
      else memoryPartitions.set(partition, { userId: user, companyId, host })
      const entry: OpenWindow = {
        userId: user, companyId, host, partition, storage: state.storage,
        handle: deps.shell.open({ partition, site, onClosed: () => { if (windows.get(partition) === entry) windows.delete(partition) } }),
      }
      windows.set(partition, entry)
      return { ok: true }
    },

    /** 「ログインを消す」: the window closes and the site's login is cleared, kept on disk or not. */
    clearLogin(companyId: string, host: string): BrowserActionResult {
      const user = deps.userId()
      const state = sitesOf(companyId)
      if (!user || !state?.sites.some(s => s.host === host)) return { ok: false, message: BROWSER_WORDS.notAllowed }
      for (const win of [...windows.values()]) {
        if (win.userId === user && win.companyId === companyId && win.host === host) closeWindow(win)
      }
      clear(browserPartition(user, companyId, host, 'disk'))
      clear(browserPartition(user, companyId, host, 'memory'))
      return { ok: true }
    },

    /** Sign-out: every window closes and every login is cleared (disk and memory). */
    signedOut() {
      for (const win of [...windows.values()]) closeWindow(win)
      known.clear()
      for (const login of deps.logins.all()) clear(login.partition)
      for (const partition of [...memoryPartitions.keys()]) clear(partition)
    },

    /** Signed in (also a session restored): another account's windows close and its kept logins go. */
    signedIn(userId: string) {
      for (const win of [...windows.values()]) {
        if (win.userId !== userId) closeWindow(win)
      }
      for (const login of deps.logins.all()) if (login.userId !== userId) clear(login.partition)
      for (const [partition, owner] of [...memoryPartitions]) if (owner.userId !== userId) clear(partition)
    },
  }
}

export type BrowserController = ReturnType<typeof createBrowserController>

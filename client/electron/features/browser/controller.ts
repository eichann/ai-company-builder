// 「ブラウザ操作」 in the app (agent-browser.md "The app's window"): which sites the member may open
// now, the windows open, and when a window closes and its login is cleared. No Electron: the shell's
// window (electron/browser-window.ts) comes in as `BrowserShell`.
//
// - The login lives in memory only (never on disk in this version): every window's session is an
//   in-memory partition, gone when the app quits.
// - Only a valid policy answer opens anything: no answer, an error or an answer that does not
//   validate = off until the next valid one (`policyFailed` closes the company's windows).
// - A valid answer that drops a site or turns the mode off closes its window and clears its login.
// - Signing out clears every login; signing in as another account clears the others'.
import { createHash } from 'node:crypto'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import type { AgentPolicy } from '../../../../shared/types/agent-sandbox'
import { BROWSER_WORDS, type BrowserActionResult, type BrowserSitesResult } from '../../../shared/browser-operation'
import type { BrowserRunSurface } from '../../../shared/browser-runner'

export interface BrowserWindowSpec {
  partition: string
  site: BrowserSiteSetting
  /** The window is gone (closed by the member or by the app). */
  onClosed: () => void
}

export interface BrowserWindowHandle {
  focus(): void
  /** Closed by the app: the session refuses everything at once and the page cannot keep it open. */
  close(): void
  /** The site's setting changed (its asset hosts): the window's rules read the new one at once. */
  updateSite(site: BrowserSiteSetting): void
  /** What an operation run uses (agent-browser.md "The runner"); the shell's window always has it. */
  run?: BrowserRunSurface
}

/** What the shell provides (electron/browser-window.ts). */
export interface BrowserShell {
  open(spec: BrowserWindowSpec): BrowserWindowHandle
  /** Cookies, storage, caches and service workers of that partition. */
  clearPartition(partition: string): Promise<void>
}

/** The sites the member may open (empty: off), from a valid policy answer. */
export function browserSitesOf(policy: AgentPolicy): BrowserSiteSetting[] {
  const browser = policy.browser
  return browser?.mode === 'on' ? browser.sites : []
}

/**
 * The window's session: one per account × company × site, always in memory (no `persist:`).
 * Keeping a login on disk waits until it can be bound to "every AI turn on this PC is enclosed"
 * (agent-browser.md "Not yet").
 */
export function browserPartition(userId: string, companyId: string, host: string): string {
  const hash = createHash('sha256').update(JSON.stringify([userId, companyId, host])).digest('hex').slice(0, 32)
  return `acb-browser-${hash}`
}

export interface BrowserControllerDeps {
  shell: BrowserShell
  /** The signed-in account (null while signed out). */
  userId: () => string | null
  /** The member's sites for this company may have changed (the settings re-read). */
  onChanged?: (companyId: string) => void
  log?: Pick<Console, 'warn'>
}

interface OpenWindow {
  userId: string
  companyId: string
  host: string
  partition: string
  handle: BrowserWindowHandle
}

export function createBrowserController(deps: BrowserControllerDeps) {
  const log = deps.log ?? console
  /** `${user}\0${company}` → the sites from the last valid answer; absent = unknown = off. */
  const known = new Map<string, BrowserSiteSetting[]>()
  const windows = new Map<string, OpenWindow>()
  /** Partitions used this run (their login lives until the app quits or they are cleared). */
  const partitions = new Map<string, { userId: string; companyId: string; host: string }>()
  const keyOf = (userId: string, companyId: string) => `${userId}\0${companyId}`

  const clear = async (partition: string): Promise<boolean> => {
    partitions.delete(partition)
    try {
      await deps.shell.clearPartition(partition)
      return true
    } catch (error) {
      log.warn(`[browser] a login could not be cleared (${error instanceof Error ? error.message : 'unknown'})`)
      return false
    }
  }
  const closeWindow = (win: OpenWindow) => {
    windows.delete(win.partition)
    try { win.handle.close() } catch { /* already gone */ }
  }
  const sitesOf = (companyId: string): BrowserSiteSetting[] | undefined => {
    const user = deps.userId()
    return user ? known.get(keyOf(user, companyId)) : undefined
  }

  return {
    /** A valid policy answer (200, or 304 for the one held). */
    policyAnswered(companyId: string, policy: AgentPolicy) {
      const user = deps.userId()
      if (!user) return
      const sites = browserSitesOf(policy)
      const before = known.get(keyOf(user, companyId))
      known.set(keyOf(user, companyId), sites)
      const site = (host: string) => sites.find(s => s.host === host)
      for (const win of [...windows.values()]) {
        if (win.userId !== user || win.companyId !== companyId) continue
        const now = site(win.host)
        if (now) win.handle.updateSite(now)
        else closeWindow(win)
      }
      for (const [partition, owner] of [...partitions]) {
        if (owner.userId === user && owner.companyId === companyId && !site(owner.host)) void clear(partition)
      }
      if (JSON.stringify(before) !== JSON.stringify(sites)) deps.onChanged?.(companyId)
    },

    /** A refresh without a valid answer: off until the next one; windows close (the memory login stays). */
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
      return { sites: (sitesOf(companyId) ?? []).map(s => ({ host: s.host })) }
    },

    /** 「開いてログイン」: only a site of the member's current, valid policy (the renderer's host is only a name). */
    open(companyId: string, host: string): BrowserActionResult {
      const user = deps.userId()
      const site = sitesOf(companyId)?.find(s => s.host === host)
      if (!user || !site) return { ok: false, message: BROWSER_WORDS.notAllowed }
      const existing = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      if (existing) { existing.handle.focus(); return { ok: true } }
      const partition = browserPartition(user, companyId, host)
      partitions.set(partition, { userId: user, companyId, host })
      const entry: OpenWindow = {
        userId: user, companyId, host, partition,
        handle: deps.shell.open({ partition, site, onClosed: () => { if (windows.get(partition) === entry) windows.delete(partition) } }),
      }
      windows.set(partition, entry)
      return { ok: true }
    },

    /** 「ログインを消す」: the window closes and the site's login is cleared; success only once it is. */
    async clearLogin(companyId: string, host: string): Promise<BrowserActionResult> {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return { ok: false, message: BROWSER_WORDS.notAllowed }
      for (const win of [...windows.values()]) {
        if (win.userId === user && win.companyId === companyId && win.host === host) closeWindow(win)
      }
      return (await clear(browserPartition(user, companyId, host))) ? { ok: true } : { ok: false, message: BROWSER_WORDS.clearFailed }
    },

    /** The site as the signed-in member's current valid policy lists it, or null (the runner's check before each step). */
    siteNow(companyId: string, host: string): BrowserSiteSetting | null {
      return sitesOf(companyId)?.find(s => s.host === host) ?? null
    },

    /** The signed-in member's open window of a site their current policy lists (the runner's), or null. */
    runWindow(companyId: string, host: string): BrowserRunSurface | null {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return null
      const win = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      return win?.handle.run ?? null
    },

    /** Sign-out: every window closes and every login is cleared. */
    signedOut() {
      for (const win of [...windows.values()]) closeWindow(win)
      known.clear()
      for (const partition of [...partitions.keys()]) void clear(partition)
    },

    /** Signed in (also a session restored): another account's windows close and its logins go. */
    signedIn(userId: string) {
      for (const win of [...windows.values()]) if (win.userId !== userId) closeWindow(win)
      for (const [partition, owner] of [...partitions]) if (owner.userId !== userId) void clear(partition)
    },
  }
}

export type BrowserController = ReturnType<typeof createBrowserController>

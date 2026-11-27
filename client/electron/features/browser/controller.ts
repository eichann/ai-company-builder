// 「ブラウザ操作」 in the app (agent-browser.md "The app's window"): which sites the member may open
// now, the windows open, and when a window closes and its login is cleared. No Electron: the shell's
// window (electron/browser-window.ts) comes in as `BrowserShell`.
//
// - The login lives in memory (an in-memory partition, gone when the app quits) — unless it is kept on
//   this PC (agent-browser.md "Keeping a login on disk", `kept-logins.ts`): only with `kept` given (a
//   platform where the sandbox runs), only for a site the current valid answer says `browserLoginStorage`
//   → disk for (the member's sandbox `enforce` and their own level not 使わない), and only while this run
//   never ran an AI turn without the sandbox (`beforeAiTurn`, which removes every kept login first).
// - Only a valid policy answer opens anything: no answer, an error or an answer that does not
//   validate = off for the AI until the next valid one; the member's open windows stay (a brief network
//   drop must not cost them their window, owner 2026-11-27). A refusal (the server says this account may not
//   have this company's policy) closes the company's windows and removes its kept logins.
// - A run that needs a site's window opens it again by itself (`windowForRun`) while this app run holds the
//   member's login for the site, through the same path as 「開いてログイン」 (agent-browser.md "The window a run needs").
// - A valid answer that drops a site or turns the mode off closes its window and clears its login; one
//   whose site is no longer to be kept (sandbox or level) removes its kept login (the window closes).
// - Signing out clears every login, kept ones included; signing in as another account clears the others'.
// - A site's parts hosts and login helpers are the company's 「詳しい設定」 of that domain (the policy's
//   `browserParts`, redesign step ②: agent-browser.md "A domain's parts and login helpers"); a domain the
//   company set nothing for falls back to the reviewed bundled declaration (`assetHostsOf` / `loginHelpersOf`,
//   until step ⑦), logged. Never the company's free-text list on the site, which only a development build that
//   asks for it adds (`developerAssetHosts`; "Asset hosts").
import { createHash } from 'node:crypto'
import { browserLoginStorage, type BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import type { AiTurnFacts, KeptLogins } from './kept-logins'
import type { AgentPolicy } from '../../../../shared/types/agent-sandbox'
import type { BrowserLoginHelper } from '../../../../shared/core/plugin-browser-declaration'
import {
  BROWSER_WORDS, browserWindowSiteFrom, type BrowserActionResult, type BrowserRunWindow, type BrowserSitesResult,
} from '../../../shared/browser-operation'
import type { BrowserPreviewSurface, BrowserRunSurface } from '../../../shared/browser-runner'
import type { BrowserBrowseSurface } from '../../../shared/browser-browse'
import type { BrowserRecordSurface } from '../../../shared/browser-recorder'

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
  /** What the preview reads through (agent-browser.md "The operator and the preview"); the shell's window always has it. */
  preview?: BrowserPreviewSurface
  /** What a recording observes through (agent-browser.md "Recording"); the shell's window always has it. */
  record?: BrowserRecordSurface
  /** What the operator's window tools act through (agent-browser.md "The operator's window tools"); the shell's window always has it. */
  browse?: BrowserBrowseSurface
  /** Resolves once the page has loaded the first time (true), or false when it did not in time, closed or the signal ended. */
  whenLoaded?(signal: AbortSignal): Promise<boolean>
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
 * The window's in-memory session: one per account × company × site (no `persist:`). A kept login's
 * session is `kept-logins.ts` `partition` instead.
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
  /**
   * The asset hosts of a site's host from the reviewed declaration this build carries and the approved
   * list approves (main composes it, `bundledAssetHosts`); absent = none.
   */
  assetHostsOf?: (host: string) => readonly string[]
  /** The login helpers of the same bundled declaration (`bundledLoginHelpers`): the fallback likewise; absent = none. */
  loginHelpersOf?: (host: string) => readonly BrowserLoginHelper[]
  /** A development build that asks for it also adds the company's free-text asset hosts (a developer setting). */
  developerAssetHosts?: boolean
  /**
   * Logins kept on this PC (`kept-logins.ts`); main gives it only where the company sandbox runs (`sandboxPlatform`).
   * Absent: every login lives in memory, as before.
   */
  kept?: KeptLogins
  /**
   * Does this AI turn keep the kept logins' place unreadable (`enforce`, and `sandboxKeepsPlaceUnread` for the
   * partitions folder and the turn's company folder)? Main composes it; absent = no turn does.
   */
  turnEnclosesKept?: (turn: AiTurnFacts) => boolean
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
  /** Where each domain's parts came from at the last answer, so the fallback is logged once per change. */
  const sourceSaid = new Map<string, 'company' | 'bundled' | 'none'>()
  /** `${user}\0${company}` → whether the last valid answer's sandbox for the member was 囲う (Settings' login line). */
  const enclosed = new Map<string, boolean>()
  /**
   * `${user}\0${company}\0${host}` → the app removed the site's kept login for safety (its sandbox or level changed, or an
   * AI turn without the sandbox ran): a run that then finds no window says why. Gone when the member opens or clears it.
   */
  const loginRemoved = new Set<string>()
  const siteKey = (userId: string, companyId: string, host: string) => `${userId}\0${companyId}\0${host}`

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
  /** `${user}\0${company}` → the hosts whose login the last valid answer lets this PC keep (`browserLoginStorage`). */
  const keptHosts = new Map<string, Set<string>>()
  /** May this site's login be kept on this PC now (the answer, this run, a partition not removed earlier in it)? */
  const keepsNow = (userId: string, companyId: string, host: string): boolean =>
    !!deps.kept?.mayKeep(userId, companyId, host) && !!keptHosts.get(keyOf(userId, companyId))?.has(host)
  /** What Settings says: kept now, and no window of the site already open in memory (a new login there is not kept). */
  const keptShown = (userId: string, companyId: string, host: string): boolean =>
    keepsNow(userId, companyId, host) &&
    ![...windows.values()].some(w => w.userId === userId && w.companyId === companyId && w.host === host && !deps.kept!.isKept(w.partition))
  /** Removes kept logins (closing their windows first); logs and answers false when one is left on disk. */
  const removeKept = async (scope: Parameters<KeptLogins['remove']>[0], closeWhere: (win: OpenWindow) => boolean): Promise<boolean> => {
    if (!deps.kept) return true
    for (const win of [...windows.values()]) if (deps.kept.isKept(win.partition) && closeWhere(win)) closeWindow(win)
    const ok = await deps.kept.remove(scope)
    if (!ok) {
      // Nothing more is kept in this run once a removal failed (the disk is not what the rules say).
      deps.kept.stop()
      log.warn('[browser] a kept login is still on disk after removing it; nothing more is kept this run')
    }
    return ok
  }
  /** Opens (or, `focus`, brings forward) the member's window of a site their current valid policy lists; false: not listed. */
  const openWindow = (companyId: string, host: string, how: { focus: boolean }): boolean => {
    const user = deps.userId()
    const site = sitesOf(companyId)?.find(s => s.host === host)
    if (!user || !site) return false
    loginRemoved.delete(siteKey(user, companyId, host))
    const existing = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
    if (existing) { if (how.focus) existing.handle.focus(); return true }
    // Kept on this PC when the current answer and this run allow it (`keepsNow`), else in memory.
    const keptPartition = keepsNow(user, companyId, host) ? deps.kept!.partition(user, companyId, host) : null
    const partition = keptPartition ?? browserPartition(user, companyId, host)
    if (!keptPartition) partitions.set(partition, { userId: user, companyId, host })
    const entry: OpenWindow = {
      userId: user, companyId, host, partition,
      handle: deps.shell.open({ partition, site, onClosed: () => { if (windows.get(partition) === entry) windows.delete(partition) } }),
    }
    windows.set(partition, entry)
    return true
  }

  return {
    /** A valid policy answer (200, or 304 for the one held). */
    policyAnswered(companyId: string, policy: AgentPolicy) {
      const user = deps.userId()
      if (!user) return
      const listed = browserSitesOf(policy)
      const operated = listed.map(s => s.host)
      const sites = listed.map(s => {
        const { site, from } = browserWindowSiteFrom(s, {
          company: policy.browserParts?.find(p => p.host === s.host),
          bundled: { assetHosts: deps.assetHostsOf?.(s.host) ?? [], loginHelpers: deps.loginHelpersOf?.(s.host) ?? [] },
        }, deps.developerAssetHosts === true, operated)
        // Which source a domain's parts come from, said once per change (host only): the bundled one is the
        // fallback until step ⑦, so a company still relying on it shows in the log.
        const said = `${user}\0${companyId}\0${s.host}`
        if (sourceSaid.get(said) !== from) {
          sourceSaid.set(said, from)
          if (from === 'bundled') log.warn(`[browser] ${s.host}: parts and login helpers from the app's bundled declaration (the company set none)`)
        }
        return site
      })
      const before = known.get(keyOf(user, companyId))
      known.set(keyOf(user, companyId), sites)
      // Where each site's login may live (agent-browser.md "Keeping a login on disk"): the company's half of the rule.
      const levels = policy.browserLevels ?? []
      const disk = new Set(listed
        .filter(s => browserLoginStorage(policy.sandbox.mode, levels.find(l => l.host === s.host)?.level) === 'disk')
        .map(s => s.host))
      const keptBefore = [...keptHosts.get(keyOf(user, companyId)) ?? []]
      keptHosts.set(keyOf(user, companyId), disk)
      enclosed.set(keyOf(user, companyId), policy.sandbox.mode === 'enforce')
      // A site still listed whose kept login now goes: a run that then finds no window says why.
      for (const host of keptBefore) if (!disk.has(host) && operated.includes(host) && deps.kept?.held(user, companyId, host)) loginRemoved.add(siteKey(user, companyId, host))
      // A site whose login may no longer be kept (removed, the mode off, the sandbox not 囲う, 使わない): its kept
      // login goes — found on the disk, so one an earlier run left goes too; its window closes.
      void removeKept({ userId: user, companyId, exceptHosts: [...disk] }, win => win.userId === user && win.companyId === companyId && !disk.has(win.host))
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
      if (JSON.stringify(before) !== JSON.stringify(sites) || JSON.stringify(keptBefore) !== JSON.stringify([...disk])) deps.onChanged?.(companyId)
    },

    /**
     * A refresh without a valid answer: off until the next one — nothing opens, and no run finds a window (`siteNow`,
     * `runWindow`, `browseWindow`… answer null), so an AI step in progress stops at its next check. No server, a timeout, a
     * 5xx or an answer that does not validate leave the member's windows and their pages alone (owner 2026-11-27: a brief
     * network drop closed them; the next valid answer closes any site it no longer lists). `refused`: the server refused
     * this account the company's policy (401 / 403 / 404: signed out there, left the company) — the windows close and its
     * kept logins go (the memory login stays until the app quits).
     */
    policyFailed(companyId: string, detail?: { refused?: boolean }) {
      const user = deps.userId()
      if (!user) return
      const had = known.delete(keyOf(user, companyId))
      keptHosts.delete(keyOf(user, companyId))
      if (detail?.refused) {
        for (const win of [...windows.values()]) {
          if (win.userId === user && win.companyId === companyId) closeWindow(win)
        }
        void removeKept({ userId: user, companyId }, win => win.userId === user && win.companyId === companyId)
      }
      if (had) deps.onChanged?.(companyId)
    },

    sites(companyId: string): BrowserSitesResult {
      const user = deps.userId()
      return {
        sites: (sitesOf(companyId) ?? []).map(s => {
          if (user && keptShown(user, companyId, s.host)) return { host: s.host, kept: true }
          // In memory because the member's sandbox is not 囲う: Settings says so (else the plain memory line).
          return { host: s.host, ...(user && enclosed.get(keyOf(user, companyId)) === false ? { notKeptBySandbox: true } : {}) }
        }),
      }
    },

    /**
     * Before every AI turn the app starts (agent-browser.md "Keeping a login on disk"): a turn that keeps the kept
     * logins' place unreadable (`turnEnclosesKept`) goes on; any other first stops keeping for this run (at once,
     * before anything is awaited: a window opened meanwhile lives in memory), closes the kept windows and removes
     * every kept login on this PC — every account's and company's: such a turn can read them all. True only when
     * none is left on disk; false = the turn must not start.
     */
    async beforeAiTurn(turn: AiTurnFacts): Promise<boolean> {
      if (!deps.kept) return true
      if (deps.turnEnclosesKept?.(turn)) return true
      const wasKeeping = deps.kept.keeping()
      deps.kept.stop()
      // A PC where nothing was ever kept (none found at start, none handed out since) has nothing to read or refuse.
      // What was kept goes now: a run that then finds no window says why.
      if (wasKeeping) for (const [key, hosts] of keptHosts) for (const host of hosts) loginRemoved.add(`${key}\0${host}`)
      const ok = deps.kept.maybeOnDisk() ? await removeKept({ all: true }, () => true) : true
      if (wasKeeping) {
        const user = deps.userId()
        for (const [key, hosts] of keptHosts) {
          const [owner, companyId] = key.split('\0')
          if (owner === user && hosts.size > 0) deps.onChanged?.(companyId)
        }
      }
      return ok
    },

    /** 「開いてログイン」: only a site of the member's current, valid policy (the renderer's host is only a name). */
    open(companyId: string, host: string): BrowserActionResult {
      return openWindow(companyId, host, { focus: true }) ? { ok: true } : { ok: false, message: BROWSER_WORDS.notAllowed }
    },

    /**
     * A run needs the site's window (agent-browser.md "The window a run needs"; asked before the run looks for it): the
     * open one; else — only while this app run holds the member's login for a site their current valid policy lists (its
     * memory session used this run and not cleared, or a kept login on this PC) — one opened now through `open`'s own path,
     * every check of it included. Waits (bounded, and never past the signal) until its page has loaded once. A login form
     * there is the run's to meet (its `need-login` stop): the member logs in in the window that opened.
     */
    async windowForRun(companyId: string, host: string, signal: AbortSignal): Promise<BrowserRunWindow> {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return { kind: 'none', loginRemoved: false }
      const find = () => [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      let win = find()
      let kind: 'open' | 'opened' = 'open'
      if (!win) {
        // A memory login made before keeping was allowed counts too (the window then opens kept: one login there).
        const held = partitions.has(browserPartition(user, companyId, host))
          || (keepsNow(user, companyId, host) && !!deps.kept?.held(user, companyId, host))
        if (!held) return { kind: 'none', loginRemoved: loginRemoved.has(siteKey(user, companyId, host)) }
        if (!openWindow(companyId, host, { focus: false })) return { kind: 'none', loginRemoved: false }
        log.warn(`[browser] ${host}: the window a run needs was opened again (its login is still held)`)
        win = find()
        kind = 'opened'
      }
      if (win?.handle.whenLoaded) await win.handle.whenLoaded(signal).catch(() => false)
      return { kind }
    },

    /** 「ログインを消す」: the window closes and the site's login is cleared; success only once it is. */
    async clearLogin(companyId: string, host: string): Promise<BrowserActionResult> {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return { ok: false, message: BROWSER_WORDS.notAllowed }
      loginRemoved.delete(siteKey(user, companyId, host))
      for (const win of [...windows.values()]) {
        if (win.userId === user && win.companyId === companyId && win.host === host) closeWindow(win)
      }
      // The memory login and the one kept on this PC, both.
      const [memory, kept] = await Promise.all([
        clear(browserPartition(user, companyId, host)),
        removeKept({ userId: user, companyId, host }, () => false),
      ])
      // A removed kept login is not kept again in this run: Settings says so.
      if (deps.kept) deps.onChanged?.(companyId)
      return memory && kept ? { ok: true } : { ok: false, message: BROWSER_WORDS.clearFailed }
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

    /** The signed-in member's open window of a site their current policy lists, as the preview reads through it, or null. */
    previewWindow(companyId: string, host: string): BrowserPreviewSurface | null {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return null
      const win = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      return win?.handle.preview ?? null
    },

    /** The signed-in member's open window of a site their current policy lists, as a recording observes it, or null. */
    recordWindow(companyId: string, host: string): BrowserRecordSurface | null {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return null
      const win = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      return win?.handle.record ?? null
    },

    /** The signed-in member's open window of a site their current policy lists, as the operator's window tools act on it, or null. */
    browseWindow(companyId: string, host: string): BrowserBrowseSurface | null {
      const user = deps.userId()
      if (!user || !sitesOf(companyId)?.some(s => s.host === host)) return null
      const win = [...windows.values()].find(w => w.userId === user && w.companyId === companyId && w.host === host)
      return win?.handle.browse ?? null
    },

    /** Sign-out: every window closes and every login is cleared, every kept one on this PC included. */
    signedOut() {
      for (const win of [...windows.values()]) closeWindow(win)
      known.clear()
      keptHosts.clear()
      for (const partition of [...partitions.keys()]) void clear(partition)
      void removeKept({ all: true }, () => true)
    },

    /**
     * Signed in (also a session restored at start): another account's windows close and its logins go — the kept
     * ones on this PC too, found on the disk (an earlier run's included).
     */
    signedIn(userId: string) {
      for (const win of [...windows.values()]) if (win.userId !== userId) closeWindow(win)
      for (const [partition, owner] of [...partitions]) if (owner.userId !== userId) void clear(partition)
      void removeKept({ otherThan: userId }, win => win.userId !== userId)
    },
  }
}

export type BrowserController = ReturnType<typeof createBrowserController>

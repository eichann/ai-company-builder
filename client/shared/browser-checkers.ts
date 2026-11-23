/**
 * The checkers and browser connector declarations a run may use (agent-browser.md "The checker").
 * Both are **handed in** by the composition root (a site's live in client/connectors/<site>/): this
 * module names no site. A checker id not handed in is never run: a declaration naming it is refused.
 */
import { parsePluginManifest } from '../../shared/core/plugins'
import type { BrowserLoginHelper, PluginBrowser } from '../../shared/core/plugin-browser-declaration'
import type { BrowserChecker } from './browser-runner'

export interface BrowserCheckerRegistry {
  get(id: string): BrowserChecker | undefined
}

/** The checkers by id; two with one id → refused (a run must never pick one of two readers). */
export function createBrowserCheckerRegistry(checkers: readonly BrowserChecker[]): BrowserCheckerRegistry {
  const byId = new Map<string, BrowserChecker>()
  for (const checker of checkers) {
    if (byId.has(checker.id)) throw new Error(`two checkers named ${checker.id}`)
    byId.set(checker.id, checker)
  }
  return { get: id => byId.get(id) }
}

/** A declaration text → its `browser` part, or null when it does not pass the core's checks. */
export function parseBrowserDeclaration(text: string): { id: string; version: string; browser: PluginBrowser } | null {
  const parsed = parsePluginManifest(text)
  if (!parsed.ok || !parsed.value.browser) return null
  return { id: parsed.value.id, version: parsed.value.version, browser: parsed.value.browser }
}

/** The declaration of exactly this connector id and version among those handed in, or null. */
export function createBrowserConnectors(texts: readonly string[]) {
  const parsed = texts.map(parseBrowserDeclaration).filter((d): d is NonNullable<typeof d> => !!d)
  return (id: string, version: string): PluginBrowser | null => parsed.find(d => d.id === id && d.version === version)?.browser ?? null
}

/**
 * The login helpers of a site's host, from the declarations the app bundles (main hands them to the
 * window, agent-browser.md "Login helpers"). A host two declarations name gets none (which one is
 * meant cannot be told); a declaration that does not parse gives none.
 */
export function browserLoginHelpers(texts: readonly string[]): (host: string) => readonly BrowserLoginHelper[] {
  const parsed = texts.map(parseBrowserDeclaration).filter((d): d is NonNullable<typeof d> => !!d)
  return host => {
    const of = parsed.filter(d => d.browser.host === host)
    return of.length === 1 ? of[0].browser.loginHelpers : []
  }
}

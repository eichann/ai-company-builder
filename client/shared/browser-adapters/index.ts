/**
 * The reviewed adapters shipped in the app, by id, and the browser connector declarations bundled
 * with them (agent-browser.md "The runner"). An adapter id that is not here is never run: a
 * declaration naming it is refused.
 */
import { parsePluginManifest } from '../../../shared/core/plugins'
import type { PluginBrowser } from '../../../shared/core/plugin-browser-declaration'
import type { BrowserOperationAdapter } from '../browser-runner'
import { createLstepAddTemplateAdapter, LSTEP_DECLARATION, UNCONFIRMED_ACCOUNT, type AccountReader } from './lstep'

export interface BrowserAdapterRegistry {
  get(id: string): BrowserOperationAdapter | undefined
}

export function createBrowserAdapterRegistry(readers: { lstepAccount?: AccountReader } = {}): BrowserAdapterRegistry {
  const adapters = new Map<string, BrowserOperationAdapter>()
  for (const adapter of [createLstepAddTemplateAdapter(readers.lstepAccount ?? UNCONFIRMED_ACCOUNT)]) adapters.set(adapter.id, adapter)
  return { get: id => adapters.get(id) }
}

/** A declaration text → its `browser` part, or null when it does not pass the core's checks. */
export function parseBrowserDeclaration(text: string): { id: string; version: string; browser: PluginBrowser } | null {
  const parsed = parsePluginManifest(text)
  if (!parsed.ok || !parsed.value.browser) return null
  return { id: parsed.value.id, version: parsed.value.version, browser: parsed.value.browser }
}

/** Declarations shipped with the app (the shelf refuses browser connectors until it can hand them out). */
export const BUNDLED_BROWSER_DECLARATIONS: readonly string[] = [LSTEP_DECLARATION]

/** The bundled declaration of exactly this connector id and version, or null. */
export function createBundledBrowserConnectors(texts: readonly string[] = BUNDLED_BROWSER_DECLARATIONS) {
  const parsed = texts.map(parseBrowserDeclaration).filter((d): d is NonNullable<typeof d> => !!d)
  return (id: string, version: string): PluginBrowser | null => parsed.find(d => d.id === id && d.version === version)?.browser ?? null
}

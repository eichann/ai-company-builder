/**
 * The paths a plugin package may hold (plugins.md "Package folders"), for
 * whoever writes a received package to disk (the app, plan C2): a path the
 * server hands over is written only when it is one of these — so a package
 * can never name a place outside its own folder. The shelf
 * (`server/src/adapters/plugin-shelf.ts`) reads folders by the same grammar.
 */

const TYPE_FILE_RE = /^types\/[a-z][a-z0-9_]{0,39}\.md$/
const STEP_FILE_RE = /^steps\/[a-z0-9][a-z0-9_-]{0,63}\.md$/
const UI_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const UI_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(?:html|js|mjs|css|json|svg|png|jpg|jpeg|gif|webp|woff|woff2)$/
/** `ui/` at most three folders deep. */
const UI_MAX_DIRS = 3

/** A package's folder name: `<id>@<version>`. */
export const PLUGIN_PACKAGE_DIR_RE = /^[a-z][a-z0-9-]{0,39}@\d{1,4}\.\d{1,5}\.\d{1,6}$/

/** True when `path` (relative, `/`-separated) is a file a package may hold. */
export function isPluginPackagePath(path: string): boolean {
  if (typeof path !== 'string' || path.length > 400) return false
  if (path === 'plugin.yaml' || path === 'mapping.yaml' || path === 'signature.yaml') return true
  if (TYPE_FILE_RE.test(path) || STEP_FILE_RE.test(path)) return true
  const parts = path.split('/')
  if (parts[0] !== 'ui' || parts.length < 2 || parts.length > UI_MAX_DIRS + 2) return false
  const file = parts[parts.length - 1]
  return parts.slice(1, -1).every(d => UI_DIR_RE.test(d)) && UI_FILE_RE.test(file)
}

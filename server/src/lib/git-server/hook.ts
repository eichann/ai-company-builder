/**
 * Rendering and installing the pre-receive hook.
 *
 * Only node built-ins here: the client's sync harness imports this file to
 * install the very same hook into its local bare repositories.
 *
 * The template (templates/pre-receive-hook.sh) is a thin caller; the hook it
 * renders runs the TypeScript push checker (lib/push-check/entry.ts) with
 * this server's node and tsx loader, baked in as absolute paths. The paths
 * are re-rendered on every startup (configureAllBareRepos), so a moved
 * install or upgraded node is picked up after a restart.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { logError } from '../error-log'

const HERE = dirname(fileURLToPath(import.meta.url))

export const HOOK_TEMPLATE_PATH = join(HERE, '..', '..', 'templates', 'pre-receive-hook.sh')
export const PUSH_CHECK_ENTRY = join(HERE, '..', 'push-check', 'entry.ts')

/** file:// URL of the tsx ESM loader the server itself resolves (node --import). */
export function tsxLoaderUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
}

/** Single-quote for sh. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface RenderHookOptions {
  /** node binary baked in as the fallback runtime (default: this process's). */
  node?: string
}

export function renderPreReceiveHook(options: RenderHookOptions = {}): string {
  const values: Record<string, string> = {
    '@@ACB_SERVER_NODE@@': options.node ?? process.execPath,
    '@@ACB_TSX_LOADER@@': tsxLoaderUrl(),
    '@@ACB_PUSH_CHECK@@': PUSH_CHECK_ENTRY,
  }
  let hook = readFileSync(HOOK_TEMPLATE_PATH, 'utf-8')
  for (const [placeholder, value] of Object.entries(values)) {
    hook = hook.split(placeholder).join(shellQuote(value))
  }
  return hook
}

/** Install the rendered pre-receive hook into a bare repository. */
export function installPreReceiveHook(repoPath: string, options: RenderHookOptions = {}): boolean {
  try {
    const hooksDir = join(repoPath, 'hooks')
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true })
    const hookDest = join(hooksDir, 'pre-receive')
    writeFileSync(hookDest, renderPreReceiveHook(options))
    chmodSync(hookDest, 0o755)
    return true
  } catch (error) {
    logError('git-server', 'failed to install the pre-receive hook', error, { repository: basename(repoPath) })
    return false
  }
}

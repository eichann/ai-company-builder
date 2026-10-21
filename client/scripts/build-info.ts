/**
 * Computes the desktop-app build identity at build time. vite.config.ts embeds
 * it into the Electron main process through `define` (__ACB_BUILD_INFO__),
 * where electron/client-identity.ts reads it. Format: shared/build-info.ts.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BuildInfo } from '../shared/build-info'

export const BUILD_INFO_DEFINE_KEY = '__ACB_BUILD_INFO__'

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
  } catch {
    return null
  }
}

/** UTC YYYYMMDDHHmmss. */
export function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export function computeBuildInfo(options: { root: string; dev: boolean; now?: Date }): BuildInfo {
  const pkg = JSON.parse(readFileSync(path.join(options.root, 'package.json'), 'utf8')) as { version: string }
  const sha = gitOutput(options.root, ['rev-parse', '--short=7', 'HEAD']) ?? 'nogit'
  const commitSeconds = Number(gitOutput(options.root, ['log', '-1', '--format=%ct', 'HEAD']))
  const commitDate = Number.isFinite(commitSeconds) && commitSeconds > 0
    ? compactUtc(new Date(commitSeconds * 1000))
    : '00000000000000'
  const semver = options.dev ? `${pkg.version}-dev` : pkg.version
  return {
    version: `${semver}+${sha}.${commitDate}`,
    semver,
    sha,
    commitDate,
    builtAt: (options.now ?? new Date()).toISOString(),
    dev: options.dev,
  }
}

/** Vite `define` entries that embed `info` into a bundle. */
export function buildInfoDefine(info: BuildInfo): Record<string, string> {
  return { [BUILD_INFO_DEFINE_KEY]: JSON.stringify(info) }
}

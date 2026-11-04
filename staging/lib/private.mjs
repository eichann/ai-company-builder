// Reading and writing the private kit config (staging/lib/kit.mjs parsePrivateConfig) where the
// person's one local setting points: a file in a private GitHub repository (through `gh`, with
// their own login) or a local file (`file:`; tests, or an operator's copy). Errors never carry
// the location or gh's output: the kit must not name a private place in what it prints.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parsePrivateConfig } from './kit.mjs'

export class PrivateConfigError extends Error {}

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: 60_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  })
}

/** The text of `rel` (default: the config itself) at the private place. */
export function readPrivateText(spec, rel) {
  try {
    if (spec.kind === 'file') return fs.readFileSync(rel ? path.resolve(path.dirname(spec.path), rel) : spec.path, 'utf8')
    return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${spec.repo}/contents/${rel ?? spec.path}`])
  } catch {
    throw new PrivateConfigError('could not read the private kit config')
  }
}

/**
 * { ok: true, production, lockText } or { ok: false }. `lockText` is the plugins.lock production
 * uses (inline lines, or the file a `plugins-lock` line names), '' when none.
 */
export function loadPrivateConfig(spec) {
  try {
    const cfg = parsePrivateConfig(readPrivateText(spec))
    const lockText = cfg.pluginsLockPath ? readPrivateText(spec, cfg.pluginsLockPath) : cfg.lockLines.join('\n') + (cfg.lockLines.length ? '\n' : '')
    return { ok: true, production: cfg.production, lockText }
  } catch {
    return { ok: false }
  }
}

/** Replace the config's text (creating it when missing). */
export function writePrivateText(spec, text, message) {
  if (spec.kind === 'file') {
    fs.writeFileSync(spec.path, text)
    return
  }
  const url = `repos/${spec.repo}/contents/${spec.path}`
  let sha = null
  try { sha = gh(['api', url, '--jq', '.sha']).trim() || null } catch { /* new file */ }
  const body = JSON.stringify({ message, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) })
  try {
    gh(['api', '-X', 'PUT', url, '--input', '-'], body)
  } catch {
    throw new PrivateConfigError('could not write the private kit config (do you have write access?)')
  }
}

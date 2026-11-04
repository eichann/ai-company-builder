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

/**
 * The config's text and version for an update: { text, sha }. Only "not there" (404 / no such
 * file) counts as empty ({ text: '', sha: null }); any other failure (offline, no access) throws,
 * so an update never starts from a blank it only assumed.
 */
export function readPrivateForUpdate(spec) {
  if (spec.kind === 'file') {
    try { return { text: fs.readFileSync(spec.path, 'utf8'), sha: null } } catch (err) {
      if (err?.code === 'ENOENT') return { text: '', sha: null }
      throw new PrivateConfigError('could not read the private kit config')
    }
  }
  let out
  try {
    out = gh(['api', `repos/${spec.repo}/contents/${spec.path}`])
  } catch (err) {
    if (/HTTP 404/.test(String(err?.stderr ?? ''))) return { text: '', sha: null }
    throw new PrivateConfigError('could not read the private kit config')
  }
  const json = JSON.parse(out)
  return { text: Buffer.from(json.content ?? '', 'base64').toString('utf8'), sha: json.sha }
}

/**
 * Replace the config's text. `sha` is the version readPrivateForUpdate read: GitHub refuses the
 * write when the file changed since (no blind overwrite); null creates the file.
 */
export function writePrivateText(spec, text, message, sha) {
  if (spec.kind === 'file') {
    fs.writeFileSync(spec.path, text)
    return
  }
  const body = JSON.stringify({ message, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) })
  try {
    gh(['api', '-X', 'PUT', `repos/${spec.repo}/contents/${spec.path}`, '--input', '-'], body)
  } catch {
    throw new PrivateConfigError('could not write the private kit config (changed meanwhile, or no write access); run it again')
  }
}

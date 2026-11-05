// The staging kit's pure helpers: paths, settings, secrets, the accounts file, redaction and
// the "follow production" decision. No Docker, no network: the tests
// (server/tests/unit/staging-kit.test.ts) run these under plain Node.
//
// Rule: a secret (password, KEK, AUTH_SECRET, the practice HubSpot key) is written only to a
// file under the kit's home with mode 0600 and is never passed to `log()`; `log()` also
// redacts every secret it was told about, in case one slips into a message.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Defaults chosen not to collide with the owner's hand-made staging (13001 / 3100 / 4010-4012). */
export const DEFAULTS = Object.freeze({
  port: 14001,
  fakeHubspotPort: 14010,
  fakeGooglePort: 14011,
  fakeSlackPort: 14012,
  fakePortalPort: 14013,
  project: 'acb-staging-kit',
  // The public repository; without the private setting the kit follows its main branch.
  remote: 'https://github.com/eichann/ai-company-builder.git',
  branch: 'main',
})

/**
 * The one local setting an FDE gets at onboarding: where the private kit config is
 * (`ACB_KIT_PRIVATE=<owner>/<repo>:<path>`, read with the person's `gh` login; or
 * `file:<absolute path>`), from the environment or from ~/.acb-staging-kit/config. The kit
 * names no private location itself.
 */
export function privateSpecFrom(env = process.env) {
  let raw = env.ACB_KIT_PRIVATE?.trim()
  if (!raw) {
    const file = env.ACB_KIT_CONFIG?.trim() || path.join(os.homedir(), '.acb-staging-kit', 'config')
    try {
      const m = /^ACB_KIT_PRIVATE=(.*)$/m.exec(fs.readFileSync(file, 'utf8'))
      raw = m?.[1].trim()
    } catch { /* no setting */ }
  }
  if (!raw) return null
  return parsePrivateSpec(raw)
}

export function parsePrivateSpec(raw) {
  if (raw.startsWith('file:')) {
    const file = raw.slice(5)
    if (!path.isAbsolute(file)) throw new Error('ACB_KIT_PRIVATE=file:<path> needs an absolute path')
    return { kind: 'file', path: file }
  }
  const m = /^([\w.-]+\/[\w.-]+):([\w./@-]+)$/.exec(raw)
  if (!m || m[2].split('/').includes('..')) throw new Error('ACB_KIT_PRIVATE must be <owner>/<repo>:<path> or file:<absolute path>')
  return { kind: 'github', repo: m[1], path: m[2] }
}

/**
 * The private kit config (one text file; `#` comments):
 *   production <40-hex commit>          the main commit production runs (staging/mark-production.mjs)
 *   plugins-lock <path>                  optional: production's plugins.lock, another file of the same place
 *   portal <host> <base path> <service> [<declared path>=<fake path> …]
 *                                        optional: what the practice portal stands in for
 *   <repo> <id>@<version> <fingerprint>  optional: plugins.lock lines inline (the collector's format)
 * Returns { production, pluginsLockPath, lockLines, portal }.
 */
export function parsePrivateConfig(text) {
  let production = null
  let pluginsLockPath = null
  const lockLines = []
  let portal = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts[0] === 'production') {
      if (parts.length !== 2 || !/^[0-9a-f]{40}$/.test(parts[1])) throw new Error('private kit config: "production" needs one full commit id')
      production = parts[1]
    } else if (parts[0] === 'plugins-lock') {
      if (parts.length !== 2 || parts[1].split('/').includes('..')) throw new Error('private kit config: bad "plugins-lock" line')
      pluginsLockPath = parts[1]
    } else if (parts[0] === 'portal') {
      if (parts.length < 4 || !PORTAL_HOST_RE.test(parts[1]) || !PORTAL_BASE_PATH_RE.test(parts[2]) || !PORTAL_SERVICE_RE.test(parts[3]) || !parts.slice(4).every(a => PORTAL_ALIAS_RE.test(a))) {
        throw new Error('private kit config: bad "portal" line')
      }
      portal = { host: parts[1], basePath: parts[2], service: parts[3], aliases: parts.slice(4) }
    } else {
      lockLines.push(line)
    }
  }
  return { production, pluginsLockPath, lockLines, portal }
}

const PORTAL_HOST_RE = /^[a-z0-9.-]+\.[a-z0-9-]+$/
const PORTAL_BASE_PATH_RE = /^(?:\/[A-Za-z0-9_-]+)+$/
const PORTAL_SERVICE_RE = /^[a-z][a-z0-9-]{0,39}$/
const PORTAL_ALIAS_RE = /^\/[A-Za-z0-9/_{}-]+=\/[A-Za-z0-9/_{}-]+$/
/** Without the private line the practice portal stands in for the public fixture's made-up host. */
export const PUBLIC_PORTAL = Object.freeze({ host: 'portal.sample.example', basePath: '/api', service: 'sample-portal', aliases: [] })

/** What the practice portal stands in for: <home>/portal-practice (written by bootstrap from the private config), else the public default. */
export function portalPractice(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.portal, 'utf8'))
    return parsed ?? PUBLIC_PORTAL
  } catch {
    return PUBLIC_PORTAL
  }
}

/** The config with its `production` line set to `sha` (other lines kept as they are). */
export function withProductionCommit(text, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('a full 40-character commit id is needed')
  const line = `production ${sha}`
  if (/^production\s.*$/m.test(text)) return text.replace(/^production\s.*$/m, line)
  const head = text && !text.endsWith('\n') ? text + '\n' : text
  return (head || '# ACB staging kit: what production runs (staging/mark-production.mjs)\n') + line + '\n'
}

export const PRACTICE_HUBSPOT_PREFIX = 'pat-fake-'

/** Everything the kit keeps, under one folder (default ~/acb-staging-kit). */
export function kitPaths(home) {
  const h = path.resolve(home)
  return {
    home: h,
    app: path.join(h, 'app'),
    data: path.join(h, 'data'),
    plugins: path.join(h, 'plugins'),
    secrets: path.join(h, 'secrets'),
    kek: path.join(h, 'secrets', 'broker-kek'),
    authSecret: path.join(h, 'secrets', 'auth-secret'),
    fakeHubspotKey: path.join(h, 'secrets', 'fake-hubspot-key'),
    fakePortalKey: path.join(h, 'secrets', 'fake-portal-key'),
    env: path.join(h, 'secrets', 'compose.env'),
    accounts: path.join(h, 'accounts.txt'),
    state: path.join(h, 'state.json'),
    built: path.join(h, 'built.json'),
    lock: path.join(h, 'plugins.lock'),
    portal: path.join(h, 'portal-practice.json'),
    backups: path.join(h, 'backups'),
    userdata: path.join(h, 'userdata'),
    folders: path.join(h, 'folders'),
    logs: path.join(h, 'logs'),
    run: path.join(h, 'run'),
  }
}

function port(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`${name} must be a port number between 1024 and 65535 (got ${raw})`)
  return n
}

/** The kit's settings from the environment (ACB_STAGING_*), validated. */
export function settingsFrom(env = process.env) {
  const s = {
    home: env.ACB_STAGING_HOME?.trim() || path.join(os.homedir(), 'acb-staging-kit'),
    port: port(env, 'ACB_STAGING_PORT', DEFAULTS.port),
    fakeHubspotPort: port(env, 'ACB_STAGING_FAKE_HUBSPOT_PORT', DEFAULTS.fakeHubspotPort),
    fakeGooglePort: port(env, 'ACB_STAGING_FAKE_GOOGLE_PORT', DEFAULTS.fakeGooglePort),
    fakeSlackPort: port(env, 'ACB_STAGING_FAKE_SLACK_PORT', DEFAULTS.fakeSlackPort),
    fakePortalPort: port(env, 'ACB_STAGING_FAKE_PORTAL_PORT', DEFAULTS.fakePortalPort),
    project: env.ACB_STAGING_PROJECT?.trim() || DEFAULTS.project,
    remote: env.ACB_STAGING_REMOTE?.trim() || DEFAULTS.remote,
    branch: env.ACB_STAGING_BRANCH?.trim() || DEFAULTS.branch,
    private: privateSpecFrom(env),
  }
  // Prefixed, so the kit's `docker compose -p` (down -v, --rmi) can only ever reach its own projects.
  if (!/^acb-staging[a-z0-9_-]*$/.test(s.project)) throw new Error('ACB_STAGING_PROJECT must start with acb-staging (lower-case letters, digits, - or _)')
  if (!/^[A-Za-z0-9._/-]+$/.test(s.branch) || s.branch.includes('..')) throw new Error('ACB_STAGING_BRANCH is not a branch name')
  const ports = [s.port, s.fakeHubspotPort, s.fakeGooglePort, s.fakeSlackPort, s.fakePortalPort]
  if (new Set(ports).size !== ports.length) throw new Error('The staging ports must all differ')
  return s
}

export const publicUrl = s => `http://localhost:${s.port}`

// ------------------------------------------------------------------ secrets

export const newPassword = () => randomBytes(18).toString('base64url') // 24 chars, ~144 bits
export const newAuthSecret = () => randomBytes(32).toString('base64')
export const newKek = () => randomBytes(32).toString('base64') // the server's kek-file format
export const newFakeHubspotKey = () => `${PRACTICE_HUBSPOT_PREFIX}na1-${randomBytes(12).toString('hex')}`
export const newFakePortalKey = () => `${PRACTICE_HUBSPOT_PREFIX}portal-${randomBytes(12).toString('hex')}`

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

/**
 * Create `file` (mode 0600) holding `make()` unless it exists. Never overwrites: a KEK
 * replaced under stored keys would make them unreadable. Returns { created, value }.
 */
export function ensureSecretFile(file, make) {
  ensurePrivateDir(path.dirname(file))
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600)
    return { created: false, value: fs.readFileSync(file, 'utf8').trim() }
  }
  const value = make()
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeSync(fd, value + '\n') } finally { fs.closeSync(fd) }
  return { created: true, value }
}

/** Write `text` to `file` with mode 0600 (replacing it). */
export function writePrivateFile(file, text) {
  ensurePrivateDir(path.dirname(file))
  fs.writeFileSync(file, text, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** The env file `docker compose --env-file` reads: settings + AUTH_SECRET + the kit's paths. */
export function composeEnvText(s, paths, authSecret) {
  const portal = portalPractice(paths)
  const lines = {
    COMPOSE_PROJECT_NAME: s.project,
    ACB_STAGING_PORT: s.port,
    PUBLIC_URL: publicUrl(s),
    AUTH_SECRET: authSecret,
    KIT_DATA_DIR: paths.data,
    KIT_PLUGINS_DIR: paths.plugins,
    KIT_KEK_FILE: paths.kek,
    FAKE_HUBSPOT_PORT: s.fakeHubspotPort,
    FAKE_GOOGLE_PORT: s.fakeGooglePort,
    FAKE_SLACK_PORT: s.fakeSlackPort,
    FAKE_PORTAL_PORT: s.fakePortalPort,
    FAKE_PORTAL_HOST: portal.host,
    FAKE_PORTAL_SERVICE: portal.service,
  }
  return '# Generated by the staging kit (staging/kit.mjs). Local staging only; mode 600.\n' +
    Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
}

/**
 * Create what the kit keeps secret, once (setup is idempotent): AUTH_SECRET, the key broker's
 * KEK and the practice HubSpot key, each a 0600 file under <home>/secrets (0700), and the
 * compose env file (rewritten every time: ports may change). Registers every value with the
 * logger so none is ever printed; reports only which files were created.
 */
export function prepareSecrets(s, paths, logger) {
  ensurePrivateDir(paths.home)
  ensurePrivateDir(paths.secrets)
  const auth = ensureSecretFile(paths.authSecret, newAuthSecret)
  const kek = ensureSecretFile(paths.kek, newKek)
  const hub = ensureSecretFile(paths.fakeHubspotKey, newFakeHubspotKey)
  const portalKey = ensureSecretFile(paths.fakePortalKey, newFakePortalKey)
  for (const x of [auth, kek, hub, portalKey]) logger.addSecret(x.value)
  writePrivateFile(paths.env, composeEnvText(s, paths, auth.value))
  for (const dir of [paths.data, paths.plugins, paths.logs, paths.run, paths.folders, paths.backups]) fs.mkdirSync(dir, { recursive: true })
  const created = [[auth, 'AUTH_SECRET'], [kek, '鍵の金庫の鍵（KEK）'], [hub, '練習用 HubSpot の鍵'], [portalKey, '練習用ポータルの鍵']].filter(([x]) => x.created).map(([, name]) => name)
  if (created.length) logger.log(`新しく作りました（${paths.secrets}、本人だけが読める設定）: ${created.join('・')}`)
  return { created, hubspotKey: hub.value }
}

/**
 * Refuse to delete a folder that is not the kit's: it must hold the kit's marker
 * (secrets/compose.env or built.json) and must not be /, the home folder or a parent of it
 * (ACB_STAGING_HOME could point anywhere).
 */
export function assertKitHome(paths, home = os.homedir()) {
  const h = path.resolve(paths.home)
  const user = path.resolve(home)
  const refuse = why => { throw new Error(`${h} は検証キットのフォルダではないため、消しません（${why}）。`) }
  if (h === path.parse(h).root) refuse('ルート')
  if (h === user || user.startsWith(h + path.sep)) refuse('ホームフォルダかその上')
  if (!fs.existsSync(paths.env) && !fs.existsSync(paths.built)) refuse('キットの印 secrets/compose.env・built.json がない')
}

export function readEnvFile(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// ------------------------------------------------------------------ accounts

export const ACCOUNT_HEADER = '# 検証環境のテスト用アカウント（このパソコンの中だけ）。メール\tパスワード\t役割'

/** email -> { password, role } */
export function parseAccounts(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [email, password, role = ''] = line.split('\t')
    if (email && password) map.set(email, { password, role })
  }
  return map
}

export function formatAccounts(map) {
  return [ACCOUNT_HEADER, ...[...map].map(([email, a]) => [email, a.password, a.role].join('\t'))].join('\n') + '\n'
}

export function loadAccounts(file) {
  return fs.existsSync(file) ? parseAccounts(fs.readFileSync(file, 'utf8')) : new Map()
}

export function saveAccounts(file, map) {
  writePrivateFile(file, formatAccounts(map))
}

// ------------------------------------------------------------------ logging

/**
 * A logger that never prints a registered secret: every message goes through `redact`.
 * `sink` defaults to console.log (tests pass their own).
 */
export function createLogger(sink = (line) => console.log(line)) {
  const secrets = new Set()
  const redact = (text) => {
    let out = String(text)
    for (const s of secrets) if (s) out = out.split(s).join('[secret]')
    return out
  }
  return {
    addSecret(value) { if (typeof value === 'string' && value.length >= 8) secrets.add(value) },
    redact,
    log(...parts) { sink(redact(parts.join(' '))) },
  }
}

// ------------------------------------------------------------------ follow production

/**
 * What to do before starting, given the kit checkout's commit and the production ref's.
 *   remoteSha null + error  → offline: start what is there (or fail when nothing is there).
 *   no local checkout        → clone.
 *   same                     → nothing.
 *   different                → update (back up the database first).
 */
export function decideUpdate({ localSha, remoteSha, error }) {
  if (!remoteSha) {
    return localSha
      ? { action: 'offline', detail: error ?? 'unknown' }
      : { action: 'cannot-start', detail: error ?? 'unknown' }
  }
  if (!/^[0-9a-f]{40}$/.test(remoteSha)) return { action: localSha ? 'offline' : 'cannot-start', detail: 'the remote answered something that is not a commit' }
  if (!localSha) return { action: 'clone', to: remoteSha }
  if (localSha === remoteSha) return { action: 'none' }
  return { action: 'update', from: localSha, to: remoteSha }
}

/** 「11/4」 from an ISO date, in Japan time. */
export function shortJapaneseDate(iso) {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

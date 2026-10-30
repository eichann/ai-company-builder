// What the app puts into the environment of the chat's AI process and of the
// tools a member starts from the app, so their scripts reach the company's API
// keys only through the key broker (.claude/rules/key-broker.md, K6): the
// short-lived token where the SDKs look for a key, and the relay where they
// look for a base URL. Pure: main builds it, agent-env.ts filters with it.
import { BROKER_NO_KEY_PLACEHOLDER, brokerServiceEnvNames, looksLikeBrokerToken } from '../../shared/core/key-broker'
import type { BrokerTokenIssued } from '../../shared/types/key-broker'

/**
 * Per built-in service: the variables its SDKs read (findings §E — Gemini reads
 * GOOGLE_API_KEY before GEMINI_API_KEY, so both get the token), and the path
 * under /api/broker/<service> that is the SDK's base URL (OpenAI's includes /v1).
 * `ACB_<SERVICE>_*` always comes too: the names a script uses when the standard
 * ones are reserved for the agent's own CLI.
 */
export const BROKER_SERVICE_ENV: Readonly<Record<string, { keys: readonly string[]; baseUrl: readonly string[]; suffix: string }>> = {
  gemini: { keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrl: ['GOOGLE_GEMINI_BASE_URL'], suffix: '' },
  openai: { keys: ['OPENAI_API_KEY'], baseUrl: ['OPENAI_BASE_URL'], suffix: '/v1' },
  anthropic: { keys: ['ANTHROPIC_API_KEY'], baseUrl: ['ANTHROPIC_BASE_URL'], suffix: '' },
}

/**
 * `ACB_GEMINI_API_KEY`, `ACB_GEMINI_BASE_URL`, … — also for a company's generic
 * services (K9: `crm` → `ACB_CRM_*`, `case-master` → `ACB_CASE_MASTER_*`),
 * which have no SDK names of their own.
 */
export const acbServiceEnv = brokerServiceEnvNames

/** The relay's root as scripts reach it (also `ACB_BROKER_URL`). */
export const ACB_BROKER_URL = 'ACB_BROKER_URL'

/** Every fixed variable name this module may set (plus `ACB_<SERVICE>_API_KEY` / `_BASE_URL` of any service). */
export const BROKER_ENV_NAMES: readonly string[] = [
  ACB_BROKER_URL,
  ...Object.entries(BROKER_SERVICE_ENV).flatMap(([service, e]) => [...e.keys, ...e.baseUrl, acbServiceEnv(service).key, acbServiceEnv(service).baseUrl]),
]
const NAMES = new Set(BROKER_ENV_NAMES.map(n => n.toUpperCase()))
/** A generic service's names (K9): the services are the company's, so the shape decides. */
const SERVICE_NAME = /^ACB_[A-Z0-9_]+_(API_KEY|BASE_URL)$/i

/**
 * A name the broker owns: only the app's values may pass under it (rule 0 of
 * agent-env.ts), whatever the member's shell holds — also for services the
 * app has not heard of yet (`ACB_CRM_BASE_URL=https://elsewhere` would send
 * the token there).
 */
export function isBrokerEnvName(name: string): boolean {
  return NAMES.has(name.toUpperCase()) || SERVICE_NAME.test(name)
}

/**
 * The variables for one AI process or tool. Services the token covers get the
 * token; services the company has keys for but this member may not use here
 * (`no-key` / `stopped`) get the placeholder, so the relay answers in plain
 * Japanese; services nobody configured get nothing (scripts keep working as
 * before the broker). `reservedServices`: services whose standard names the
 * agent's own CLI reads (Claude Code: anthropic; Codex: openai) — only the
 * `ACB_*` names are set for those, never the standard ones.
 */
export function brokerEnv(serverUrl: string, issued: BrokerTokenIssued | null, reservedServices: readonly string[] = []): Record<string, string> {
  if (!issued || !issued.enabled || !serverUrl) return {}
  const origin = brokerOrigin(serverUrl)
  if (!origin) return {}
  const base = `${origin}/api/broker`
  const env: Record<string, string> = {}
  const put = (service: string, value: string) => {
    const known = BROKER_SERVICE_ENV[service]
    const url = `${base}/${service}${known?.suffix ?? ''}`
    const acb = acbServiceEnv(service)
    env[acb.key] = value
    env[acb.baseUrl] = url
    if (!known || reservedServices.includes(service)) return
    for (const name of known.keys) env[name] = value
    for (const name of known.baseUrl) env[name] = url
  }
  for (const s of issued.unavailable) if (s.reason !== 'unknown-service') put(s.service, BROKER_NO_KEY_PLACEHOLDER)
  if (issued.token) for (const s of issued.services) put(s.service, issued.token)
  if (Object.keys(env).length > 0) env[ACB_BROKER_URL] = base
  return env
}

/** The environment without any broker variable (before a turn's own are added). */
export function withoutBrokerEnv<V extends string | undefined>(env: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [name, value] of Object.entries(env)) if (!isBrokerEnvName(name)) out[name] = value
  return out
}

/** `https://acb.example.com` from the server URL the app uses, or '' when there is none. */
export function brokerOrigin(serverUrl: string): string {
  try { return serverUrl ? new URL(serverUrl).origin : '' } catch { return '' }
}

/**
 * agent-env.ts: may this broker variable pass to an AI process? Only with a
 * value the app sets — a token, the placeholder, or a URL of the relay on the
 * company's own server (`origin`) — so a real key, or a base URL that would
 * send the token elsewhere, from the member's own environment never does.
 */
export function isBrokerEnvValue(name: string, value: string, origin: string): boolean {
  if (!isBrokerEnvName(name)) return false
  if (/(_URL)$/i.test(name)) {
    if (!origin || !(value === `${origin}/api/broker` || value.startsWith(`${origin}/api/broker/`))) return false
    return /^\/api\/broker(\/[a-z0-9_-]+(\/v1)?)?$/.test(value.slice(origin.length))
  }
  return value === BROKER_NO_KEY_PLACEHOLDER || looksLikeBrokerToken(value)
}

/**
 * The member's own Claude Code sign-in, as the official CLI reports it (pure).
 * The app only asks `claude auth status --json` and starts `claude auth login`;
 * the CLI keeps the login itself. The app never reads, stores or relays it
 * (Anthropic's terms for products that run Claude Code; chat-and-agents.md "Signing in").
 */
import { compareCliVersions, parseCliVersion } from './agents/cli-version'

/**
 * The oldest CLI whose `auth status` / `auth login` the app runs. `auth` came in
 * 2.1.41, but before 2.1.317 a short command could leave a half-saved token
 * refresh behind and sign the member out; older CLIs keep today's behaviour.
 */
export const CLAUDE_SIGN_IN_MIN_VERSION = '2.1.317'

/** The kind of account, never the address or organisation name. */
export type ClaudeAccountKind = 'team' | 'enterprise' | 'personal' | 'other'

export interface ClaudeSignIn {
  /**
   * `signed-out` only when the CLI says so plainly; anything the app cannot
   * read (an old CLI, Bedrock, a timeout) is `unknown` and the chat starts as before.
   */
  state: 'signed-in' | 'signed-out' | 'unknown'
  account?: ClaudeAccountKind
}

export const UNKNOWN_SIGN_IN: ClaudeSignIn = { state: 'unknown' }

/** Reads `claude auth status --json`; keeps only the state and the account kind. */
export function readClaudeAuthStatus(stdout: string): ClaudeSignIn {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return UNKNOWN_SIGN_IN
  let parsed: unknown
  try { parsed = JSON.parse(stdout.slice(start, end + 1)) } catch { return UNKNOWN_SIGN_IN }
  if (!parsed || typeof parsed !== 'object') return UNKNOWN_SIGN_IN
  const status = parsed as Record<string, unknown>
  if (typeof status.loggedIn !== 'boolean') return UNKNOWN_SIGN_IN
  // Bedrock / Vertex / a gateway sign in elsewhere; the app has nothing to offer there.
  if (status.apiProvider !== undefined && status.apiProvider !== 'firstParty') return UNKNOWN_SIGN_IN
  if (!status.loggedIn) return { state: 'signed-out' }
  return { state: 'signed-in', account: accountKind(status.authMethod, status.subscriptionType) }
}

function accountKind(method: unknown, subscription: unknown): ClaudeAccountKind {
  if (method !== 'claude.ai') return 'other'
  if (subscription === 'team') return 'team'
  if (subscription === 'enterprise') return 'enterprise'
  if (subscription === 'pro' || subscription === 'max' || subscription === 'free') return 'personal'
  return 'other'
}

/** Is this `claude --version` output new enough for the app to check or start a sign-in? */
export function claudeSignInSupported(versionOutput: string): boolean {
  const version = parseCliVersion(versionOutput)
  const floor = parseCliVersion(CLAUDE_SIGN_IN_MIN_VERSION)
  return !!version && !!floor && compareCliVersions(version, floor) >= 0
}

/**
 * The sign-in page the CLI printed for a browser that did not open, only when it
 * is Anthropic's own page. The address stays in main: the renderer can only ask
 * main to open it again.
 */
export function signInPageUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let url: URL
    try { url = new URL(match[0]) } catch { continue }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) continue
    const host = url.hostname.toLowerCase()
    if (SIGN_IN_HOSTS.has(host)) return url.toString()
  }
  return undefined
}

const SIGN_IN_HOSTS = new Set(['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com'])

export type ClaudeSignInOutcome =
  | 'signed-in'
  | 'cancelled'
  | 'timed-out'
  | 'failed'
  | 'still-signed-out'
  | 'not-installed'
  | 'outdated'

export interface ClaudeSignInResult {
  outcome: ClaudeSignInOutcome
  message: string
  signIn?: ClaudeSignIn
}

/** One plain-Japanese sentence per outcome, each saying what to do next. */
export function claudeSignInMessage(outcome: ClaudeSignInOutcome): string {
  switch (outcome) {
    case 'signed-in': return 'Claude にログインできました。'
    case 'cancelled': return 'ログインを途中でやめました。もう一度「Claude にログインする」を押すと、やり直せます。'
    case 'timed-out': return 'ログインが終わらないまま時間がたったため、いったん止めました。インターネットにつながっているか確かめてから、もう一度お試しください。'
    case 'failed': return 'ログインできませんでした。インターネットにつながっているか確かめてから、もう一度お試しください。'
    case 'still-signed-out': return 'ブラウザでのログインが終わっていないようです。もう一度「Claude にログインする」を押してください。'
    case 'not-installed': return 'このパソコンに Claude Code が見つかりません。入れてから「もう一度確かめる」を押してください。'
    case 'outdated': return 'このパソコンの Claude Code が古いため、アプリからログインできません。Claude Code を新しくしてから、もう一度お試しください。'
  }
}

/** A notice for an account that is not the company's kind; never blocks the chat. */
export function claudeAccountNotice(signIn: ClaudeSignIn | undefined): string | undefined {
  if (signIn?.state !== 'signed-in' || signIn.account !== 'personal') return undefined
  return '個人の Claude のアカウントでログインしているようです。会社の仕事には、会社から渡された Team のアカウントを使ってください。'
}

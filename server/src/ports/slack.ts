/**
 * The Slack connection's storage (stage 3 A2, `.claude/rules/slack-connector.md`):
 * the company's Slack app (one per company), which Slack account a signed-in
 * member turned out to be, the event ids already received (Slack retries),
 * and the history. Every method is limited to one company (`forCompany`).
 * Members' grants and pending starts are the provider-neutral
 * `ConnectorRepository` (`member-oauth.md`, provider `slack`).
 *
 * Secrets are passed and returned only sealed; no message body is ever stored.
 */
import type { SealedSecret } from './secret-cipher'

export interface SlackAppRow {
  /** The Slack workspace (`T…`): only this workspace's accounts and events count. */
  teamId: string
  clientId: string
  clientSecretLast4: string
  /** The bot's own Slack user (`U…`), from the admin's install; null before a bot token. */
  botUserId: string | null
  hasBotToken: boolean
  enabled: boolean
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

/** Which secret of the app. */
export type SlackAppSecret = 'client-secret' | 'signing-secret' | 'bot-token'

export interface SlackChangeRow {
  id: string
  action: string
  userId: string | null
  at: string
  by: string
  /** JSON without any secret. */
  change: string
}

export interface SlackRepository {
  app(): SlackAppRow | null
  secret(which: SlackAppSecret): SealedSecret | null
  /**
   * Insert or replace the app. A secret left out (undefined) keeps the stored
   * one; the client and signing secrets are required the first time.
   */
  saveApp(row: { teamId: string; clientId: string; botUserId: string | null; at: string; by: string },
    secrets: { clientSecret?: { sealed: SealedSecret; last4: string }; signingSecret?: SealedSecret; botToken?: SealedSecret | null },
    change: SlackChangeRow): void
  setEnabled(enabled: boolean, at: string, by: string, change: SlackChangeRow): void

  /** Which Slack user an address signed in as (written when a member's 「Slack で許可」 is checked). */
  rememberAccount(slackUserId: string, email: string, at: string): void
  /** The address a Slack user signed in with (lower case), null when unknown. */
  emailOfSlackUser(slackUserId: string): string | null
  /** The Slack user that signed in with this address (lower case), null when unknown. */
  slackUserOfEmail(email: string): string | null

  /** True the first time this event id arrives (it is remembered); false for Slack's retries. */
  firstSeen(eventId: string, at: string): boolean
  /** Forget event ids received before `before`. */
  pruneSeen(before: string): void

  history(limit: number): SlackChangeRow[]
}

export interface SlackDataSource {
  forCompany(companyId: string): SlackRepository
}

/** HMAC-SHA256 for Slack's request signatures (an adapter: Node's crypto). */
export interface HmacSigner {
  /** Lower-case hex. */
  sha256Hex(key: string, message: string): string
  /** Constant-time comparison of two strings. */
  same(a: string, b: string): boolean
}

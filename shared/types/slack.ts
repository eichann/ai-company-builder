/**
 * The Slack connection's API contract (stage 3 A3, `.claude/rules/slack-connector.md`).
 * No shape here ever carries a client secret, a signing secret, a bot or user
 * token, or a code.
 */
import type { SlackFeature } from '../core/slack'

export type { SlackFeature } from '../core/slack'

export type SlackUnavailableReason = 'operator-stopped' | 'not-configured' | 'off' | 'vault-off'

/** active: usable; revoked: Slack, an app change or the member ended it; stopped: an admin or 「すべての鍵を止める」. */
export type SlackGrantStatus = 'active' | 'revoked' | 'stopped'

/** One member's Slack permission, as the admin sees it. */
export interface SlackGrantSummary {
  userId: string
  /** The member's ACB account, null when the account is gone. */
  memberEmail: string | null
  /** The Slack account's address (the member's own ACB email by rule). */
  slackEmail: string
  /** read = 自分あての DM とメンションを読む, reply = 返事を送る, notices = 大事な知らせを DM で受け取る. */
  features: SlackFeature[]
  /** Allowed features the member turned off themselves. */
  featuresOff: SlackFeature[]
  status: SlackGrantStatus
  lastUsedAt: string | null
}

/** `GET /api/companies/:id/slack` (owner / admin): the company's Slack app. */
export interface SlackAdminView {
  vaultEnabled: boolean
  configured: boolean
  /** The workspace (`T…`). */
  teamId: string | null
  clientId: string | null
  clientSecretLast4: string | null
  hasBotToken: boolean
  enabled: boolean
  operatorStopped: boolean
  /** The practice Slack is on (staging): only practice values are saved. */
  practice: boolean
  /** Where Slack sends the browser back (registered in the company's Slack app). */
  redirectUri: string
  /** Where Slack sends events (fixed: registered in the company's Slack app). */
  eventsUrl: string
  grants: SlackGrantSummary[]
  history: Array<{ id: string; action: string; at: string; by: string; userId: string | null; detail: Record<string, unknown> }>
}

/** `PUT /api/companies/:id/slack/app`: secrets are sent once (left out = kept), never answered. */
export interface SlackAppSave {
  teamId: string
  clientId: string
  clientSecret?: string
  signingSecret?: string
  /** The bot's token (`xoxb-…`): checked with Slack, must be of the same workspace. */
  botToken?: string
}

/** `GET /api/companies/:id/me/slack` (any member): their own permission. */
export interface MySlack {
  available: boolean
  reason: SlackUnavailableReason | null
  connected: boolean
  status: SlackGrantStatus | null
  features: SlackFeature[]
  featuresOff: SlackFeature[]
  practice: boolean
}

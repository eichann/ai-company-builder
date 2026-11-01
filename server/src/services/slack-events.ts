/**
 * Slack's events for one company (stage 3 A2, `.claude/rules/slack-connector.md`):
 * `POST /api/slack/events/:companyId` (routes/slack.ts) lands here. The URL is
 * fixed — each company registers it in its own Slack app — so it never moves.
 *
 * Order: the company id's shape → **the signature** with that company's own
 * signing secret (within 5 minutes; anything unsigned, signed for another
 * company, or for a company without an app is the same 401) → the body →
 * Slack's URL check (`url_verification`) → the workspace must be the
 * company's → the switches (operator stop, the app on, the vault) → the
 * event id once (Slack retries) → signals.
 *
 * A signal says only that something for a member arrived (a DM, a mention of
 * them, an @channel / @here / @everyone) and where (channel, ts): **the text
 * is read in memory to find mentions and is never stored, logged or passed
 * on**. Only members with an active Slack grant that reads (`read`, not
 * turned off) get one; the Slack user is matched to the member by the account
 * their grant signed in with. Messages by bots and edits are left out.
 *
 * Not wired yet: A3 mounts the route, B2 consumes the signals (来た連絡).
 */
import type { CompanyDataSource } from '../ports/company-data'
import type { Clock } from '../ports/clock'
import type { SlackDataSource } from '../ports/slack'
import { slackFeaturesOf, type SlackClient } from './slack-client'

/** Slack ends a request after 3 s and the body is small; anything bigger is not Slack. */
export const SLACK_EVENT_MAX_BYTES = 1024 * 1024
const SEEN_KEEP_MS = 24 * 60 * 60 * 1000
const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const SLACK_USER_RE = /^[UW][A-Z0-9]{2,32}$/
/** Message subtypes that are a person's new message (others: edits, joins, bots…). */
const NEW_MESSAGE_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share'])
const BROADCAST_RE = /<!(channel|here|everyone)(\|[^>]*)?>/

export type SlackSignalKind = 'dm' | 'mention' | 'broadcast'

/** Something for a member arrived in Slack. Never the text. */
export interface SlackSignal {
  companyId: string
  userId: string
  kind: SlackSignalKind
  channelId: string
  ts: string
  threadTs: string | null
  /** The sender's Slack user id (to match a person later), null when Slack gave none. */
  senderSlackUserId: string | null
  /** From a channel shared with another organisation (Slack Connect) or a sender of another workspace: an outside message. */
  external: boolean
}

export type SlackEventAnswer =
  | { status: 200; json?: { challenge: string } }
  | { status: 400 | 401 | 413 }

export interface SlackEventsDeps {
  companyData: CompanyDataSource
  slackData: SlackDataSource
  slack: SlackClient
  clock: Clock
  isMember(companyId: string, userId: string): boolean
  operatorStopped(): Promise<boolean>
  vaultEnabled(): boolean
  /** Where signals go (B2's 来た連絡). Must return quickly: Slack waits at most 3 s. */
  onSignal(signal: SlackSignal): void
  /** Warnings (reason codes and ids only); default console. */
  log?: Pick<Console, 'warn'>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 200 ? v : null)

export function createSlackEvents(deps: SlackEventsDeps) {
  const log = deps.log ?? console

  /** The member a Slack user is, in this company: only through an active grant that reads. */
  function memberOf(companyId: string, slackUserId: string): string | null {
    if (!SLACK_USER_RE.test(slackUserId)) return null
    const email = deps.slackData.forCompany(companyId).emailOfSlackUser(slackUserId)
    if (!email) return null
    const grant = deps.companyData.forCompany(companyId).connectors.grants('slack')
      .find(g => g.status === 'active' && g.accountEmail === email)
    if (!grant) return null
    if (!slackFeaturesOf(grant.scopes).includes('read') || grant.featuresOff.includes('read')) return null
    return deps.isMember(companyId, grant.userId) ? grant.userId : null
  }

  function signalsOf(companyId: string, teamId: string, envelope: Record<string, unknown>): SlackSignal[] {
    const event = isObj(envelope.event) ? envelope.event : null
    if (!event || event.type !== 'message') return []
    if (!NEW_MESSAGE_SUBTYPES.has(event.subtype as string | undefined) || event.bot_id !== undefined) return []
    const channelId = str(event.channel)
    const ts = str(event.ts)
    if (!channelId || !ts) return []
    const sender = str(event.user)
    const text = typeof event.text === 'string' ? event.text : ''
    const external = event.is_ext_shared_channel === true || (typeof event.user_team === 'string' && event.user_team !== teamId)
    const base = { companyId, channelId, ts, threadTs: str(event.thread_ts), senderSlackUserId: sender, external }

    // Who the event was delivered for (the members whose user grant subscribed): DMs and broadcasts.
    const authorized = (Array.isArray(envelope.authorizations) ? envelope.authorizations : [])
      .filter(isObj).filter(a => a.is_bot !== true && a.team_id === teamId).map(a => str(a.user_id)).filter((u): u is string => !!u)
    const mentioned = [...text.matchAll(/<@([UW][A-Z0-9]{2,32})(\|[^>]*)?>/g)].map(m => m[1])
    const broadcast = BROADCAST_RE.test(text)
    const isDm = event.channel_type === 'im'

    const kinds = new Map<string, SlackSignalKind>()
    const offer = (slackUser: string, kind: SlackSignalKind) => {
      if (slackUser === sender || kinds.has(slackUser)) return
      kinds.set(slackUser, kind)
    }
    if (isDm) for (const u of authorized) offer(u, 'dm')
    for (const u of mentioned) offer(u, 'mention')
    if (broadcast) for (const u of authorized) offer(u, 'broadcast')

    const out: SlackSignal[] = []
    const members = new Set<string>()
    for (const [slackUser, kind] of kinds) {
      const userId = memberOf(companyId, slackUser)
      if (!userId || members.has(userId)) continue
      members.add(userId)
      out.push({ ...base, userId, kind })
    }
    return out
  }

  return {
    async receive(companyId: string, headers: { timestamp?: string; signature?: string }, rawBody: string): Promise<SlackEventAnswer> {
      if (!COMPANY_ID_RE.test(companyId)) return { status: 401 }
      if (rawBody.length > SLACK_EVENT_MAX_BYTES) return { status: 413 }
      if (!await deps.slack.verifySignature(companyId, headers.timestamp, headers.signature, rawBody)) return { status: 401 }

      let envelope: unknown
      try { envelope = JSON.parse(rawBody) } catch { return { status: 400 } }
      if (!isObj(envelope)) return { status: 400 }
      if (envelope.type === 'url_verification') {
        const challenge = str(envelope.challenge)
        return challenge ? { status: 200, json: { challenge } } : { status: 400 }
      }
      if (envelope.type !== 'event_callback') return { status: 200 }

      const store = deps.slackData.forCompany(companyId)
      const app = store.app()
      // Signed with this company's secret but about another workspace: not this company's.
      if (!app || envelope.team_id !== app.teamId) {
        log.warn(`[slack] event for another workspace ignored company=${companyId}`)
        return { status: 200 }
      }
      // A stop answers 200 too: Slack would otherwise keep re-sending what is dropped on purpose.
      if (!app.enabled || await deps.operatorStopped() || !deps.vaultEnabled()) return { status: 200 }
      const eventId = str(envelope.event_id)
      if (!eventId) return { status: 200 }
      const now = deps.clock.now()
      if (!store.firstSeen(eventId, now)) return { status: 200 }
      store.pruneSeen(new Date(deps.clock.nowMs() - SEEN_KEEP_MS).toISOString())

      for (const signal of signalsOf(companyId, app.teamId, envelope)) {
        try {
          deps.onSignal(signal)
        } catch {
          log.warn(`[slack] a signal could not be handed on company=${companyId}`)
        }
      }
      return { status: 200 }
    },
  }
}

export type SlackEvents = ReturnType<typeof createSlackEvents>

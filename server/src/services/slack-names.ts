/**
 * Slack users' display names (`.claude/rules/slack-connector.md` "Names"): one
 * `users.info` per company and Slack user, kept in memory for a day. Used when
 * a signal arrives (the sender's name goes on the 来た連絡, like a mail
 * sender's name) and when a thread is read (authors and `<@U…>` mentions).
 *
 * Only the name is kept — never a message text, an address or anything else
 * of the profile — and only in this process (a restart forgets it). Looked up
 * with the member's own token (`users:read` comes with every Slack grant),
 * else the company's bot. A failed lookup is not cached (asked again next time).
 */
import type { Clock } from '../ports/clock'
import type { SlackClient, SlackResult } from './slack-client'

export const SLACK_NAME_TTL_MS = 24 * 60 * 60 * 1000
/** The most names kept at once (all companies); the oldest goes first. */
const CACHE_MAX = 5_000
const NAME_MAX = 100
const USER_RE = /^[UW][A-Z0-9]{2,30}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The name Slack shows for a user: display name, else real name, else the handle. */
export function slackUserName(r: SlackResult): string | null {
  const user = r.ok && isObj(r.json.user) ? r.json.user : null
  if (!user) return null
  const profile = isObj(user.profile) ? user.profile : {}
  const name = [profile.display_name, profile.real_name, user.real_name, user.name]
    .find(n => typeof n === 'string' && n.trim() !== '') as string | undefined
  // eslint-disable-next-line no-control-regex
  return name ? name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NAME_MAX) : null
}

export interface SlackNamesDeps {
  slack: Pick<SlackClient, 'userCall' | 'botCall'>
  clock: Pick<Clock, 'nowMs'>
}

export function createSlackNames(deps: SlackNamesDeps) {
  const cache = new Map<string, { name: string; at: number }>()

  return {
    /** The cached name, without asking Slack (null: not known now). */
    cached(companyId: string, slackUserId: string): string | null {
      const hit = cache.get(`${companyId}\n${slackUserId}`)
      return hit && deps.clock.nowMs() - hit.at < SLACK_NAME_TTL_MS ? hit.name : null
    },

    /**
     * The Slack user's name in this company's workspace; `asMember`: the member whose token asks
     * (else, or when theirs cannot, the company's bot). Null when Slack would not say.
     */
    async nameOf(companyId: string, slackUserId: string, asMember: string | null): Promise<string | null> {
      if (!USER_RE.test(slackUserId)) return null
      const key = `${companyId}\n${slackUserId}`
      const now = deps.clock.nowMs()
      const hit = cache.get(key)
      if (hit && now - hit.at < SLACK_NAME_TTL_MS) return hit.name
      const req = { method: 'users.info', params: { user: slackUserId }, write: false, operation: 'users.info' }
      let name = asMember ? slackUserName(await deps.slack.userCall(companyId, asMember, { ...req, scope: 'users:read' })) : null
      if (name === null) name = slackUserName(await deps.slack.botCall(companyId, asMember, req))
      if (name === null) return null
      cache.delete(key)
      cache.set(key, { name, at: now })
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
      return name
    },
  }
}

export type SlackNames = ReturnType<typeof createSlackNames>

/**
 * Slack's 本人が送った文を読む (`sent_samples` of the role チャットの連絡を受け取る・返す; ports/sent-samples.ts): the
 * member's newest own Slack messages, each with whether it went to people of the company's workspace (身内) or not (よそ:
 * a Slack Connect channel or DM), and whether a chat thread's other side is of the workspace.
 *
 * **No new permission**: only the member's own 自分あての DM とメンションを読む (`read`: the four `*:history` scopes, granted
 * and not turned off) while their 受信を読む is on — the same switches that let ACB take their DMs and mentions in. That
 * permission cannot list the member's conversations (no `*:read` scope) or search (no `search:read`), so the places read
 * are the ones ACB already knows are the member's own: the DMs and threads of the messages the inbox took in for them
 * (`recentRefs`, newest first; pointers only). Each place is read once, at most `READS_MAX` calls per making:
 *   - a DM (`D…`): `conversations.history`, a year back, the newest `HISTORY_LIMIT`;
 *   - any other place: that message's thread (`conversations.replies`).
 * Of what is read only the member's own messages are kept (not a bot's, not an edit or join notice); the others' are
 * looked at in memory only for their workspace (`user_team` / `team`). A place where no one else's workspace shows is
 * left out (neither 身内 nor よそ can be told).
 *
 * Nothing is stored and nothing of a message is logged (slack-client.ts records the method name only).
 */
import { WRITING_SAMPLE_TEXT_MAX, type WritingAudience, type WritingSample } from '../../shared/core/writing-style'
import type { CompanyDataSource } from '../ports/company-data'
import type { SentSamplesReader, SentSamplesRead, ThreadParty } from '../ports/sent-samples'
import type { SlackDataSource } from '../ports/slack'
import type { SlackClient, SlackResult } from './slack-client'
import { slackFeaturesOf } from './slack-client'
import { historyScope, SLACK_CHANNEL_RE, SLACK_TS_RE, slackPlainText, slackTeamOf } from './slack-chat'

/** How far back a DM is read (a year: someone who rarely writes still has some). */
export const SLACK_SAMPLES_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000
/** At most this many Slack calls for one making. */
export const SLACK_SAMPLES_READS_MAX = 12
/** The newest messages of a DM looked at. */
const HISTORY_LIMIT = 100
/** The inbox's pointers looked at (newest first) to find the places. */
export const SLACK_SAMPLES_REFS_MAX = 200

const USER_RE = /^[UW][A-Z0-9]{2,30}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SlackWritingDeps {
  slack: Pick<SlackClient, 'userCall'>
  companyData: CompanyDataSource
  slackData: SlackDataSource
  /** The member's own 受信を読む within the company's (services/work-switches.ts). */
  readsIncoming(companyId: string, userId: string): boolean
  nowMs(): number
}

/** `slack:<channel>:<ts>` (composition/inbox.ts `slackSignalMessage`) → its parts; null for anything else. */
export function parseSlackRef(ref: string): { channel: string; ts: string } | null {
  const m = /^slack:([^:]+):([^:]+)$/.exec(ref)
  return m && SLACK_CHANNEL_RE.test(m[1]) && SLACK_TS_RE.test(m[2]) ? { channel: m[1], ts: m[2] } : null
}

/**
 * よそ when anyone else's workspace is another; 身内 only when everyone else is known to be of the company's; null when
 * no one else shows or someone's workspace is not given (left out: never a guess).
 */
export function slackAudienceOf(teams: readonly (string | null)[], teamId: string): WritingAudience | null {
  if (teams.length === 0) return null
  if (teams.some(t => t !== null && t !== teamId)) return 'outside'
  return teams.every(t => t === teamId) ? 'inside' : null
}

type Failure = Extract<SentSamplesRead, { ok: false }>['reason']

/** A refusal that ends the making (the permission went) or only skips the place (gone, left). */
function failureOf(r: Extract<SlackResult, { ok: false }>): Failure | 'skip' {
  if (r.kind === 'not-sent') return ['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted', 'feature-off', 'not-member'].includes(r.reason) ? 'not-allowed' : 'unavailable'
  if (r.kind === 'refused' && ['channel_not_found', 'thread_not_found', 'not_in_channel', 'message_not_found', 'is_archived'].includes(r.slackError ?? '')) return 'skip'
  if (r.kind === 'refused' && ['invalid_auth', 'token_revoked', 'missing_scope', 'not_authed', 'account_inactive'].includes(r.slackError ?? '')) return 'not-allowed'
  return 'unavailable'
}

export function createSlackSentSamples(deps: SlackWritingDeps): SentSamplesReader {
  /** The member's Slack account and the company's workspace, while their 読む and 受信を読む are on. */
  function reading(companyId: string, userId: string): { me: string; teamId: string } | null {
    if (!deps.readsIncoming(companyId, userId)) return null
    const grant = deps.companyData.forCompany(companyId).connectors.grant('slack', userId)
    if (!grant || grant.status !== 'active' || !slackFeaturesOf(grant.scopes).includes('read') || grant.featuresOff.includes('read')) return null
    const slackData = deps.slackData.forCompany(companyId)
    const app = slackData.app()
    const me = slackData.slackUserOfEmail(grant.accountEmail)
    if (!app || !app.enabled || !me) return null
    return { me, teamId: app.teamId }
  }

  return {
    async readable(companyId, userId) {
      return reading(companyId, userId) !== null
    },

    async recentSent(companyId, userId, max) {
      const who = reading(companyId, userId)
      if (!who) return { ok: false, reason: 'not-allowed' }
      const oldest = String(Math.floor((deps.nowMs() - SLACK_SAMPLES_LOOKBACK_MS) / 1000))
      const refs = deps.companyData.forCompany(companyId).inbox.recentSourceRefs(userId, 'chat', SLACK_SAMPLES_REFS_MAX)
      const readChannels = new Set<string>()
      const seenTs = new Set<string>()
      const found: Array<WritingSample & { ts: number }> = []
      const taken = new Set<string>()
      let reads = 0
      for (const raw of refs) {
        if (reads >= SLACK_SAMPLES_READS_MAX) break
        const ref = parseSlackRef(raw)
        if (!ref) continue
        const dm = ref.channel.startsWith('D')
        if (dm ? readChannels.has(ref.channel) : seenTs.has(`${ref.channel}:${ref.ts}`)) continue
        if (dm) readChannels.add(ref.channel)
        reads++
        const r = await deps.slack.userCall(companyId, userId, dm
          ? { method: 'conversations.history', params: { channel: ref.channel, limit: String(HISTORY_LIMIT), oldest }, write: false, operation: 'conversations.history', scope: historyScope(ref.channel) }
          : { method: 'conversations.replies', params: { channel: ref.channel, ts: ref.ts, limit: '200', oldest }, write: false, operation: 'conversations.replies', scope: historyScope(ref.channel) })
        if (!r.ok) {
          const f = failureOf(r)
          if (f === 'skip') continue
          return { ok: false, reason: f }
        }
        const messages = (Array.isArray(r.json.messages) ? r.json.messages : []).filter(isObj)
          .filter(m => typeof m.ts === 'string' && SLACK_TS_RE.test(m.ts))
        for (const m of messages) seenTs.add(`${ref.channel}:${m.ts as string}`)
        const person = (m: Record<string, unknown>) => typeof m.user === 'string' && USER_RE.test(m.user) && m.bot_id === undefined
        // Edits, joins, files without words…: only a plain message (or one also sent to the channel) is how they write.
        const plain = (m: Record<string, unknown>) => m.subtype === undefined || m.subtype === 'thread_broadcast'
        const others = messages.filter(m => person(m) && m.user !== who.me)
        const audience = slackAudienceOf(others.map(m => slackTeamOf(m)), who.teamId)
        if (!audience) continue
        for (const m of messages) {
          if (!person(m) || m.user !== who.me || !plain(m) || typeof m.text !== 'string') continue
          // Mentions become 「@Slack の人」 (no name is looked up: a name is no habit).
          const text = Array.from(slackPlainText(m.text, new Map()).replace(/\r\n?/g, '\n').normalize('NFC').trim()).slice(0, WRITING_SAMPLE_TEXT_MAX).join('')
          if (Array.from(text).length < 2) continue
          const seconds = Number(m.ts)
          if (taken.has(`${ref.channel}:${m.ts as string}`)) continue
          taken.add(`${ref.channel}:${m.ts as string}`)
          found.push({ text, at: new Date(Math.floor(seconds * 1000)).toISOString(), audience, ts: seconds })
        }
      }
      found.sort((a, b) => b.ts - a.ts)
      return { ok: true, samples: found.slice(0, max).map(({ text, at, audience }) => ({ text, at, audience })) }
    },

    audienceOf(_companyId, _userId, thread: readonly ThreadParty[]) {
      const others = thread.filter(m => !m.mine)
      if (others.length === 0) return null
      if (others.some(m => m.external === true)) return 'outside'
      return others.every(m => m.external === false) ? 'inside' : null
    },
  }
}

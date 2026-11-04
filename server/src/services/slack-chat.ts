/**
 * Slack as the core role チャットの連絡を受け取る・返す (`ports/chat.ts`,
 * `.claude/rules/slack-connector.md` "Threads and replies"), on demand and
 * with the member's own user token (`slack-client.ts` `userCall`, which
 * re-checks every switch on every call):
 *
 * - `thread`: one thread (`conversations.replies`) the member can see — only
 *   while their 自分あての DM とメンションを読む (`read`) is granted and not
 *   turned off. The newest messages, each cut at a length; names through
 *   `users.info` (a few per thread, cached a day: slack-names.ts). Slack's
 *   markup becomes plain text (`slackPlainText`: `<@U…>` → `@name`, links →
 *   their label, `&lt;` → `<`); the app draws it as text, never as HTML.
 *   Nothing is stored; no text or name is logged (the client records the
 *   method name only).
 * - `reply`: `chat.postMessage` with `thread_ts`, as the member — only while
 *   返事を送る (`reply`) is granted and not turned off. Never retried: a
 *   lost answer is `unknown`.
 */
import type { ChatMessage, ChatReader, ChatReplierAccount, ChatSender, ChatSendResult, ChatThreadRef } from '../ports/chat'
import type { CompanyDataSource } from '../ports/company-data'
import type { SlackDataSource } from '../ports/slack'
import type { SlackClient, SlackFeature, SlackResult } from './slack-client'
import { SLACK_FEATURE_SCOPES, slackFeaturesOf } from './slack-client'
import type { SlackNames } from './slack-names'

/** At most this many of a thread's newest messages, each at most this long, names for this many senders. */
export const SLACK_THREAD_MESSAGES_MAX = 30
export const SLACK_THREAD_TEXT_MAX = 8_000
const NAMES_MAX = 10
/** Slack's own limit is 40,000; a reply from ACB is a short message. */
export const SLACK_REPLY_MAX = 4_000

export const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,30}$/
export const SLACK_TS_RE = /^\d{9,11}\.\d{1,6}$/
const USER_RE = /^[UW][A-Z0-9]{2,30}$/
const MENTION_RE = /<@([UW][A-Z0-9]{2,30})(?:\|([^>]*))?>/g
/** Slack's own word for a person not looked up (more than the per-thread lookups, or Slack would not say). */
const UNKNOWN_PERSON = 'Slack の人'
const TRUNCATED = '\n【長いため、ここから先は省きました】'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SlackChatDeps {
  slack: Pick<SlackClient, 'userCall'>
  companyData: CompanyDataSource
  slackData: SlackDataSource
  names: Pick<SlackNames, 'nameOf'>
}

/**
 * A Slack message's text as plain text (https://api.slack.com/reference/surfaces/formatting):
 * `<@U…>` → `@<name>` (from `names`, else its own label, else 「Slack の人」), `<#C…|general>` →
 * `#general`, `<!channel>` / `<!here>` / `<!everyone>` → `@channel` / `@here` / `@everyone`,
 * `<!subteam^S…|@team>` and `<!date^…|fallback>` → their label, `<url|label>` → the label,
 * `<url>` → the url; then Slack's three escapes (`&lt;` `&gt;` `&amp;`) are undone. The result is
 * only ever drawn as text (`*bold*` stays for the app to draw: client/shared/threads.ts).
 */
export function slackPlainText(text: string, names: ReadonlyMap<string, string | null>): string {
  return text
    .replace(/<([^<>]*)>/g, (_all, inner: string) => {
      const bar = inner.indexOf('|')
      const target = bar === -1 ? inner : inner.slice(0, bar)
      const label = bar === -1 ? '' : inner.slice(bar + 1)
      if (target.startsWith('@')) {
        const id = target.slice(1)
        return `@${names.get(id) ?? (label.replace(/^@/, '') || UNKNOWN_PERSON)}`
      }
      if (target.startsWith('#')) return `#${label || 'チャンネル'}`
      if (target.startsWith('!')) {
        const special = target.slice(1)
        if (special === 'channel' || special === 'here' || special === 'everyone') return `@${special}`
        return label || `@${special.split('^')[0]}`
      }
      return label || target.replace(/^mailto:/, '')
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export const isSlackThreadRef = (r: ChatThreadRef) => SLACK_CHANNEL_RE.test(r.channelId) && SLACK_TS_RE.test(r.threadTs)

/** The history scope that reads this kind of channel (all four come with `read`). */
function historyScope(channelId: string): string {
  if (channelId.startsWith('D')) return 'im:history'
  if (channelId.startsWith('G')) return 'mpim:history'
  return 'channels:history'
}

function cut(text: string, max: number): { text: string; truncated: boolean } {
  const t = text.replace(/\r\n?/g, '\n').normalize('NFC')
  if (t.length <= max) return { text: t, truncated: false }
  return { text: `${t.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd()}${TRUNCATED}`, truncated: true }
}

export function createSlackChat(deps: SlackChatDeps): ChatReader & ChatSender {
  /** The member's active grant with the feature granted and on, or why not. */
  function featureState(companyId: string, userId: string, feature: SlackFeature): { ok: true; account: string } | { ok: false; reason: 'consent-needed' | 'turned-off' } {
    const grant = deps.companyData.forCompany(companyId).connectors.grant('slack', userId)
    if (!grant || grant.status !== 'active' || !slackFeaturesOf(grant.scopes).includes(feature)) return { ok: false, reason: 'consent-needed' }
    if (grant.featuresOff.includes(feature)) return { ok: false, reason: 'turned-off' }
    return { ok: true, account: grant.accountEmail }
  }

  const readReason = (r: Extract<SlackResult, { ok: false }>) => {
    if (r.kind === 'not-sent') {
      if (['no-grant', 'grant-revoked', 'grant-stopped', 'scope-not-granted'].includes(r.reason)) return 'not-connected' as const
      if (r.reason === 'feature-off') return 'turned-off' as const
      return 'stopped' as const
    }
    if (r.kind === 'refused' && ['channel_not_found', 'thread_not_found', 'not_in_channel', 'message_not_found'].includes(r.slackError ?? '')) return 'not-found' as const
    if (r.kind === 'refused' && ['invalid_auth', 'token_revoked', 'missing_scope', 'not_authed'].includes(r.slackError ?? '')) return 'not-connected' as const
    return 'unavailable' as const
  }

  return {
    async thread(companyId, userId, ref) {
      if (!isSlackThreadRef(ref)) return { ok: false, reason: 'not-found' }
      const allowed = featureState(companyId, userId, 'read')
      if (!allowed.ok) return { ok: false, reason: allowed.reason === 'turned-off' ? 'turned-off' : 'not-connected' }
      const r = await deps.slack.userCall(companyId, userId, {
        method: 'conversations.replies', params: { channel: ref.channelId, ts: ref.threadTs, limit: '200' },
        write: false, operation: 'conversations.replies', scope: historyScope(ref.channelId),
      })
      if (!r.ok) return { ok: false, reason: readReason(r) }
      const me = deps.slackData.forCompany(companyId).slackUserOfEmail(allowed.account)
      const raw = (Array.isArray(r.json.messages) ? r.json.messages : [])
        .filter(isObj)
        .filter(m => typeof m.ts === 'string' && SLACK_TS_RE.test(m.ts) && typeof m.text === 'string')
      const kept = raw.slice(-SLACK_THREAD_MESSAGES_MAX)
      // Names of the senders, then of the people mentioned (a few per thread; an unknown one stays
      // null: the app says 「Slack の人」 for a sender, the text 「@Slack の人」 for a mention).
      const people: string[] = []
      for (const m of kept) {
        const u = typeof m.user === 'string' && USER_RE.test(m.user) ? m.user : null
        if (u && !people.includes(u)) people.push(u)
      }
      for (const m of kept) {
        for (const [, u] of (m.text as string).matchAll(MENTION_RE)) if (!people.includes(u)) people.push(u)
      }
      const names = new Map<string, string | null>()
      for (const u of people.slice(0, NAMES_MAX)) names.set(u, await deps.names.nameOf(companyId, u, userId))
      const messages: ChatMessage[] = kept.map(m => {
        const authorId = typeof m.user === 'string' && USER_RE.test(m.user) ? m.user : null
        const seconds = Number(m.ts)
        return {
          ts: m.ts as string,
          authorId,
          authorName: authorId ? names.get(authorId) ?? null : null,
          mine: authorId !== null && authorId === me,
          at: Number.isFinite(seconds) ? new Date(Math.floor(seconds * 1000)).toISOString() : null,
          ...cut(slackPlainText(m.text as string, names), SLACK_THREAD_TEXT_MAX),
        }
      })
      return { ok: true, value: { ref, messages, more: raw.length > kept.length || (isObj(r.json) && r.json.has_more === true) } }
    },

    async replierAccount(companyId, userId): Promise<ChatReplierAccount> {
      return featureState(companyId, userId, 'reply')
    },

    async reply(companyId, userId, ref, text): Promise<ChatSendResult> {
      if (!isSlackThreadRef(ref)) return { ok: false, kind: 'not-sent', reason: 'bad-thread' }
      const allowed = featureState(companyId, userId, 'reply')
      if (!allowed.ok) return { ok: false, kind: 'not-sent', reason: allowed.reason === 'turned-off' ? 'feature-off' : 'no-grant' }
      if (text.trim() === '' || text.length > SLACK_REPLY_MAX) return { ok: false, kind: 'not-sent', reason: 'bad-text' }
      const r = await deps.slack.userCall(companyId, userId, {
        method: 'chat.postMessage', params: { channel: ref.channelId, thread_ts: ref.threadTs, text },
        write: true, operation: 'chat.postMessage.reply', scope: SLACK_FEATURE_SCOPES.reply[0],
      })
      if (r.ok) return { ok: true, ts: typeof r.json.ts === 'string' && SLACK_TS_RE.test(r.json.ts) ? r.json.ts : null }
      return { ok: false, kind: r.kind, reason: r.reason, ...(r.status !== undefined ? { status: r.status } : {}) }
    },
  }
}

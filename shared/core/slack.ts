/**
 * The Slack connection's shared rules (stage 3 A2 / A3,
 * `.claude/rules/slack-connector.md`): the member features of a Slack
 * permission, the hosts the server talks to, and the practice values of the
 * fake Slack (staging: `ACB_FAKE_SLACK_URL`). One copy for the server, the
 * admin console and the app.
 *
 * Pure: imports nothing.
 */

/**
 * What a member's 「Slack で許可」 may allow:
 * - `read`    自分あての DM とメンションを読む
 * - `reply`   返事を送る (as the member)
 * - `notices` 大事な知らせを Slack の DM で受け取る (sent by the company's bot;
 *             needs no scope beyond knowing who the member is, so it is on with
 *             any grant until the member turns it off)
 */
export const SLACK_FEATURES = ['read', 'reply', 'notices'] as const
export type SlackFeature = typeof SLACK_FEATURES[number]

/**
 * What 「Slack でつなぐ」 on 「仕事の道具をつなぐ」 asks for (and the settings'
 * first 「Slack で許可」): reading DMs and mentions, and the notice DMs.
 * 返事を送る is added later from the settings, when the member wants it.
 */
export const SLACK_SETUP_FEATURES: readonly SlackFeature[] = ['read', 'notices']

export const isSlackFeature = (v: unknown): v is SlackFeature => (SLACK_FEATURES as readonly unknown[]).includes(v)

/** The one Slack host: the Web API, OAuth and the browser's sign-in page. */
export const SLACK_HOST = 'slack.com'
export const SLACK_HOSTS: readonly string[] = [SLACK_HOST]

/** Where Slack sends the browser back to (relative to the server's public URL). */
export const SLACK_CALLBACK_PATH = '/api/oauth/slack/callback'
/** Where Slack sends a company's events: fixed, each company registers it (relative to the public URL). */
export const slackEventsPath = (companyId: string) => `/api/slack/events/${encodeURIComponent(companyId)}`

/** The fake Slack's values (server/tests/fakes/slack): only these are saved or sent while the practice Slack is on. */
export const PRACTICE_SLACK_CLIENT_SECRET_PREFIX = 'fake-slack-secret-'
export const PRACTICE_SLACK_SIGNING_SECRET_PREFIX = 'fake-slack-signing-'
const PRACTICE_SLACK_PREFIXES = [PRACTICE_SLACK_CLIENT_SECRET_PREFIX, PRACTICE_SLACK_SIGNING_SECRET_PREFIX, 'xoxp-fake-', 'xoxb-fake-', 'fake-slack-code-']

/** A secret, token or code of the fake Slack (a `Bearer ` prefix is ignored). */
export function isPracticeSlackSecret(value: string): boolean {
  const v = value.trim().replace(/^Bearer\s+/i, '')
  return PRACTICE_SLACK_PREFIXES.some(p => v.startsWith(p))
}

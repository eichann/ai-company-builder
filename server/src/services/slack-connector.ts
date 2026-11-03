/**
 * The Slack connection (stage 3 A2, `.claude/rules/slack-connector.md`): the
 * company's Slack app (owner/admin), a member's 「Slack で許可」 and
 * 「許可をやめる」, the stops, and the bot's notice DM. Slack plugs into the
 * provider-neutral services/member-oauth.ts as provider `slack`; every Slack
 * request goes through services/slack-client.ts.
 *
 * Two kinds of permission (plan §5-6, owner decision 2026-11-01):
 * - reading a member's DMs and mentions (and replying as them) uses that
 *   member's own user grant — they allow it themselves, with the Slack account
 *   whose address is their own ACB email, in the company's workspace;
 * - notice DMs are sent by the company's bot (its token is registered by the
 *   admin with the app).
 *
 * Wired in composition/connectors.ts (A3); routes: routes/slack-connection.ts.
 */
import { BUILTIN_CONNECTORS } from '../../shared/core/builtin-connectors'
import { sameEmail } from '../../shared/core/google'
import { isPracticeSlackSecret, PRACTICE_SLACK_CLIENT_SECRET_PREFIX, PRACTICE_SLACK_SIGNING_SECRET_PREFIX, SLACK_SETUP_FEATURES } from '../../shared/core/slack'
import type { MySlack, SlackAdminView, SlackUnavailableReason } from '../../shared/types/slack'
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { RoleConnector } from '../ports/connector-roles'
import type { SlackChangeRow, SlackDataSource } from '../ports/slack'
import { requireFullAccess, type Member } from './access'
import type { BrokerVault } from './broker-vault'
import type { MemberOAuth } from './member-oauth'
import { ok, refuse, type Outcome } from './outcome'
import {
  isSlackFeature, normalizeSlackScopes, slackAppSealContext, slackFeaturesOf, slackScopesFor, SLACK_FEATURES,
  type SlackClient, type SlackFeature, type SlackResult,
} from './slack-client'

export const SLACK_FORBIDDEN = 'Only owners and admins can manage the Slack connection'
const HISTORY_LIMIT = 50
const NOTICE_MAX = 3000

export type { MySlack, SlackAdminView, SlackUnavailableReason } from '../../shared/types/slack'

export interface SlackConnectorDeps {
  companyData: CompanyDataSource
  slackData: SlackDataSource
  brokerVault: BrokerVault
  slack: SlackClient
  memberOAuth: MemberOAuth
  accounts: AccountDirectory
  clock: Clock
  ids: IdGenerator
  /** `<PUBLIC_URL>/api/oauth/slack/callback`, read per call. */
  redirectUri(): string
  /** `<PUBLIC_URL>/api/slack/events/<companyId>`, read per call. */
  eventsUrl(companyId: string): string
  operatorStopped(): Promise<boolean>
  isMember(companyId: string, userId: string): boolean
  /** The practice Slack is on (staging): only practice values are saved (400 `REAL_KEY_ON_PRACTICE`). */
  practiceSlack?: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const TEAM_ID_RE = /^T[A-Z0-9]{2,30}$/
const CLIENT_ID_RE = /^\d{1,20}\.\d{1,20}$/
const SECRET_RE = /^[\x21-\x7e]{16,128}$/
const BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]{8,250}$/

const PAGE = {
  granted: '許可しました。アプリに戻ってください。',
  expired: 'この許可の手続きは使えません（10分を過ぎたか、すでに使われています）。アプリからもう一度「Slack で許可」を押してください。',
  denied: 'Slack で許可されませんでした。許可は保存していません。',
  unavailable: 'いまは Slack とつなげません。管理者に確かめてください。許可は保存していません。',
  failed: 'Slack とのやりとりがうまくいきませんでした。少し待ってから、アプリでもう一度「Slack で許可」を押してください。許可は保存していません。',
  workspace: '会社の Slack のワークスペースで許可してください。許可は保存していません。',
  email: 'ACB に登録しているメールアドレスと同じ Slack アカウントで許可してください。許可は保存していません。',
  noRefresh: 'Slack から必要な情報が届きませんでした。アプリで「許可をやめる」を押してから、もう一度「Slack で許可」を押してください。許可は保存していません。',
}

export function createSlackConnector(deps: SlackConnectorDeps) {
  const { companyData, slackData, brokerVault, slack, memberOAuth, accounts, clock, ids } = deps

  function change(action: string, by: string, userId: string | null, detail: Record<string, unknown>): SlackChangeRow {
    return { id: ids.newId(), action, userId, at: clock.now(), by, change: JSON.stringify(detail) }
  }

  async function unavailableReason(companyId: string): Promise<SlackUnavailableReason | null> {
    if (await deps.operatorStopped()) return 'operator-stopped'
    const app = slackData.forCompany(companyId).app()
    if (!app) return 'not-configured'
    if (!app.enabled) return 'off'
    if (!brokerVault.status().enabled) return 'vault-off'
    return null
  }

  async function view(companyId: string): Promise<SlackAdminView> {
    const store = slackData.forCompany(companyId)
    const app = store.app()
    const grants = companyData.forCompany(companyId).connectors.grants('slack')
    const history = store.history(HISTORY_LIMIT)
    const people = accounts.byIds([...new Set(grants.map(g => g.userId))])
    return {
      vaultEnabled: brokerVault.status().enabled,
      configured: app !== null,
      teamId: app?.teamId ?? null,
      clientId: app?.clientId ?? null,
      clientSecretLast4: app?.clientSecretLast4 ?? null,
      hasBotToken: app?.hasBotToken ?? false,
      enabled: app?.enabled ?? false,
      operatorStopped: await deps.operatorStopped(),
      practice: deps.practiceSlack === true,
      redirectUri: deps.redirectUri(),
      eventsUrl: deps.eventsUrl(companyId),
      grants: grants.map(g => ({
        userId: g.userId, memberEmail: people.get(g.userId)?.email ?? null, slackEmail: g.accountEmail,
        features: slackFeaturesOf(g.scopes), featuresOff: slackFeaturesOf(g.scopes).filter(f => g.featuresOff.includes(f)),
        status: g.status, lastUsedAt: g.lastUsedAt,
      })),
      history: history.map(h => {
        let detail: Record<string, unknown> = {}
        try { detail = JSON.parse(h.change) as Record<string, unknown> } catch { /* shown empty */ }
        return { id: h.id, action: h.action, at: h.at, by: h.by, userId: h.userId, detail }
      }),
    }
  }

  async function myView(member: Member): Promise<MySlack> {
    const grant = companyData.forCompany(member.companyId).connectors.grant('slack', member.userId)
    const reason = await unavailableReason(member.companyId)
    return {
      available: reason === null,
      reason,
      connected: grant?.status === 'active',
      status: grant?.status ?? null,
      features: grant?.status === 'active' ? slackFeaturesOf(grant.scopes) : [],
      featuresOff: grant?.status === 'active' ? slackFeaturesOf(grant.scopes).filter(f => grant.featuresOff.includes(f)) : [],
      practice: deps.practiceSlack === true,
      seen: SLACK_FEATURES.filter(f => companyData.forCompany(member.companyId).connectors.setupSeen('slack', member.userId).includes(f)),
    }
  }

  // Slack as a member-level OAuth provider (member-oauth.ts runs the start, the callback and the stops).
  memberOAuth.register({
    id: 'slack',
    label: 'Slack',
    features: SLACK_FEATURES,
    unavailable: unavailableReason,
    authorizeUrl: params => slack.authorizeUrl(params),
    // Slack's confidential-client exchange: the client secret, not the PKCE verifier.
    exchangeCode: (companyId, code, _verifier, redirectUri) => slack.exchangeCode(companyId, code, redirectUri),
    async identify(companyId, accessToken) {
      const app = slackData.forCompany(companyId).app()
      const who = await slack.identify(accessToken)
      if (!who) return { ok: false, message: PAGE.failed, why: 'no-identity' }
      if (!app || who.teamId !== app.teamId) return { ok: false, message: PAGE.workspace, why: 'other-workspace' }
      if (!who.email) return { ok: false, message: PAGE.email, why: 'no-email' }
      // Remembered with the address it signed in with; it serves only together with
      // an active grant of that address (events, notice DMs), so a refused sign-in leaves nothing usable.
      slackData.forCompany(companyId).rememberAccount(who.slackUserId, who.email, clock.now())
      return { ok: true, email: who.email }
    },
    revoke: token => slack.revoke(token),
    normalizeScopes: normalizeSlackScopes,
    featuresOf: slackFeaturesOf,
    forget: () => {},
    forgetCompany: () => {},
    pages: PAGE,
  })

  return {
    /**
     * Slack as the core connector of the `chat` role (connector-roles.md):
     * usable while the company's app is set up and on, the vault on, and the
     * operator has not stopped Slack (registered in composition/connectors.ts).
     */
    roleConnector(): RoleConnector {
      return {
        id: BUILTIN_CONNECTORS.slack.id,
        servings: BUILTIN_CONNECTORS.slack.servings,
        usable: async companyId => (await unavailableReason(companyId)) === null,
      }
    },

    /** GET …/slack (owner/admin). */
    async adminView(member: Member): Promise<Outcome<SlackAdminView>> {
      const allowed = requireFullAccess(member, SLACK_FORBIDDEN)
      if (!allowed.ok) return allowed
      return ok(await view(member.companyId))
    },

    /**
     * PUT …/slack/app { teamId, clientId, clientSecret?, signingSecret?, botToken? } (owner/admin).
     * Secrets are required the first time, kept when left out. A bot token is
     * checked with Slack (its workspace must be the app's). Another workspace
     * or app ends every member's grant (they allow again).
     */
    async saveApp(member: Member, body: unknown): Promise<Outcome<SlackAdminView>> {
      const allowed = requireFullAccess(member, SLACK_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body)) return refuse('bad-request', 'Body must be a JSON object')
      const teamId = typeof body.teamId === 'string' ? body.teamId.trim() : ''
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      if (!TEAM_ID_RE.test(teamId)) return refuse('bad-request', 'ワークスペースの ID（T で始まる）を入れてください。', { code: 'BAD_TEAM_ID' })
      if (!CLIENT_ID_RE.test(clientId)) return refuse('bad-request', 'クライアント ID の形が正しくありません。', { code: 'BAD_CLIENT_ID' })
      const given = (k: string) => typeof body[k] === 'string' && (body[k] as string).trim() !== ''
      for (const [k, code] of [['clientSecret', 'BAD_CLIENT_SECRET'], ['signingSecret', 'BAD_SIGNING_SECRET']] as const) {
        if (given(k) && !SECRET_RE.test((body[k] as string).trim())) return refuse('bad-request', 'シークレットの形が正しくありません。', { code })
      }
      if (given('botToken') && !BOT_TOKEN_RE.test((body.botToken as string).trim())) {
        return refuse('bad-request', 'ボットのトークン（xoxb- で始まる）を入れてください。', { code: 'BAD_BOT_TOKEN' })
      }
      if (deps.practiceSlack) {
        const real = (['clientSecret', 'signingSecret', 'botToken'] as const).some(k => given(k) && !isPracticeSlackSecret(body[k] as string))
        if (real) {
          return refuse('bad-request', `練習用の Slack につながっているため、練習用の値（${PRACTICE_SLACK_CLIENT_SECRET_PREFIX}… / ${PRACTICE_SLACK_SIGNING_SECRET_PREFIX}… / xoxb-fake-…）だけを保存できます。`, { code: 'REAL_KEY_ON_PRACTICE' })
        }
      }
      const store = slackData.forCompany(member.companyId)
      const before = store.app()
      if (!before && (!given('clientSecret') || !given('signingSecret'))) {
        return refuse('bad-request', 'クライアント シークレットと署名のシークレットを入れてください。', { code: 'SECRETS_REQUIRED' })
      }
      if (!brokerVault.status().enabled) {
        return refuse('unavailable', 'サーバーに鍵の金庫が用意されていないため、登録できません。運用担当者に確かめてください。', { code: 'BROKER_OFF' })
      }
      let botUserId = before?.botUserId ?? null
      let botToken: string | null = null
      if (given('botToken')) {
        botToken = (body.botToken as string).trim()
        const bot = await slack.identify(botToken)
        if (!bot || bot.teamId !== teamId) {
          return refuse('bad-request', 'このボットのトークンは、このワークスペースで使えませんでした。保存していません。', { code: 'BOT_TOKEN_REJECTED' })
        }
        botUserId = bot.slackUserId
      }
      const companyId = member.companyId
      const clientSecret = given('clientSecret') ? (body.clientSecret as string).trim() : null
      const signingSecret = given('signingSecret') ? (body.signingSecret as string).trim() : null
      store.saveApp({ teamId, clientId, botUserId, at: clock.now(), by: member.userId }, {
        ...(clientSecret ? { clientSecret: { sealed: await brokerVault.sealConnector(slackAppSealContext(companyId, 'client-secret'), clientSecret), last4: clientSecret.slice(-4) } } : {}),
        ...(signingSecret ? { signingSecret: await brokerVault.sealConnector(slackAppSealContext(companyId, 'signing-secret'), signingSecret) } : {}),
        ...(botToken ? { botToken: await brokerVault.sealConnector(slackAppSealContext(companyId, 'bot-token'), botToken) } : {}),
      }, change('app', member.userId, null, {
        before: before ? { teamId: before.teamId, clientId: before.clientId, clientSecretLast4: before.clientSecretLast4, hasBotToken: before.hasBotToken } : null,
        after: { teamId, clientId, clientSecretLast4: clientSecret?.slice(-4) ?? before?.clientSecretLast4 ?? null, hasBotToken: !!botToken || !!before?.hasBotToken },
        signingSecretReplaced: !!signingSecret && !!before,
      }))
      if (before && (before.teamId !== teamId || before.clientId !== clientId)) {
        await memberOAuth.endAllGrants('slack', companyId, member.userId, 'revoked', 'app-changed', 'grant-revoked')
      }
      return ok(await view(companyId))
    },

    /** PUT …/slack/enabled { enabled } (owner/admin): off stops every use and every event from the next one. */
    async setEnabled(member: Member, body: unknown): Promise<Outcome<SlackAdminView>> {
      const allowed = requireFullAccess(member, SLACK_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!isObject(body) || typeof body.enabled !== 'boolean') return refuse('bad-request', 'enabled must be true or false')
      const store = slackData.forCompany(member.companyId)
      const app = store.app()
      if (!app) return refuse('not-found', 'Slack の登録がまだありません。', { code: 'NOT_CONFIGURED' })
      if (app.enabled !== body.enabled) store.setEnabled(body.enabled, clock.now(), member.userId, change('enabled', member.userId, null, { enabled: body.enabled }))
      return ok(await view(member.companyId))
    },

    /** DELETE …/slack/grants/:userId (owner/admin): stops a member's grant (revoked at Slack too). */
    async stopGrant(member: Member, userId: string): Promise<Outcome<SlackAdminView>> {
      const allowed = requireFullAccess(member, SLACK_FORBIDDEN)
      if (!allowed.ok) return allowed
      if (!await memberOAuth.stopGrant('slack', member.companyId, userId, member.userId)) return refuse('not-found', 'Slack permission not found')
      return ok(await view(member.companyId))
    },

    /** GET …/me/slack (any member). */
    async my(member: Member): Promise<Outcome<MySlack>> {
      return ok(await myView(member))
    },

    /** POST …/me/slack/connect { features } → the URL the member's browser opens. */
    async connect(member: Member, body: unknown): Promise<Outcome<{ authorizeUrl: string; expiresAt: string }>> {
      if (!isObject(body) || !Array.isArray(body.features) || body.features.length === 0 || !body.features.every(isSlackFeature)) {
        return refuse('bad-request', `features must list one or more of: ${SLACK_FEATURES.join(', ')}`)
      }
      const reason = await unavailableReason(member.companyId)
      if (reason) return refuse('conflict', 'いまは Slack とつなげません。管理者に確かめてください。', { code: 'SLACK_UNAVAILABLE', reason })
      const app = slackData.forCompany(member.companyId).app()!
      const grant = companyData.forCompany(member.companyId).connectors.grant('slack', member.userId)
      // Ask for what the member already allowed too (Slack adds scopes to the same user token).
      const features = new Set<SlackFeature>(body.features as SlackFeature[])
      if (grant?.status === 'active') for (const f of slackFeaturesOf(grant.scopes)) features.add(f)
      return ok(await memberOAuth.start('slack', member, slackScopesFor([...features]), p => ({
        client_id: app.clientId,
        user_scope: p.scope.split(' ').join(','),
        redirect_uri: p.redirectUri,
        state: p.state,
        // Only the company's own workspace.
        team: app.teamId,
      })))
    },

    /** PUT …/me/slack/features { feature, on }: the member turns an allowed feature off / on (知らせの DM …). */
    async setFeature(member: Member, body: unknown): Promise<Outcome<MySlack>> {
      if (!isObject(body) || !isSlackFeature(body.feature) || typeof body.on !== 'boolean') {
        return refuse('bad-request', `feature must be one of: ${SLACK_FEATURES.join(', ')}; on must be true or false`)
      }
      const grant = companyData.forCompany(member.companyId).connectors.grant('slack', member.userId)
      if (!grant || grant.status !== 'active') return refuse('conflict', 'まだ Slack で許可していません。', { code: 'SLACK_NOT_CONNECTED' })
      if (!slackFeaturesOf(grant.scopes).includes(body.feature)) {
        return refuse('conflict', 'この機能はまだ許可していません。先に「Slack で許可」で足してください。', { code: 'SLACK_FEATURE_NOT_GRANTED' })
      }
      const r = memberOAuth.setFeatureOff('slack', member, body.feature, !body.on)
      if (!r.ok) return refuse('conflict', 'まだ Slack で許可していません。', { code: 'SLACK_NOT_CONNECTED' })
      return ok(await myView(member))
    },

    /**
     * PUT …/me/slack/seen: 「仕事の道具をつなぐ」 showed Slack to the member (「Slack でつなぐ」
     * or 「あとで」); the screen does not offer it again.
     */
    async markSeen(member: Member): Promise<Outcome<MySlack>> {
      if (await unavailableReason(member.companyId) === null) {
        companyData.forCompany(member.companyId).connectors.addSetupSeen('slack', member.userId, [...SLACK_SETUP_FEATURES], clock.now())
      }
      return ok(await myView(member))
    },

    /** DELETE …/me/slack: 「許可をやめる」 — revoked at Slack too (best effort), then nothing kept. */
    async disconnect(member: Member): Promise<Outcome<MySlack>> {
      await memberOAuth.disconnect('slack', member)
      return ok(await myView(member))
    },

    /**
     * A notice DM from the company's bot to a member (大事な知らせ: approval
     * requests, an outside reply due today — the caller decides which). Only
     * to a member with an active Slack grant (their Slack account is known
     * from it) who has not turned 知らせの DM (`notices`) off; `text` is the
     * notice's own sentence, never stored or logged.
     */
    async sendNoticeDm(companyId: string, userId: string, text: string): Promise<SlackResult> {
      if (!deps.isMember(companyId, userId)) return { ok: false, kind: 'not-sent', reason: 'not-member' }
      const grant = companyData.forCompany(companyId).connectors.grant('slack', userId)
      if (!grant || grant.status !== 'active') return { ok: false, kind: 'not-sent', reason: 'no-grant' }
      if (!slackFeaturesOf(grant.scopes).includes('notices') || grant.featuresOff.includes('notices')) return { ok: false, kind: 'not-sent', reason: 'feature-off' }
      const slackUserId = slackData.forCompany(companyId).slackUserOfEmail(grant.accountEmail)
      const account = accounts.byIds([userId]).get(userId)
      // The Slack account must still be the member's own address (as at the grant).
      if (!slackUserId || !account || !sameEmail(account.email, grant.accountEmail)) return { ok: false, kind: 'not-sent', reason: 'no-grant' }
      const opened = await slack.botCall(companyId, userId, { method: 'conversations.open', params: { users: slackUserId }, write: true, operation: 'conversations.open' })
      if (!opened.ok) return opened
      const channel = isObject(opened.json.channel) && typeof opened.json.channel.id === 'string' ? opened.json.channel.id : null
      if (!channel) return { ok: false, kind: 'refused', reason: 'refused' }
      return slack.botCall(companyId, userId, {
        method: 'chat.postMessage', params: { channel, text: text.slice(0, NOTICE_MAX) }, write: true, operation: 'chat.postMessage.notice',
      })
    },
  }
}

export type SlackConnector = ReturnType<typeof createSlackConnector>

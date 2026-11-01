/**
 * SQLite storage of the Slack connection (ports/slack.ts), limited to one
 * company: every statement binds `company_id = ?`. Sealed secrets are stored
 * as their JSON envelope only.
 */
import type Database from 'better-sqlite3'
import type { SealedSecret } from '../../ports/secret-cipher'
import type { SlackAppRow, SlackAppSecret, SlackChangeRow, SlackDataSource, SlackRepository } from '../../ports/slack'

type AppRow = {
  team_id: string; client_id: string; client_secret_last4: string; bot_user_id: string | null; has_bot: number; enabled: number
  created_at: string; created_by: string; updated_at: string; updated_by: string
}
type HistoryRow = { id: string; action: string; user_id: string | null; at: string; by_user: string; change: string }

const SECRET_COLUMN: Record<SlackAppSecret, string> = {
  'client-secret': 'client_secret_sealed',
  'signing-secret': 'signing_secret_sealed',
  'bot-token': 'bot_token_sealed',
}

export function sqliteSlackRepository(conn: Database.Database, companyId: string): SlackRepository {
  const addHistory = (c: SlackChangeRow) => {
    conn.prepare('INSERT INTO slack_history (id, company_id, action, user_id, at, by_user, change) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, companyId, c.action, c.userId, c.at, c.by, c.change)
  }
  const sealedText = (s: SealedSecret) => JSON.stringify(s)

  return {
    app(): SlackAppRow | null {
      const r = conn.prepare(`SELECT team_id, client_id, client_secret_last4, bot_user_id, bot_token_sealed IS NOT NULL AS has_bot, enabled,
        created_at, created_by, updated_at, updated_by FROM slack_apps WHERE company_id = ?`).get(companyId) as AppRow | undefined
      return r ? {
        teamId: r.team_id, clientId: r.client_id, clientSecretLast4: r.client_secret_last4, botUserId: r.bot_user_id,
        hasBotToken: r.has_bot === 1, enabled: r.enabled === 1,
        createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
      } : null
    },

    secret(which) {
      const r = conn.prepare(`SELECT client_secret_sealed, signing_secret_sealed, bot_token_sealed FROM slack_apps WHERE company_id = ?`)
        .get(companyId) as Record<string, string | null> | undefined
      const text = r?.[SECRET_COLUMN[which]]
      return text ? JSON.parse(text) as SealedSecret : null
    },

    saveApp(row, secrets, change) {
      conn.transaction(() => {
        const exists = conn.prepare('SELECT 1 FROM slack_apps WHERE company_id = ?').get(companyId)
        if (!exists) {
          if (!secrets.clientSecret || !secrets.signingSecret) throw new Error('The Slack app needs its client and signing secrets the first time')
          conn.prepare(`INSERT INTO slack_apps (company_id, team_id, client_id, client_secret_sealed, client_secret_last4, signing_secret_sealed,
            bot_token_sealed, bot_user_id, enabled, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(companyId, row.teamId, row.clientId, sealedText(secrets.clientSecret.sealed), secrets.clientSecret.last4, sealedText(secrets.signingSecret),
              secrets.botToken ? sealedText(secrets.botToken) : null, row.botUserId, row.at, row.by, row.at, row.by)
        } else {
          conn.prepare('UPDATE slack_apps SET team_id = ?, client_id = ?, bot_user_id = ?, updated_at = ?, updated_by = ? WHERE company_id = ?')
            .run(row.teamId, row.clientId, row.botUserId, row.at, row.by, companyId)
          if (secrets.clientSecret) {
            conn.prepare('UPDATE slack_apps SET client_secret_sealed = ?, client_secret_last4 = ? WHERE company_id = ?')
              .run(sealedText(secrets.clientSecret.sealed), secrets.clientSecret.last4, companyId)
          }
          if (secrets.signingSecret) {
            conn.prepare('UPDATE slack_apps SET signing_secret_sealed = ? WHERE company_id = ?').run(sealedText(secrets.signingSecret), companyId)
          }
          if (secrets.botToken !== undefined) {
            conn.prepare('UPDATE slack_apps SET bot_token_sealed = ? WHERE company_id = ?').run(secrets.botToken ? sealedText(secrets.botToken) : null, companyId)
          }
        }
        addHistory(change)
      })()
    },

    setEnabled(enabled, at, by, change) {
      conn.transaction(() => {
        conn.prepare('UPDATE slack_apps SET enabled = ?, updated_at = ?, updated_by = ? WHERE company_id = ?').run(enabled ? 1 : 0, at, by, companyId)
        addHistory(change)
      })()
    },

    rememberAccount(slackUserId, email, at) {
      conn.prepare(`INSERT INTO slack_accounts (company_id, slack_user_id, email, seen_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (company_id, slack_user_id) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at`)
        .run(companyId, slackUserId, email.trim().toLowerCase(), at)
    },

    emailOfSlackUser(slackUserId) {
      const r = conn.prepare('SELECT email FROM slack_accounts WHERE company_id = ? AND slack_user_id = ?').get(companyId, slackUserId) as { email: string } | undefined
      return r?.email ?? null
    },

    slackUserOfEmail(email) {
      const r = conn.prepare('SELECT slack_user_id FROM slack_accounts WHERE company_id = ? AND email = ? ORDER BY seen_at DESC LIMIT 1')
        .get(companyId, email.trim().toLowerCase()) as { slack_user_id: string } | undefined
      return r?.slack_user_id ?? null
    },

    firstSeen(eventId, at) {
      return conn.prepare('INSERT OR IGNORE INTO slack_events_seen (company_id, event_id, received_at) VALUES (?, ?, ?)').run(companyId, eventId, at).changes === 1
    },

    pruneSeen(before) {
      conn.prepare('DELETE FROM slack_events_seen WHERE company_id = ? AND received_at < ?').run(companyId, before)
    },

    history(limit) {
      const rows = conn.prepare('SELECT id, action, user_id, at, by_user, change FROM slack_history WHERE company_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(companyId, limit) as HistoryRow[]
      return rows.map(r => ({ id: r.id, action: r.action, userId: r.user_id, at: r.at, by: r.by_user, change: r.change }))
    },
  }
}

export function sqliteSlackData(conn: Database.Database): SlackDataSource {
  return { forCompany: companyId => sqliteSlackRepository(conn, companyId) }
}

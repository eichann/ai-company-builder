import Database from 'better-sqlite3'
import fs from 'fs'
import { seedPermissionScopes } from '../adapters/sqlite/permission-store'
import { migrateCompanyContents } from '../adapters/sqlite/record-contents'
import { APP_DB_PATH, DATA_DIR } from '../lib/config'
import { agentSchema, migrateAgentEventSandbox } from './schema/agents'
import { brokerSchema, migrateBrokerSettings } from './schema/broker'
import { companySchema, migrateInvitationClaims } from './schema/company'
import { connectorSchema, migrateConnectorProviders } from './schema/connectors'
import { contentStoreSchema } from './schema/content-store'
import { fixedPayloadSchema, migrateFixedPayloads } from './schema/fixed-payloads'
import { notificationSchema } from './schema/notifications'
import { outboundMailSchema } from './schema/outbound-mail'
import { migrateRuleAndManagerCompanies, permissionSchema } from './schema/permissions'
import { migratePluginInstallKeyReference, migratePluginOperationCreates, migratePluginTables, pluginSchema } from './schema/plugins'
import { migrateRecordLedgerProvenance, migrateRecordPersonalOwner, migrateRecordTypeSources, recordSchema } from './schema/records'
import { taskSchema } from './schema/tasks'

// The migrations tests run on their own against older databases.
export { migrateInvitationClaims } from './schema/company'
export { migrateRuleAndManagerCompanies } from './schema/permissions'
export { migratePluginInstallKeyReference, migratePluginOperationCreates, migratePluginTables } from './schema/plugins'
export { migrateRecordLedgerProvenance, migrateRecordPersonalOwner, migrateRecordTypeSources } from './schema/records'
export { migrateConnectorProviders } from './schema/connectors'
export { migrateFixedPayloads } from './schema/fixed-payloads'

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const dbPath = APP_DB_PATH
const sqlite = new Database(dbPath)

// Enable WAL mode for better concurrent access
sqlite.pragma('journal_mode = WAL')

// Export the raw SQLite connection for direct queries
export const db = sqlite

/**
 * One module per area under db/schema/ (its tables, indexes and migrations),
 * in the order the tables have always been created. Every area's
 * `CREATE … IF NOT EXISTS` runs first, in one batch; then the migrations, in
 * the fixed order of initDatabase.
 */
const SCHEMA = [
  companySchema,
  permissionSchema,
  agentSchema,
  brokerSchema,
  recordSchema,
  pluginSchema,
  connectorSchema,
  fixedPayloadSchema,
  taskSchema,
  contentStoreSchema,
  outboundMailSchema,
  notificationSchema,
]

// Initialize application tables (separate from Better Auth tables).
// Takes the connection so tests can run it against a copy of an older database.
// Every change here must stay additive: an older server build must keep
// working on a database this version has initialized.
export function initDatabase(conn: Database.Database = sqlite) {
  conn.exec(SCHEMA.join('\n'))

  // Single-use invitation links (services/invitations.ts signUp).
  migrateInvitationClaims(conn)
  migrateRecordLedgerProvenance(conn)
  migrateRecordPersonalOwner(conn)
  migrateAgentEventSandbox(conn)
  migrateBrokerSettings(conn)
  migratePluginInstallKeyReference(conn)
  migratePluginOperationCreates(conn)
  migratePluginTables(conn)
  migrateRecordTypeSources(conn)
  migrateConnectorProviders(conn)
  migrateFixedPayloads(conn)
  migrateRecordContents(conn)
  // Before the seeding below: it deletes stale manager rows per company.
  migrateRuleAndManagerCompanies(conn)

  // Company scope + default `everyone: read + write` rule, one scope per
  // department. Idempotent; repairs drift left by older server builds.
  seedPermissionScopes(conn)

  if (conn === sqlite) console.log('Application database initialized at:', dbPath)
}

/**
 * The content store (records.md "The content store"): content is never
 * rewritten — only its text cleared once (erasure, retention) together with
 * erased_at / erased_reason. Then every company whose rows were written before
 * the store gets them moved in (adapters/sqlite/record-contents.ts
 * `migrateCompanyContents`: idempotent; a company once done is skipped).
 * It stays here rather than in schema/content-store.ts because it runs an adapter,
 * which only this module and the composition root may import (layering test).
 */
export function migrateRecordContents(conn: Database.Database): void {
  conn.exec(`
    CREATE TRIGGER IF NOT EXISTS record_contents_immutable BEFORE UPDATE ON record_contents
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.id IS NOT OLD.id OR NEW.record_id IS NOT OLD.record_id OR NEW.hash IS NOT OLD.hash
      OR NEW.retention_class IS NOT OLD.retention_class OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      OR (NEW.text IS NOT OLD.text AND NEW.text IS NOT NULL)
      OR (OLD.erased_at IS NOT NULL AND (NEW.erased_at IS NOT OLD.erased_at OR NEW.erased_reason IS NOT OLD.erased_reason))
    BEGIN SELECT RAISE(ABORT, 'content is never rewritten (only its text erased)'); END;
  `)
  const at = new Date().toISOString()
  for (const { id } of conn.prepare('SELECT id FROM companies').all() as Array<{ id: string }>) {
    const done = conn.prepare('SELECT content_store FROM record_settings WHERE company_id = ?').get(id) as { content_store: number | null } | undefined
    if (!done || done.content_store === 1) continue
    const { moved } = migrateCompanyContents(conn, id, at)
    if (moved > 0 && conn === sqlite) console.log(`[records] content store: moved ${moved} text(s) of company ${id}`)
  }
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function now(): string {
  return new Date().toISOString()
}

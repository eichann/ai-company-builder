/**
 * Which company Skill a consultation used (records.md "Which Skill",
 * shared/core/skill-uses.ts). Part of the one schema run by db/index.ts
 * initDatabase (tables before every migration).
 */
import type Database from 'better-sqlite3'

export const skillUseSchema = `
    -- Per member and consultation: each (skill name, git tree id of its folder, dirty)
    -- the member's app saw the AI load, with the first time the server heard of it.
    -- Never a path or content. Behind the company handle (ports/skill-uses.ts).
    CREATE TABLE IF NOT EXISTS consultation_skill_uses (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      skill TEXT NOT NULL,
      tree TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      first_used_at TEXT NOT NULL,
      PRIMARY KEY (company_id, user_id, conversation_id, skill, tree, dirty)
    );
`

/**
 * The copies taken at write time (nullable, additive: an older build keeps inserting
 * without them): record_ledger.skills on the AI's entries, google_drive_puts.skills on
 * the AI's put receipts — JSON of SkillUse[].
 */
export function migrateSkillUseColumns(conn: Database.Database): void {
  const cols = (table: string) => new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  if (!cols('record_ledger').has('skills')) conn.exec('ALTER TABLE record_ledger ADD COLUMN skills TEXT')
  if (!cols('google_drive_puts').has('skills')) conn.exec('ALTER TABLE google_drive_puts ADD COLUMN skills TEXT')
}

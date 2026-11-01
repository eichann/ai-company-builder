/**
 * SQLite storage of the Skills a consultation used (ports/skill-uses.ts),
 * limited to one company: every statement binds `company_id = ?`.
 * `skillUsesJson` is what the records and Google Drive adapters copy onto an
 * AI's ledger entry / put receipt in the same write (records.md "Which Skill").
 */
import type Database from 'better-sqlite3'
import type { SkillUse } from '../../../shared/core/skill-uses'
import type { SkillUseRepository } from '../../ports/skill-uses'

type Row = { skill: string; tree: string; dirty: number; first_used_at: string }

function uses(conn: Database.Database, companyId: string, userId: string, conversationId: string): SkillUse[] {
  return (conn.prepare(`SELECT skill, tree, dirty, first_used_at FROM consultation_skill_uses
      WHERE company_id = ? AND user_id = ? AND conversation_id = ? ORDER BY first_used_at, skill, tree, dirty`)
    .all(companyId, userId, conversationId) as Row[])
    .map(r => ({ name: r.skill, tree: r.tree, dirty: r.dirty === 1, firstUsedAt: r.first_used_at }))
}

/** JSON of the member's consultation's uses as they are now, or null when it has none. */
export function skillUsesJson(conn: Database.Database, companyId: string, userId: string, conversationId: string | null): string | null {
  if (!conversationId) return null
  const list = uses(conn, companyId, userId, conversationId)
  return list.length > 0 ? JSON.stringify(list) : null
}

export function sqliteSkillUseRepository(conn: Database.Database, companyId: string): SkillUseRepository {
  return {
    record(userId, conversationId, use, at, limit) {
      return conn.transaction((): 'added' | 'known' | 'full' => {
        const known = conn.prepare(`SELECT 1 FROM consultation_skill_uses
            WHERE company_id = ? AND user_id = ? AND conversation_id = ? AND skill = ? AND tree = ? AND dirty = ?`)
          .get(companyId, userId, conversationId, use.name, use.tree, use.dirty ? 1 : 0)
        if (known) return 'known'
        const { n } = conn.prepare('SELECT COUNT(*) AS n FROM consultation_skill_uses WHERE company_id = ? AND user_id = ? AND conversation_id = ?')
          .get(companyId, userId, conversationId) as { n: number }
        if (n >= limit) return 'full'
        conn.prepare(`INSERT INTO consultation_skill_uses (company_id, user_id, conversation_id, skill, tree, dirty, first_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(companyId, userId, conversationId, use.name, use.tree, use.dirty ? 1 : 0, at)
        return 'added'
      })()
    },
    forConsultation(userId, conversationId) {
      return uses(conn, companyId, userId, conversationId)
    },
  }
}

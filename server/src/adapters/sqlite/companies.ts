import type Database from 'better-sqlite3'
import type { CompanyRepository, CompanyRow } from '../../ports/companies'

// Statements are prepared per call, as before: the composition root builds
// the repositories at import time, before initDatabase() has created the
// tables on a fresh install.
export function sqliteCompanyRepository(conn: Database.Database): CompanyRepository {
  return {
    listForUser(userId) {
      return conn.prepare(`
        SELECT c.*, m.role
        FROM companies c
        JOIN memberships m ON c.id = m.company_id
        WHERE m.user_id = ?
        ORDER BY c.created_at DESC
      `).all(userId) as Array<CompanyRow & { role: string }>
    },

    findById(companyId) {
      return conn.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as CompanyRow | undefined
    },

    isSlugTaken(slug) {
      return !!conn.prepare('SELECT id FROM companies WHERE slug = ?').get(slug)
    },

    anyExists() {
      return !!conn.prepare('SELECT 1 FROM companies LIMIT 1').get()
    },

    insert(company) {
      conn.prepare(`
        INSERT INTO companies (id, name, slug, owner_id, repo_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(company.id, company.name, company.slug, company.ownerId, company.repoPath, company.createdAt, company.createdAt)
    },

    rename(companyId, name, updatedAt) {
      conn.prepare('UPDATE companies SET name = ?, updated_at = ? WHERE id = ?').run(name, updatedAt, companyId)
    },
  }
}

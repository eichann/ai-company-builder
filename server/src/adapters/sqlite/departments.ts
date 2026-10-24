import type Database from 'better-sqlite3'
import type { DepartmentRepository } from '../../ports/departments'

export function sqliteDepartmentRepository(conn: Database.Database): DepartmentRepository {
  return {
    insert(d) {
      conn.prepare(`
        INSERT INTO departments (
          id, company_id, parent_id,
          name, name_en, folder,
          icon, color, description,
          sort_order, is_active,
          created_at, updated_at, created_by
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        d.id,
        d.companyId,
        d.name,
        d.nameEn,
        d.folder,
        d.icon,
        d.color,
        d.description,
        d.sortOrder,
        d.createdAt,
        d.createdAt,
        d.createdBy,
      )
    },
  }
}

import type Database from 'better-sqlite3'
import type { DepartmentRepository, DepartmentRow } from '../../ports/departments'

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

    listByCompany(companyId) {
      return conn.prepare(`
        SELECT * FROM departments WHERE company_id = ? ORDER BY sort_order ASC
      `).all(companyId) as DepartmentRow[]
    },

    listAllByCompany(companyId) {
      return conn.prepare(`
        SELECT * FROM departments WHERE company_id = ?
      `).all(companyId) as DepartmentRow[]
    },

    findById(departmentId) {
      return conn.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId) as DepartmentRow | undefined
    },

    findInCompany(departmentId, companyId) {
      return conn.prepare(`
        SELECT * FROM departments WHERE id = ? AND company_id = ?
      `).get(departmentId, companyId) as DepartmentRow | undefined
    },

    existsInCompany(departmentId, companyId) {
      return !!conn.prepare('SELECT 1 FROM departments WHERE id = ? AND company_id = ?').get(departmentId, companyId)
    },

    maxSortOrder(companyId) {
      const row = conn.prepare(`
        SELECT MAX(sort_order) as max FROM departments WHERE company_id = ?
      `).get(companyId) as { max: number | null }
      return row?.max ?? null
    },

    update(departmentId, changes, updatedAt) {
      const updates: string[] = []
      const values: unknown[] = []
      if (changes.name !== undefined) { updates.push('name = ?'); values.push(changes.name) }
      if (changes.nameEn !== undefined) { updates.push('name_en = ?'); values.push(changes.nameEn) }
      if (changes.folder !== undefined) { updates.push('folder = ?'); values.push(changes.folder) }
      if (changes.icon !== undefined) { updates.push('icon = ?'); values.push(changes.icon) }
      if (changes.color !== undefined) { updates.push('color = ?'); values.push(changes.color) }
      if (changes.description !== undefined) { updates.push('description = ?'); values.push(changes.description) }
      if (changes.isActive !== undefined) { updates.push('is_active = ?'); values.push(changes.isActive ? 1 : 0) }
      if (updates.length === 0) return
      updates.push('updated_at = ?')
      values.push(updatedAt, departmentId)
      conn.prepare(`
        UPDATE departments SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    },

    setSortOrders(companyId, items, updatedAt) {
      const updateStmt = conn.prepare(`
        UPDATE departments
        SET sort_order = ?, updated_at = ?
        WHERE id = ? AND company_id = ?
      `)
      for (const item of items) {
        updateStmt.run(item.sortOrder, updatedAt, item.id, companyId)
      }
    },

    delete(departmentId) {
      conn.prepare('DELETE FROM departments WHERE id = ?').run(departmentId)
    },

    count(companyId) {
      return (conn.prepare(`SELECT COUNT(*) AS n FROM departments WHERE company_id = ?`)
        .get(companyId) as { n: number }).n
    },

    folders(companyId) {
      return conn.prepare(`SELECT id, folder FROM departments WHERE company_id = ?`).all(companyId) as Array<{ id: string; folder: string }>
    },
  }
}

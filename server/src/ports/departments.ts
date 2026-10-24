/**
 * A `departments` row, column names as stored (is_active is SQLite 0/1). The
 * API returns every column, camelCased, with isActive as a boolean.
 */
export type DepartmentRow = {
  id: string
  company_id: string
  parent_id: string | null
  name: string
  name_en: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sort_order: number
  is_active: number
  created_at: string
  updated_at: string
  created_by: string | null
}

export interface NewDepartment {
  id: string
  companyId: string
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  createdAt: string
  createdBy: string
}

/** Columns an update sets; undefined = leave as is. Values are stored as given. */
export interface DepartmentChanges {
  name?: string
  nameEn?: string | null
  folder?: string
  icon?: string
  color?: string
  description?: string | null
  isActive?: boolean
}

export interface DepartmentRepository {
  /** A top-level, active department (parent_id NULL, is_active 1). */
  insert(department: NewDepartment): void
  /** The company's departments by sort_order. */
  listByCompany(companyId: string): DepartmentRow[]
  /** The company's departments, in no particular order. */
  listAllByCompany(companyId: string): DepartmentRow[]
  findById(departmentId: string): DepartmentRow | undefined
  findInCompany(departmentId: string, companyId: string): DepartmentRow | undefined
  existsInCompany(departmentId: string, companyId: string): boolean
  /** The highest sort_order in the company, or null without departments. */
  maxSortOrder(companyId: string): number | null
  /** Set the given columns and updated_at. Nothing happens when `changes` sets none. */
  update(departmentId: string, changes: DepartmentChanges, updatedAt: string): void
  /** One statement per item; items of other companies are ignored. Not atomic (it never was). */
  setSortOrders(companyId: string, items: Array<{ id: string; sortOrder: number }>, updatedAt: string): void
  delete(departmentId: string): void
  count(companyId: string): number
  /** Every department's id and folder (as stored), in no particular order. */
  folders(companyId: string): Array<{ id: string; folder: string }>
}

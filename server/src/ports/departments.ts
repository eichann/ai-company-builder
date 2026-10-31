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

/** A new row; its company is the handle's. */
export interface NewDepartment {
  id: string
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

/**
 * One company's departments, from its handle (`CompanyData`, ports/company-data.ts).
 * Every method is limited to that company: another company's department id
 * is not found, and updating or deleting it changes nothing.
 */
export interface DepartmentRepository {
  /** A top-level, active department (parent_id NULL, is_active 1). */
  insert(department: NewDepartment): void
  /** The departments by sort_order. */
  list(): DepartmentRow[]
  /** The departments, in no particular order. */
  listUnordered(): DepartmentRow[]
  find(departmentId: string): DepartmentRow | undefined
  exists(departmentId: string): boolean
  /** The highest sort_order, or null without departments. */
  maxSortOrder(): number | null
  /** Set the given columns and updated_at. Nothing happens when `changes` sets none. */
  update(departmentId: string, changes: DepartmentChanges, updatedAt: string): void
  /** One statement per item; ids of other companies are ignored. Not atomic (it never was). */
  setSortOrders(items: Array<{ id: string; sortOrder: number }>, updatedAt: string): void
  delete(departmentId: string): void
  count(): number
  /** Every department's id and folder (as stored), in no particular order. */
  folders(): Array<{ id: string; folder: string }>
}

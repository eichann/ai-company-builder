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

export interface DepartmentRepository {
  /** A top-level, active department (parent_id NULL, is_active 1). */
  insert(department: NewDepartment): void
}

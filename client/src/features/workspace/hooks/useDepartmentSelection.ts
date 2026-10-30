import { useRef, useState } from 'react'
import type { DepartmentConfig } from '../../../types'
import { COMPANY_TAB_ID } from '../../../shared/lib/departments'

/**
 * The department tab chosen in the open company, remembered per company in
 * localStorage (`selectedDeptTab:<company id>`); 全社 when nothing was saved.
 */
export function useDepartmentSelection(companyId: string | undefined, departments: DepartmentConfig[]) {
  // Department selection — restore last tab from localStorage, default to company-wide
  const savedTabKey = companyId ? `selectedDeptTab:${companyId}` : null
  const [selectedDeptId, setSelectedDeptId] = useState<string>(() => {
    if (savedTabKey) {
      const saved = localStorage.getItem(savedTabKey)
      if (saved) return saved
    }
    return COMPANY_TAB_ID
  })

  // Persist selected tab to localStorage
  const selectDepartment = (id: string) => {
    setSelectedDeptId(id)
    if (savedTabKey) localStorage.setItem(savedTabKey, id)
  }

  // If restored tab is a department ID that doesn't exist (yet), fallback to company-wide.
  // Checked once the list first arrives: before that, every saved id looks unknown.
  const prevDeptCountRef = useRef(0)
  if (departments.length > 0 && prevDeptCountRef.current === 0) {
    if (selectedDeptId !== COMPANY_TAB_ID && !departments.find(d => d.id === selectedDeptId)) {
      selectDepartment(COMPANY_TAB_ID)
    }
  }
  prevDeptCountRef.current = departments.length

  return { selectedDeptId, selectDepartment }
}

// ACB foundation (settings: 自分の設定's row; app: 「今日のフォルダを開く」, the task card's new file, the
// chat's instructions): which department holds the member's 今日のフォルダ, per company on this PC
// (localStorage). Unset = the default (client/shared/today-folder.ts `todayFolderDepartment`).

const key = (companyId: string) => `acb.todayFolder:${companyId}`
const listeners = new Set<() => void>()
const cache = new Map<string, string | null>()

function read(companyId: string): string | null {
  try {
    const value = localStorage.getItem(key(companyId))
    return value && value.length <= 200 ? value : null
  } catch {
    return null
  }
}

export const todayFolderSetting = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  /** The department id the member chose; null = the default. */
  get: (companyId: string): string | null => {
    if (!cache.has(companyId)) cache.set(companyId, read(companyId))
    return cache.get(companyId) ?? null
  },
  /** null goes back to the default. Throws when it cannot be saved (the page says so). */
  set: (companyId: string, departmentId: string | null) => {
    if (departmentId) localStorage.setItem(key(companyId), departmentId)
    else localStorage.removeItem(key(companyId))
    cache.set(companyId, departmentId)
    listeners.forEach(fn => fn())
  },
}

// The inbox's own read of the main process (src/shared/ipc/electron-api.ts): only what 「知らせの設定」 needs besides the
// notices' port (features/notifications/api.ts) — the member's role in the company, read with their session in main.
import type { ElectronPort } from '../../shared/ipc/electron-api'

/** The companies the member belongs to, with their role in each. */
export type CompanyRoleReads = ElectronPort<'getCompanies'>

/** Whether the member is an owner / admin of the company; null when it cannot be told (offline, not listed). */
export async function hasFullAccessIn(companyId: string, reads: CompanyRoleReads = window.electronAPI): Promise<boolean | null> {
  const r = await reads.getCompanies().catch(() => null)
  const role = r?.success ? r.data?.find(c => c.id === companyId)?.role : undefined
  return role === undefined ? null : role === 'owner' || role === 'admin'
}

/**
 * The desktop app's calls for private folders (permission plan stage 3c):
 * what the renderer needs for the 「新しいフォルダ…」 dialog and the lock
 * icons, and the create request itself. Thin: every decision (may this
 * member create here, is the name taken) is the server's.
 *
 * There is deliberately no chat tool / MCP around this: only a person, in the
 * dialog, creates private folders (shared/types/private-folders.ts).
 */
import type {
  CreatePrivateFolderRequest,
  CreatePrivateFolderResult,
  MyPrivateFolder,
  PrivateFolderCreateContext,
} from '../shared/private-folder-ui'

export interface PrivateFoldersApiDeps {
  baseUrl: () => string
  cookies: () => string[]
  fetch?: typeof fetch
}

export type MyPrivateFoldersResult =
  | { success: true; folders: MyPrivateFolder[] }
  | { success: false; offline: boolean; error: string }

export interface PrivateFoldersApi {
  mine(companyId: string): Promise<MyPrivateFoldersResult>
  createContext(companyId: string, parentPath: string): Promise<{ success: true; context: PrivateFolderCreateContext } | { success: false; offline: boolean; error: string }>
  create(companyId: string, input: CreatePrivateFolderRequest): Promise<CreatePrivateFolderResult>
}

const OFFLINE = 'サーバーに接続できませんでした。'

/** A department's folder contains `path` (deepest wins). */
function departmentOf<T extends { folder: string }>(path: string, departments: T[]): T | undefined {
  let best: T | undefined
  for (const d of departments) {
    const f = d.folder.normalize('NFC')
    if (path === f || path.startsWith(`${f}/`)) {
      if (!best || f.length > best.folder.length) best = d
    }
  }
  return best
}

export function createPrivateFoldersApi(deps: PrivateFoldersApiDeps): PrivateFoldersApi {
  const doFetch = deps.fetch ?? fetch
  const url = (companyId: string, rest: string) => `${deps.baseUrl()}/api/companies/${encodeURIComponent(companyId)}${rest}`
  const headers = (json = false): Record<string, string> => ({
    Cookie: deps.cookies().join('; '),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  })

  async function getData<T>(companyId: string, rest: string): Promise<T> {
    const res = await doFetch(url(companyId, rest), { headers: headers() })
    const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null
    if (!res.ok || !body || body.data === undefined) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status })
    return body.data
  }

  const failure = (err: unknown) => {
    const status = (err as { status?: number })?.status
    return { success: false as const, offline: status === undefined, error: status === undefined ? OFFLINE : err instanceof Error ? err.message : String(err) }
  }

  return {
    async mine(companyId) {
      if (!deps.baseUrl()) return { success: false, offline: true, error: OFFLINE }
      try {
        return { success: true, folders: await getData<MyPrivateFolder[]>(companyId, '/me/private-folders') }
      } catch (err) {
        return failure(err)
      }
    },

    async createContext(companyId, parentPath) {
      if (!deps.baseUrl()) return { success: false, offline: true, error: OFFLINE }
      try {
        const [caps, members, departments] = await Promise.all([
          getData<{ role: string; managedDepartmentIds: string[] }>(companyId, '/me/capabilities'),
          getData<Array<{ userId: string; name: string | null; email: string | null; role: string }>>(companyId, '/members'),
          getData<Array<{ id: string; name: string; folder: string }>>(companyId, '/departments?flat=true'),
        ])
        const dept = departmentOf(parentPath.normalize('NFC'), departments)
        const managers = dept
          ? (await getData<{ managers: Array<{ userId: string }> }>(companyId, `/departments/${encodeURIComponent(dept.id)}/managers`)).managers.map(m => m.userId)
          : []
        return {
          success: true,
          context: {
            role: caps.role,
            managedDepartmentIds: caps.managedDepartmentIds,
            department: dept ? { id: dept.id, name: dept.name, folder: dept.folder.normalize('NFC') } : null,
            managerIds: managers,
            members: members.map(m => ({ userId: m.userId, name: m.name, email: m.email, role: m.role })),
          },
        }
      } catch (err) {
        return failure(err)
      }
    },

    async create(companyId, input) {
      if (!deps.baseUrl()) return { success: false, offline: true, error: OFFLINE }
      let res: Response
      try {
        res = await doFetch(url(companyId, '/private-folders'), { method: 'POST', headers: headers(true), body: JSON.stringify(input) })
      } catch {
        return { success: false, offline: true, error: OFFLINE }
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.ok && body?.data) {
        const d = body.data as { scopeId: string; path: string; viewerCount: number }
        return { success: true, scopeId: d.scopeId, path: d.path, viewerCount: d.viewerCount }
      }
      return {
        success: false,
        offline: false,
        status: res.status,
        code: typeof body?.code === 'string' ? body.code : undefined,
        error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
        outdatedMembers: Array.isArray(body?.members)
          ? (body.members as Array<{ name: string | null; email: string | null }>).map(m => m.name || m.email || '名前未設定')
          : undefined,
        canForce: body?.canForce === true,
      }
    },
  }
}

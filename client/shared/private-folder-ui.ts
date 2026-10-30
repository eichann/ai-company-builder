/**
 * Private folders in the desktop app's UI (permission plan stage 3c): the
 * types the renderer and the main process exchange, and the pure decisions
 * the file tree makes — which private folder a path is in, whether a move
 * crosses the public/private boundary, who may create a private folder where.
 *
 * Paths here are company-relative, '/'-separated (normalizeRepoPath).
 */
import type { MyPrivateFolder } from '../../shared/types/private-folders'

export type { MyPrivateFolder } from '../../shared/types/private-folders'

export interface PrivateFolderMemberOption {
  userId: string
  name: string | null
  email: string | null
  role: string
}

/** What the 「新しいフォルダ…」 dialog needs to offer 非公開 (GET capabilities / members / departments). */
export interface PrivateFolderCreateContext {
  role: string
  managedDepartmentIds: string[]
  /** The department whose folder contains the parent, or null (company root / outside departments). */
  department: { id: string; name: string; folder: string } | null
  managerIds: string[]
  members: PrivateFolderMemberOption[]
}

export interface CreatePrivateFolderRequest {
  parentPath: string
  name: string
  viewers?: string[]
  editors?: string[]
  force?: boolean
}

export type CreatePrivateFolderResult =
  | { success: true; scopeId: string; path: string; viewerCount: number }
  | {
      success: false
      offline: boolean
      status?: number
      code?: string
      error: string
      /** OUTDATED_CLIENTS: who still runs an app that cannot handle private folders. */
      outdatedMembers?: string[]
      canForce?: boolean
    }

const FULL_ACCESS = new Set(['owner', 'admin'])

export const isFullAccessRole = (role: string | null | undefined): boolean => !!role && FULL_ACCESS.has(role)

function key(path: string): string {
  return path.normalize('NFC').split(/[/\\]/).filter(Boolean).join('/')
}

function isSameOrInside(ancestor: string, path: string): boolean {
  const a = key(ancestor)
  const p = key(path)
  return a === '' || p === a || p.startsWith(`${a}/`)
}

/** The private folder `relPath` is at or inside (private folders do not nest), or null. */
export function privateFolderOf(relPath: string, folders: MyPrivateFolder[]): MyPrivateFolder | null {
  return folders.find(f => isSameOrInside(f.path, relPath)) ?? null
}

/** True when `relPath` is a private folder itself (its root). */
export function isPrivateRoot(relPath: string, folders: MyPrivateFolder[]): boolean {
  return folders.some(f => key(f.path) === key(relPath))
}

export type BoundaryCrossing =
  /** public → private: the file's past versions stay in everyone's history. */
  | { kind: 'toPrivate'; to: MyPrivateFolder }
  /** private → public: everyone gets it. */
  | { kind: 'toPublic'; from: MyPrivateFolder }
  /** one private folder → another: the other folder's viewers get it. */
  | { kind: 'between'; from: MyPrivateFolder; to: MyPrivateFolder }

/** Does moving / copying `src` to `dest` (company-relative) cross a private folder's edge? */
export function boundaryCrossing(src: string, dest: string, folders: MyPrivateFolder[]): BoundaryCrossing | null {
  const from = privateFolderOf(src, folders)
  const to = privateFolderOf(dest, folders)
  if (from?.scopeId === to?.scopeId) return null
  if (!from && to) return { kind: 'toPrivate', to }
  if (from && !to) return { kind: 'toPublic', from }
  return { kind: 'between', from: from!, to: to! }
}

export const TO_PRIVATE_WARNING = 'このファイルの過去の内容は、全員の手元に残っています'
export const NOT_ALLOWED_REASON = '非公開のフォルダは、管理者か部署の責任者が作れます'
export const OFFLINE_REASON = 'インターネットにつながっているときに作成できます'

/** The confirmation for a move / copy that crosses the edge (title, message, button). */
export function crossingMessage(c: BoundaryCrossing, count: number, verb: '移動' | 'コピー'): { title: string; message: string; confirm: string } {
  const what = count === 1 ? 'このファイル' : `${count}件のファイル`
  if (c.kind === 'toPrivate') {
    return {
      title: `非公開フォルダへ${verb}します`,
      message: `${what}を非公開フォルダ「${lastSegment(c.to.path)}」へ${verb}します（${c.to.viewerCount}人だけが見られます）。\n\n${TO_PRIVATE_WARNING}。これまでに配られた分は各メンバーの手元に残り、過去の版は会社の履歴にも残ります。`,
      confirm: `${verb}する`,
    }
  }
  if (c.kind === 'toPublic') {
    return {
      title: '全員に公開されます',
      message: `${what}を非公開フォルダ「${lastSegment(c.from.path)}」の外へ${verb}すると、全員に公開されます。次に同期したときに、会社の全員の手元に届きます。`,
      confirm: `公開の場所へ${verb}する`,
    }
  }
  return {
    title: '別の非公開フォルダへ移ります',
    message: `${what}を「${lastSegment(c.to.path)}」へ${verb}すると、「${lastSegment(c.to.path)}」を見られる${c.to.viewerCount}人に届きます。`,
    confirm: `${verb}する`,
  }
}

export function lastSegment(path: string): string {
  return key(path).split('/').pop() || path
}

/**
 * May this member create a private folder inside `parentRel`? Owners/admins
 * anywhere; a department manager inside their own department (Q9). Inside a
 * private folder a plain folder is private already — not offered there.
 */
export function canCreatePrivateAt(parentRel: string, ctx: Pick<PrivateFolderCreateContext, 'role' | 'managedDepartmentIds' | 'department'>): boolean {
  if (isFullAccessRole(ctx.role)) return true
  return !!ctx.department && ctx.managedDepartmentIds.includes(ctx.department.id) && isSameOrInside(ctx.department.folder, parentRel)
}

/** Default 見られる人 (2026-10-22): the creator + the department's managers; owners/admins are implied. */
export function defaultViewerIds(meId: string | null | undefined, ctx: Pick<PrivateFolderCreateContext, 'managerIds' | 'members'>): string[] {
  const allowed = new Set(ctx.members.filter(m => !isFullAccessRole(m.role)).map(m => m.userId))
  return [...new Set([...(meId ? [meId] : []), ...ctx.managerIds])].filter(id => allowed.has(id))
}

/** People reached (owners/admins included) — the summary line's N. */
export function reachCount(viewerIds: string[], members: PrivateFolderMemberOption[]): number {
  const admins = members.filter(m => isFullAccessRole(m.role)).length
  const named = new Set(members.filter(m => !isFullAccessRole(m.role)).map(m => m.userId))
  return admins + new Set(viewerIds.filter(id => named.has(id))).size
}

/** 「佐藤、田中、ほか3人」 for the lock icon's tooltip. */
export function viewersLabel(folder: MyPrivateFolder, max = 5): string {
  const names = folder.viewers.map(v => v.name || '名前未設定')
  const shown = names.slice(0, max)
  const rest = folder.viewerCount - shown.length
  return `見られる人（${folder.viewerCount}人）：${shown.join('、')}${rest > 0 ? `、ほか${rest}人` : ''}`
}

// Who a private folder reaches (見られる人 / 編集できる人), as the create and
// member dialogs edit it. Owners and admins always read and write and are
// never part of the lists (the server drops them too).
import type { Department, Member, PrivateFolderDetail } from './api'
import { isAdminRole } from './format'
import { isSameOrAncestorPath, pathSegments } from './scope-paths'

export interface Audience {
  /** Non-admin members who may read. */
  viewers: string[]
  /** 見られる人全員 / 指定した人だけ */
  editorsMode: 'all' | 'specific'
  /** With 'specific': the viewers who may also edit. */
  editors: string[]
}

/** The department whose folder contains `path` (deepest), or undefined (company root). */
export function departmentOfPath(path: string, departments: Department[]): Department | undefined {
  let best: Department | undefined
  for (const d of departments) {
    const folder = d.folder.normalize('NFC')
    if (path !== '' && isSameOrAncestorPath(folder, path) && (!best || folder.length > best.folder.length)) best = d
  }
  return best
}

const nonAdminIds = (members: Member[]) => new Set(members.filter((m) => !isAdminRole(m.role)).map((m) => m.userId))

/** The decided default (2026-10-22): the creator + the department's managers. Admins are implied. */
export function defaultViewers(creatorId: string | null | undefined, managerIds: string[], members: Member[]): string[] {
  const allowed = nonAdminIds(members)
  return [...new Set([...(creatorId ? [creatorId] : []), ...managerIds])].filter((id) => allowed.has(id))
}

export function defaultAudience(creatorId: string | null | undefined, managerIds: string[], members: Member[]): Audience {
  return { viewers: defaultViewers(creatorId, managerIds, members), editorsMode: 'all', editors: [] }
}

/** People reached, owners/admins included — what the summary line says. */
export function audienceCounts(audience: Audience, members: Member[]): { viewers: number; editors: number; admins: number } {
  const allowed = nonAdminIds(members)
  const admins = members.length - allowed.size
  const viewers = audience.viewers.filter((id) => allowed.has(id))
  const editors = audience.editorsMode === 'all' ? viewers : audience.editors.filter((id) => viewers.includes(id))
  return { viewers: admins + viewers.length, editors: admins + editors.length, admins }
}

/** The request body (editors omitted = every viewer). */
export function audienceRequest(audience: Audience): { viewers: string[]; editors?: string[] } {
  if (audience.editorsMode === 'all') return { viewers: audience.viewers }
  return { viewers: audience.viewers, editors: audience.editors.filter((id) => audience.viewers.includes(id)) }
}

export function audienceFromDetail(detail: PrivateFolderDetail): Audience {
  const named = detail.members.filter((m) => m.via === 'rule')
  const viewers = named.map((m) => m.userId)
  const editors = named.filter((m) => m.canWrite).map((m) => m.userId)
  return editors.length === viewers.length
    ? { viewers, editorsMode: 'all', editors: [] }
    : { viewers, editorsMode: 'specific', editors }
}

export function sameAudience(a: Audience, b: Audience): boolean {
  const ra = audienceRequest(a)
  const rb = audienceRequest(b)
  const same = (x: string[] | undefined, y: string[] | undefined) =>
    (x === undefined) === (y === undefined) && [...(x ?? [])].sort().join('\u0000') === [...(y ?? [])].sort().join('\u0000')
  return same(ra.viewers, rb.viewers) && same(ra.editors, rb.editors)
}

/** The last segment of a path: what 公開に戻す asks to type. */
export function folderName(path: string): string {
  return pathSegments(path).at(-1) ?? path
}

/** 「営業部 / 評価」: a path for people, with the department's display name in front. */
export function displayPath(path: string, departments: Department[]): string {
  const dept = departmentOfPath(path, departments)
  if (!dept) return pathSegments(path).join(' / ')
  const rest = pathSegments(path).slice(pathSegments(dept.folder.normalize('NFC')).length)
  return [dept.name, ...rest].join(' / ')
}

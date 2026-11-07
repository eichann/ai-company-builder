/** The engine's refusals that more than one operation (or another service) gives. */
import { SERVICE_STATE_TYPES } from '../../../shared/core/core-types'
import { NO_COMPANY_FOLDER_FILE_LINK } from '../../../shared/core/company-folder'
import { refuse } from '../outcome'

export const conflict = (error: string, code: string, extra: Record<string, unknown> = {}) => refuse('conflict', error, { code, ...extra })

/** Says nothing about where the record is (a private folder's name never leaks). */
export const ASSIGNEE_CANNOT_READ = 'この人はこの記録を見られないため、担当にできません。見られる人を選んでください。'
/** The same for the person who checks the work (確かめる人, task `reviewer`): their turn would be a record they cannot open. */
export const REVIEWER_CANNOT_READ = 'この人はこの記録を見られないため、確かめる人にできません。見られる人を選んでください。'
export const bad = (error: string, code = 'BAD_REQUEST') => refuse('bad-request', error, { code })

/**
 * An OK statement naming someone who may not be named (another company's
 * id, someone who cannot read the record): one answer, no place named.
 */
export const OK_BY_CANNOT_READ = {
  error: 'この人はこの記録を見られないため、OK した人にできません。記録を見られる人を選ぶか、OK のいきさつを書いてください。',
  code: 'OK_BY_CANNOT_READ',
}

/** The generic create refuses the types the server's own services make (records.md "Service-owned types"). */
export const TYPE_CREATED_BY_SERVICE = { error: 'この種類の記録は ACB が決まった手順で作ります。ここからは作れません', code: 'TYPE_CREATED_BY_SERVICE' }
/** …and the generic action / undo routes refuse the types whose state only those services change. */
export const STATE_CHANGED_BY_SERVICE = { error: 'この記録の状態は、決まった画面の手順でだけ変わります', code: 'STATE_CHANGED_BY_SERVICE' }
export const serviceStateOnly = (type: string) => SERVICE_STATE_TYPES.includes(type)

/**
 * Linking a file to a record that may not reach it (a file the member cannot
 * read, or one inside a private folder for a record outside it): one answer
 * for both, naming no place (a private folder's name never leaks).
 */
export const FILE_NOT_LINKABLE = {
  error: 'このファイルはこの記録につなげません。あなたが見られないファイルか、この記録を見る人には見せられない場所のファイルです。',
  code: 'FILE_NOT_LINKABLE',
}

/**
 * A record link on create whose target the member cannot see: a missing record,
 * another member's owner-only record and an unreadable private one all get this
 * one answer (records.md "Owner-only records").
 */
export const LINK_TARGET_NOT_FOUND = { error: 'つなぐ先の記録が見つかりません', code: 'LINK_TARGET_NOT_FOUND' }

/**
 * A folder a server-only record cannot be placed in — inside a private folder (readable or not),
 * one the member cannot read, or one that is not in the company folder: one answer, so it never
 * tells whether a private folder of that name exists (audit B-M1, private-folders.md decision B).
 */
export const FOLDER_NOT_PLACEABLE = {
  error: 'このフォルダには記録を置けません。部署のフォルダを選んでください（非公開のフォルダや、会社のフォルダにまだ無いフォルダには置けません）',
  code: 'FOLDER_NOT_PLACEABLE',
} as const

/**
 * A company without the shared folder (services/company-folder.ts): a file path names a place on
 * one member's PC, which nobody else can open or check — new file links, attached versions and
 * file materials are refused. Null when the company has its folder (or the engine was not told).
 */
export function fileLinksUnavailable(hasCompanyFolder: ((companyId: string) => boolean) | undefined, companyId: string) {
  return hasCompanyFolder && !hasCompanyFolder(companyId)
    ? conflict(NO_COMPANY_FOLDER_FILE_LINK.error, NO_COMPANY_FOLDER_FILE_LINK.code)
    : null
}

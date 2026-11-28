// The inbox's own calls to the main process (src/shared/ipc/electron-api.ts), each a small port: the member's role in the
// company for 「知らせの設定」 (besides the notices' port, features/notifications/api.ts), and 「連絡」1枚's read and its two
// writes (inbox.md "One contact"), all with the member's session in main.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { ContactFinishAnswer, ContactFinishRequest, ContactReadResult, ContactUndoAnswer, ContactUndoRequest } from '../../../shared/contact-card'

/** The companies the member belongs to, with their role in each. */
export type CompanyRoleReads = ElectronPort<'getCompanies'>

/** Whether the member is an owner / admin of the company; null when it cannot be told (offline, not listed). */
export async function hasFullAccessIn(companyId: string, reads: CompanyRoleReads = window.electronAPI): Promise<boolean | null> {
  const r = await reads.getCompanies().catch(() => null)
  const role = r?.success ? r.data?.find(c => c.id === companyId)?.role : undefined
  return role === undefined ? null : role === 'owner' || role === 'admin'
}

/** Reading one contact (an interaction, or a 返事のお願い of it), and whether its mail stays archived in Gmail. */
export type ContactReads = ElectronPort<'getContact' | 'getContactArchived'>
/** Ending a contact's 返事のお願い with its 「済んだ」, and taking that back: both records or neither (the server's). */
export type ContactWrites = ElectronPort<'finishContact' | 'undoContactFinish'>

const UNREACHED = { success: false as const, gone: false, offline: true, error: 'アプリの中でうまくつながりませんでした。少し待ってから、もう一度押してください' }

export function readContact(companyId: string, recordId: string, reads: ContactReads = window.electronAPI): Promise<ContactReadResult> {
  // No answer at all (an older main without the channel) reads as not reached, never as a contact.
  return reads.getContact(companyId, recordId).then(r => r ?? UNREACHED, () => UNREACHED)
}

/** Not known (offline, an older main) → false: the card says nothing rather than something wrong. */
export function contactMailStaysArchived(companyId: string, interactionId: string, afterVersion: number, reads: ContactReads = window.electronAPI): Promise<boolean> {
  return reads.getContactArchived(companyId, interactionId, afterVersion).then(r => !!r?.success && r.stays, () => false)
}

const NOT_SENT = { ...UNREACHED, code: null, part: null }

export function finishContact(companyId: string, interactionId: string, input: ContactFinishRequest, writes: ContactWrites = window.electronAPI): Promise<ContactFinishAnswer> {
  return writes.finishContact(companyId, interactionId, input).then(r => r ?? NOT_SENT, () => NOT_SENT)
}

export function undoContactFinish(companyId: string, interactionId: string, input: ContactUndoRequest, writes: ContactWrites = window.electronAPI): Promise<ContactUndoAnswer> {
  return writes.undoContactFinish(companyId, interactionId, input).then(r => r ?? NOT_SENT, () => NOT_SENT)
}

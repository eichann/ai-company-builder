import {
  automaticConsultationsOf, forgottenAutomatic, readAutomaticConsultations, rememberedAutomatic,
  type AutomaticConsultation, type AutomaticConsultations, type ConsultationHold,
} from './aiTurns'

// The automatic 「AI の番」 consultations (ai-turns.md "Closing the consultation"): which record each
// was about, remembered per member and company on this PC (localStorage, so a restart still knows),
// and what each open tab holds now (registered by the tab, read when the runner or a record's end
// decides whether to close it). The rules are pure in aiTurns.ts.

const holds = new Map<string, () => ConsultationHold>()

/** A mounted tab says how to read what it holds; returns the unregister. */
export function registerConsultationHold(tabId: string, read: () => ConsultationHold): () => void {
  holds.set(tabId, read)
  return () => { if (holds.get(tabId) === read) holds.delete(tabId) }
}

/** What that tab holds now (undefined: not mounted here). */
export function consultationHoldOf(tabId: string): ConsultationHold | undefined {
  return holds.get(tabId)?.()
}

const storageKey = (companyId: string, userId: string) => `aiTurnConsultations:${companyId}:${userId}`

function read(key: string): AutomaticConsultations {
  try { return readAutomaticConsultations(JSON.parse(localStorage.getItem(key) ?? 'null')) } catch { return [] }
}

function write(key: string, list: AutomaticConsultations): void {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* unavailable: a record's end then closes nothing */ }
}

/** The run's consultation sent the app's first message (`messageId`) about its record. */
export function rememberAutomaticConsultation(companyId: string, userId: string, sessionId: string, recordId: string, messageId: string): void {
  const key = storageKey(companyId, userId)
  write(key, rememberedAutomatic(read(key), sessionId, recordId, messageId))
}

/** The automatic consultations of that record. */
export function automaticConsultationsFor(companyId: string, userId: string, recordId: string): AutomaticConsultation[] {
  return automaticConsultationsOf(read(storageKey(companyId, userId)), recordId)
}

/** These were closed: nothing more to do for them. */
export function forgetAutomaticConsultations(companyId: string, userId: string, sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  const key = storageKey(companyId, userId)
  write(key, forgottenAutomatic(read(key), sessionIds))
}

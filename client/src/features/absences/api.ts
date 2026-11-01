// Settings → 「不在と代わりの人」's access to the main process (src/shared/ipc/electron-api.ts):
// small ports, each function taking its port last (default window.electronAPI).
// Main asks the company server with the member's session.
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { AbsenceAddInput } from '../../../shared/absences'

/** The member's absences, whom they cover today, and the members for the picker. */
export type AbsencesReads = ElectronPort<'getAbsences'>
/** Adding and removing the member's own absences (kept on the server). */
export type AbsencesWrites = ElectronPort<'addAbsence' | 'removeAbsence'>

export function getAbsences(companyId: string, reads: AbsencesReads = window.electronAPI) {
  return reads.getAbsences(companyId)
}

export function addAbsence(companyId: string, input: AbsenceAddInput, writes: AbsencesWrites = window.electronAPI) {
  return writes.addAbsence(companyId, input)
}

export function removeAbsence(companyId: string, absenceId: string, writes: AbsencesWrites = window.electronAPI) {
  return writes.removeAbsence(companyId, absenceId)
}

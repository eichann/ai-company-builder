/**
 * How a company runs a business plugin's step (owner decisions 2026-11-06, plan 「仕事から Skill で
 * 成果物まで」; `.claude/rules/plugin-steps.md` "Starting by itself" / "The deliverable folder").
 *
 * - **Start**: a `start: person` step stays a button unless the company chose 「自動で始める」 for
 *   it. Run automatically, the step reads outside text (minutes) with nobody watching, so its
 *   ceiling loses every tool that reaches outside (`automaticStepCeiling`): web research (the
 *   question goes out) and every connector role that sends. The declaration never changes.
 * - **The deliverable folder**: whatever runs the step (the automatic run, or a person's
 *   consultation started from it) writes files only under `<department>/.personal/<folder>/` —
 *   the member's own, never synced. `<folder>` is the company's setting per step, else the step's
 *   label when it is a folder name, else the step's name.
 *
 * Pure (shared/core): the server, the app and the admin console use this one copy.
 */
import { CONNECTOR_ROLES, isConnectorRole } from './connector-roles'
import { isValidFolderName } from './names'
import { foldAsciiCase } from './paths'

/** The company's choice of how a step starts. */
export type StepStartChoice = 'auto' | 'button'

/** Step tools that reach outside: never in an automatic run of a person's step. */
export const OUTBOUND_STEP_TOOLS: readonly string[] = ['web_research']

/** The personal folder's name (never synced, `[PERSONAL_PATH]`). */
export const PERSONAL_FOLDER = '.personal'

/** At most this many characters in a deliverable folder's name. */
export const DELIVERABLE_FOLDER_MAX = 60

/** Whether a connector role (`mail.read`, bare `meetings`…) only reads: its operation, or every operation of a bare role, is `read`. */
export function connectorRoleOnlyReads(role: string): boolean {
  const [name, op] = role.split('.')
  if (!isConnectorRole(name)) return false
  const ops: readonly string[] = CONNECTOR_ROLES[name].operations
  return op === undefined ? ops.every(o => o === 'read') : op === 'read' && ops.includes(op)
}

/**
 * The ceiling of a step run automatically although it is declared `start: person`: the declared
 * tools without the outbound ones, the declared connector roles that only read. Never wider than
 * the declaration (a filter of it).
 */
export function automaticStepCeiling<S extends { tools: readonly string[]; connectorRoles: readonly string[] }>(step: S): S {
  return {
    ...step,
    tools: step.tools.filter(t => !OUTBOUND_STEP_TOOLS.includes(t)),
    connectorRoles: step.connectorRoles.filter(connectorRoleOnlyReads),
  }
}

/** Why a deliverable folder's name cannot be used (Japanese), or null. One folder name: no `/`, never hidden. */
export function deliverableFolderProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return '置き場所のフォルダ名を入れてください'
  if (name !== name.normalize('NFC')) return 'フォルダ名の文字の形が正しくありません'
  if (name.length > DELIVERABLE_FOLDER_MAX) return `フォルダ名は${DELIVERABLE_FOLDER_MAX}文字までにしてください`
  if (!isValidFolderName(name)) return 'フォルダ名は1つの名前で、記号は . _ - だけにしてください（/ や空白は使えません。. で始めることもできません）'
  return null
}

/** The step's deliverable folder: the company's setting, else its label when that is a folder name, else its name. */
export function deliverableFolderOf(stepName: string, label: string, chosen: string | null | undefined): string {
  if (chosen && deliverableFolderProblem(chosen) === null) return chosen
  const fromLabel = label.normalize('NFC')
  return deliverableFolderProblem(fromLabel) === null ? fromLabel : stepName
}

const key = (s: string) => foldAsciiCase(s.normalize('NFC'))

/**
 * Whether a path relative to the company folder ('/'-separated) is inside a step's deliverable
 * folder: `<department>/.personal/<folder>/<something>`. The department is a visible top folder;
 * `.` / `..` / empty segments anywhere refuse (judge the resolved path, never a spelling).
 * NFC and A–Z folded, as the disk folds them.
 */
export function insideDeliverableFolder(relativePath: string, folder: string): boolean {
  return insideDeliverableAt(relativePath, null, folder)
}

/**
 * The same at a named place (a scheduled job's grant, `jobs.md`: `<place>/.personal/<folder>/<something>`),
 * the place's segments compared as the disk folds them; `place` null = any visible top folder (a step's).
 */
export function insideDeliverableAt(relativePath: string, place: string | null, folder: string): boolean {
  if (deliverableFolderProblem(folder) !== null) return false
  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) return false
  const head = place === null ? 1 : place.split('/').length
  if (place !== null) {
    const want = place.split('/')
    if (want.some(s => s === '' || s === '.' || s === '..') || want.some((s, i) => key(s) !== key(segments[i] ?? ''))) return false
  }
  if (segments.length < head + 3) return false
  const department = segments[0]
  return !department.startsWith('.') && key(segments[head]) === PERSONAL_FOLDER && key(segments[head + 1]) === key(folder)
}


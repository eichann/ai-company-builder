// The 権限 screen's per-place choice, like sharing settings in a file service:
//
//   上の階層と同じ  → no rules here (the nearest ancestor with rules decides)
//   全員            → everyone: edit
//   指定した人だけ  → everyone: read only + one edit rule per chosen member / role /
//                    department (the people who belong to it, 所属)
//
// These helpers convert between that choice and the server's rule rows, and
// compute who can edit under a choice before it is saved with the server's
// own rule, shared/core/permissions.ts (owner/admin always edit; on the
// deciding scope a user rule beats a department rule beats a role rule beats
// the everyone rule).
import { applicableRules, resolveAccess, type ScopeRule, type ScopeWithRules } from '../../../shared/core/permissions'
import type { EffectiveMember, Member, PermissionRule, RuleInput } from './api'

export type EditMode = 'inherit' | 'everyone' | 'specific'

/** Someone who may edit under 指定した人だけ: one member, every member by role, or the people who belong to a department. */
export type Editor =
  | { subjectType: 'user'; subjectId: string }
  | { subjectType: 'role'; subjectId: 'member' }
  | { subjectType: 'department'; subjectId: string }

/**
 * Departments as a department rule needs them in the browser: its name, and
 * who belongs to it now (the server sends `memberIds` with each department
 * rule; a department chosen in the draft is looked up here).
 */
export interface DepartmentLookup {
  name(departmentId: string): string | undefined
  memberIds(departmentId: string): readonly string[] | undefined
}

/** 「営業部に所属する人」 (the server's words for a department rule). */
export function departmentEditorName(name: string | undefined): string {
  return `${name ?? '（削除された部署）'}に所属する人`
}

export interface AccessDraft {
  mode: EditMode
  /** Only used when mode is 'specific'. */
  editors: Editor[]
}

export const ROLE_MEMBER_EDITOR: Editor = { subjectType: 'role', subjectId: 'member' }

export function editorKey(e: { subjectType: string; subjectId: string | null }): string {
  return `${e.subjectType}:${e.subjectId ?? ''}`
}

/** Would `draft` let this subject edit? (for subjects that are not owner/admin) */
function grants(draft: AccessDraft, subject: Pick<PermissionRule, 'subjectType' | 'subjectId'>): boolean {
  if (draft.mode === 'everyone') return true
  const keys = new Set(draft.editors.map(editorKey))
  if (subject.subjectType === 'role' || subject.subjectType === 'department') return keys.has(editorKey(subject))
  if (subject.subjectType === 'user') return keys.has(editorKey(subject)) || keys.has(editorKey(ROLE_MEMBER_EDITOR))
  return false
}

/**
 * The choice that a place's own rules express. `custom` is true when the rules
 * say something the three choices cannot (e.g. 全員 can edit but one member
 * is read-only — made with the earlier rule editor): the closest choice is
 * returned, and saving it would change that member's access.
 */
export function draftFromRules(rules: PermissionRule[]): { draft: AccessDraft; custom: boolean } {
  if (rules.length === 0) return { draft: { mode: 'inherit', editors: [] }, custom: false }
  const everyone = rules.filter((r) => r.subjectType === 'everyone')
  const everyoneWrites = everyone.some((r) => r.canWrite)
  const draft: AccessDraft = everyoneWrites
    ? { mode: 'everyone', editors: [] }
    : {
        mode: 'specific',
        editors: rules
          // A group rule (only without the shared folder) is no choice of this editor: 個別の設定 below.
          .filter((r) => r.subjectType !== 'everyone' && r.subjectType !== 'group' && r.canWrite)
          .map((r): Editor =>
            r.subjectType === 'role'
              ? ROLE_MEMBER_EDITOR
              : { subjectType: r.subjectType === 'department' ? 'department' : 'user', subjectId: r.subjectId ?? '' }
          ),
      }
  const custom =
    everyone.length === 0 ||
    rules.some((r) => r.subjectType === 'group') ||
    rules.some((r) => r.subjectType === 'role' && r.subjectId !== 'member') ||
    rules.some((r) => r.subjectType !== 'everyone' && r.canWrite !== grants(draft, r))
  return { draft, custom }
}

/** The complete rule set to save for a choice. */
export function rulesFromDraft(draft: AccessDraft): RuleInput[] {
  if (draft.mode === 'inherit') return []
  if (draft.mode === 'everyone') return [{ subjectType: 'everyone', subjectId: null, canWrite: true }]
  return [{ subjectType: 'everyone', subjectId: null, canWrite: false }, ...draft.editors.map((e) => ({ ...e, canWrite: true }))]
}

export function sameDraft(a: AccessDraft, b: AccessDraft): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode !== 'specific') return true
  const ka = a.editors.map(editorKey).sort()
  const kb = b.editors.map(editorKey).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i])
}

/** The rules of a place's own rule set as inputs (to send back for 元に戻す). */
export function rulesAsInputs(rules: PermissionRule[]): RuleInput[] {
  return rules.map((r) =>
    r.subjectType === 'everyone'
      ? { subjectType: 'everyone', subjectId: null, canWrite: r.canWrite }
      : r.subjectType === 'role'
        ? { subjectType: 'role', subjectId: 'member', canWrite: r.canWrite }
        : r.subjectType === 'department' || r.subjectType === 'group'
          ? { subjectType: r.subjectType, subjectId: r.subjectId ?? '', canWrite: r.canWrite }
          : { subjectType: 'user', subjectId: r.subjectId ?? '', canWrite: r.canWrite }
  )
}

const memberName = (m: Pick<Member, 'name' | 'email'>) => m.name || m.email || '名前未設定'

/** A rule as a person reads it: 全員 / 役割「メンバー」 / 営業部に所属する人 / a name. */
export function subjectName(
  s: Pick<PermissionRule, 'subjectType' | 'subjectId'> & { subjectLabel?: string },
  members: Member[],
  departments?: DepartmentLookup
): string {
  if (s.subjectType === 'everyone') return '全員'
  if (s.subjectType === 'role') return '役割「メンバー」'
  if (s.subjectType === 'department') {
    const name = departments?.name(s.subjectId ?? '')
    return name !== undefined || !s.subjectLabel ? departmentEditorName(name) : s.subjectLabel
  }
  if (s.subjectType === 'group') return s.subjectLabel || '見える人のまとまり'
  const m = members.find((x) => x.userId === s.subjectId)
  return m ? memberName(m) : s.subjectLabel || '（退会したメンバー）'
}

/** One line for a rule set: 全員 / 指定した人だけ（田中 太郎、役割「メンバー」） / … */
export function describeRules(rules: PermissionRule[], members: Member[], departments?: DepartmentLookup): string {
  if (rules.length === 0) return 'オーナーと管理者だけ'
  const { draft, custom } = draftFromRules(rules)
  if (custom) return '個別の設定'
  if (draft.mode === 'everyone') return '全員'
  if (draft.editors.length === 0) return '指定した人だけ（オーナーと管理者のみ）'
  const labelOf = (e: Editor) => rules.find((r) => editorKey(r) === editorKey(e))?.subjectLabel
  const names = draft.editors.map((e) => subjectName({ ...e, subjectLabel: labelOf(e) }, members, departments))
  const shown = names.slice(0, 2).join('、')
  return `指定した人だけ（${shown}${names.length > 2 ? ` ほか${names.length - 2}件` : ''}）`
}

/**
 * Who can read / edit under `rules` (the rules of the deciding place, at
 * `decidingPath`), in the shape the preview shows — computed in the browser
 * so the preview follows the choice before it is saved.
 */
export function previewAccess(
  members: Member[],
  rules: PermissionRule[] | RuleInput[],
  decidingPath: string,
  departments?: DepartmentLookup
): EffectiveMember[] {
  // The server's own evaluation (shared/core/permissions.ts resolveAccess):
  // the deciding place as the one scope with rules. A rule input without a
  // read flag lets its subject read (the server's default). A
  // department rule grants the people who belong to it: as the server sent
  // them with the rule, else as `departments` knows them (nobody when unknown).
  const scopeRules: ScopeRule[] = rules.map((r, i) => ({
    id: `preview-${i}`,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    canRead: r.canRead ?? true,
    canWrite: r.canWrite,
    ...(r.subjectType === 'department'
      ? { memberIds: ('memberIds' in r && r.memberIds) || departments?.memberIds(r.subjectId ?? '') || [] }
      : r.subjectType === 'group'
        ? { memberIds: ('memberIds' in r && r.memberIds) || [] }
        : {}),

  }))
  const scope: ScopeWithRules = { id: 'preview', path: decidingPath, kind: 'folder', departmentId: null, repoId: null, rules: scopeRules }
  return members.map((m) => {
    const base = { userId: m.userId, name: m.name, email: m.email, role: m.role }
    const access = resolveAccess('', m.userId, decidingPath, { getMemberRole: () => m.role, listScopes: () => [scope] })
    if (access.source.reason === 'role') return { ...base, read: true, write: true, reason: 'role' as const, decidedBy: null }
    const first = applicableRules(scopeRules, m.userId, m.role)[0]
    return {
      ...base,
      read: access.read,
      write: access.write,
      reason: access.source.reason,
      decidedBy: first
        ? {
            scopeId: '',
            path: decidingPath,
            subjectType: first.subjectType,
            subjectLabel:
              first.subjectType === 'everyone'
                ? '全員'
                : first.subjectType === 'role'
                  ? 'メンバー'
                  : first.subjectType === 'department'
                    ? departmentEditorName(departments?.name(first.subjectId ?? ''))
                    : memberName(m),
          }
        : null,
    }
  })
}

/** Members who can edit under `before` but not under `after`. */
export function losingEdit(before: EffectiveMember[], after: EffectiveMember[]): EffectiveMember[] {
  const now = new Map(after.map((m) => [m.userId, m.write]))
  return before.filter((m) => m.write && now.get(m.userId) === false)
}

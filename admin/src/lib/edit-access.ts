// The 権限 screen's per-place choice, like sharing settings in a file service:
//
//   上の階層と同じ  → no rules here (the nearest ancestor with rules decides)
//   全員            → everyone: edit
//   指定した人だけ  → everyone: read only + one edit rule per chosen member / role
//
// These helpers convert between that choice and the server's rule rows, and
// compute who can edit under a choice before it is saved with the server's
// own rule, shared/core/permissions.ts (owner/admin always edit; on the
// deciding scope a user rule beats a role rule beats the everyone rule).
import { applicableRules, resolveAccess, type ScopeRule, type ScopeWithRules } from '../../../shared/core/permissions'
import type { EffectiveMember, Member, PermissionRule, RuleInput } from './api'

export type EditMode = 'inherit' | 'everyone' | 'specific'

/** Someone who may edit under 指定した人だけ: one member, or every member by role. */
export type Editor = { subjectType: 'user'; subjectId: string } | { subjectType: 'role'; subjectId: 'member' }

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
  if (subject.subjectType === 'role') return keys.has(editorKey(subject))
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
          .filter((r) => r.subjectType !== 'everyone' && r.canWrite)
          .map((r): Editor => (r.subjectType === 'role' ? ROLE_MEMBER_EDITOR : { subjectType: 'user', subjectId: r.subjectId ?? '' })),
      }
  const custom =
    everyone.length === 0 ||
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
        : { subjectType: 'user', subjectId: r.subjectId ?? '', canWrite: r.canWrite }
  )
}

const memberName = (m: Pick<Member, 'name' | 'email'>) => m.name || m.email || '名前未設定'

/** A rule as a person reads it: 全員 / 役割「メンバー」 / a name. */
export function subjectName(s: Pick<PermissionRule, 'subjectType' | 'subjectId'> & { subjectLabel?: string }, members: Member[]): string {
  if (s.subjectType === 'everyone') return '全員'
  if (s.subjectType === 'role') return '役割「メンバー」'
  const m = members.find((x) => x.userId === s.subjectId)
  return m ? memberName(m) : s.subjectLabel || '（退会したメンバー）'
}

/** One line for a rule set: 全員 / 指定した人だけ（田中 太郎、役割「メンバー」） / … */
export function describeRules(rules: PermissionRule[], members: Member[]): string {
  if (rules.length === 0) return 'オーナーと管理者だけ'
  const { draft, custom } = draftFromRules(rules)
  if (custom) return '個別の設定'
  if (draft.mode === 'everyone') return '全員'
  if (draft.editors.length === 0) return '指定した人だけ（オーナーと管理者のみ）'
  const names = draft.editors.map((e) => subjectName(e, members))
  const shown = names.slice(0, 2).join('、')
  return `指定した人だけ（${shown}${names.length > 2 ? ` ほか${names.length - 2}件` : ''}）`
}

/**
 * Who can read / edit under `rules` (the rules of the deciding place, at
 * `decidingPath`), in the shape the preview shows — computed in the browser
 * so the preview follows the choice before it is saved.
 */
export function previewAccess(members: Member[], rules: PermissionRule[] | RuleInput[], decidingPath: string): EffectiveMember[] {
  // The server's own evaluation (shared/core/permissions.ts resolveAccess):
  // the deciding place as the one scope with rules. A rule input carries no
  // read flag: every rule the console writes lets its subject read.
  const scopeRules: ScopeRule[] = rules.map((r, i) => ({
    id: `preview-${i}`,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    canRead: 'canRead' in r ? r.canRead : true,
    canWrite: r.canWrite,
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
            subjectLabel: first.subjectType === 'everyone' ? '全員' : first.subjectType === 'role' ? 'メンバー' : memberName(m),
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

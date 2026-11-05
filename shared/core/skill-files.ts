/**
 * Skill files — everything under `.claude/skills/`, `.claude/agents/` and
 * `.claude/commands/` at any depth (A–Z case-insensitive; a file or link at
 * one of those paths counts too), every file type. Sync gives these files to
 * every member, and a skill's script then runs on that member's computer,
 * under their account and tokens, so whoever changes one runs code as a
 * teammate.
 *
 * Who may add, change, delete or rename them: owners and admins everywhere; a
 * department manager inside a department they manage; people named on
 * 「Skill を直せる人」 (the `skill_editors` rows): for the whole company, or
 * inside one department. Anyone else is refused by the push check
 * ([PROTECTED_CONFIG]) and, ahead of time, by the desktop app. The auto-run
 * parts of a skill (hooks, `!` commands, links) stay owner/admin only, whoever
 * else may edit the file: that is the push check's separate rule.
 *
 * The push checker matches git's raw bytes (read as latin1) with a regex built
 * from SKILL_FOLDER_NAMES (server/src/lib/push-check/rules.ts), and non-ASCII
 * paths also through lookalikeKey, as isSkillFile does: `.claude/ſkills/x` lands
 * in `.claude/skills/` on a Mac.
 *
 * Pure: no Node, Electron, React, Hono, database or git.
 */
import { instructionFileInManagedFolder } from './instruction-files'
import { FULL_ACCESS_ROLES } from './permissions'
import { lookalikeKey } from './paths'

/** The folders of `.claude/` that hold skills, subagents and slash commands. */
export const SKILL_FOLDER_NAMES: readonly string[] = ['skills', 'agents', 'commands']

const SKILL_PATH_RE = new RegExp(`(^|/)\\.claude/(${SKILL_FOLDER_NAMES.join('|')})(/|$)`)

/** One member's place on 「Skill を直せる人」. */
export interface SkillEditing {
  /** Named for the whole company: every skill, in every folder. */
  everywhere: boolean
  /** Department folders (NFC company paths) they are named for. */
  folders: readonly string[]
}

export const NO_SKILL_EDITING: SkillEditing = { everywhere: false, folders: [] }

/** Is `repoPath` inside (or at) a skills / agents / commands folder of `.claude/`? */
export function isSkillFile(repoPath: string): boolean {
  return SKILL_PATH_RE.test(lookalikeKey(repoPath))
}

/** May someone who manages `managedFolders` and holds `skillEditing` change `path`? Owner/admin are decided before this. */
export function skillFileAllowed(path: string, managedFolders: readonly string[], skillEditing: SkillEditing): boolean {
  if (skillEditing.everywhere) return true
  return instructionFileInManagedFolder(path, [...managedFolders, ...skillEditing.folders])
}

/** May a member change the skill file at `path`? */
export function mayChangeSkillFile(authority: { role: string; managedFolders: readonly string[]; skillEditing: SkillEditing }, path: string): boolean {
  if (FULL_ACCESS_ROLES.has(authority.role)) return true
  return skillFileAllowed(path, authority.managedFolders, authority.skillEditing)
}

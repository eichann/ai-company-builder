/**
 * API shapes of 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval", redesign step ⑥): the
 * company's Skills that carry a `browser.yaml`, their declaration as the server read it, and whether that version is
 * approved. Owners / admins list, approve, pre-approve and revoke. The declaration's values are the company's data.
 */
export type BrowserSkillApprovalMode = 'per_run' | 'pre_approved'
export const BROWSER_SKILL_APPROVAL_MODES: readonly BrowserSkillApprovalMode[] = ['per_run', 'pre_approved']

/**
 * - `waiting`: this declaration has no approval (new, changed by someone other than an owner / admin, or approved earlier
 *   in another version);
 * - `approved` / `pre_approved`: approved for this declaration (each run's card / no card);
 * - `text_changed`: approved, but the Skill's other files changed since — the next run shows the card once;
 * - `revoked`: an owner / admin took the approval back;
 * - `invalid`: the declaration cannot be used (its problem says why) — it cannot be approved.
 */
export type BrowserSkillStatus = 'waiting' | 'approved' | 'pre_approved' | 'text_changed' | 'revoked' | 'invalid'

export interface BrowserSkillApprovalInfo {
  mode: BrowserSkillApprovalMode
  /** `approved`: pressed on 「Skill の承認」; `edited`: an owner / admin changed the declaration (counts as approving it). */
  how: 'approved' | 'edited'
  approvedBy: string
  approvedByName: string | null
  approvedAt: string
}

export interface BrowserSkillView {
  /** The Skill's folder name. Two departments may each have one of this name: `path` tells them apart. */
  name: string
  /**
   * Which Skill it is: `.claude/skills/<name>` (the company's) or `<department folder>/.claude/skills/<name>` (a
   * department's). Approving and revoking send it back as `skill`.
   */
  path: string
  /** The department folder the Skill belongs to, or null for the company's. */
  department: string | null
  /** `sha256:` of `browser.yaml` as the server read it: what an approval is for. */
  declarationHash: string
  /** The whole folder's version as the server read it (sent back with an approval: the version shown). */
  files: string
  status: BrowserSkillStatus
  /** Plain Japanese when `invalid`, else null. */
  problem: string | null
  /** The declaration (null when `invalid`). */
  domain: string | null
  /** Each write target in plain words. */
  writes: string[]
  neverRead: string[]
  afterRead: string[]
  accountMarker: string | null
  /** The approval in force for this declaration (null: none). */
  approval: BrowserSkillApprovalInfo | null
}

/** GET /browser-skill-approvals (owner/admin). */
export interface BrowserSkillsView {
  items: BrowserSkillView[]
  /**
   * Every place was looked into. False: too many top folders or Skills, or a folder whose name is not in NFC — a Skill
   * may be missing from `items` (the page says so). Absent from an older server: read as true.
   */
  complete?: boolean
}

/** POST /browser-skill-approvals: approve exactly the declaration the admin saw. */
export interface BrowserSkillApproveBody {
  /** The Skill's path (`BrowserSkillView.path`); a bare name means the company's `.claude/skills/<name>`. */
  skill: string
  declarationHash: string
  files: string
  mode: BrowserSkillApprovalMode
}

/** POST /browser-skill-approvals/revoke */
export interface BrowserSkillRevokeBody {
  skill: string
}

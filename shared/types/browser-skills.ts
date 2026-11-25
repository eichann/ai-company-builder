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
  /** The Skill's folder name (`.claude/skills/<name>`). */
  name: string
  /** `sha256:` of `browser.yaml` as the server read it: what an approval is for. */
  declarationHash: string
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
}

/** POST /browser-skill-approvals: approve exactly the declaration the admin saw. */
export interface BrowserSkillApproveBody {
  skill: string
  declarationHash: string
  mode: BrowserSkillApprovalMode
}

/** POST /browser-skill-approvals/revoke */
export interface BrowserSkillRevokeBody {
  skill: string
}

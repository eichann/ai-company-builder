/**
 * 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"). Two ports:
 *
 * - `BrowserSkillApprovalRepository`, from the company handle (`CompanyData`): every method limited to that company.
 * - `BrowserSkillSource`: the company's own copy of its Skills — the shared branch of the company repository for a
 *   company with the shared folder, the Skill shelf for one without. **Never what an app sent.** Rules:
 *   services/browser-skills.ts.
 */
export interface BrowserSkillApprovalRow {
  seq: number
  skillPath: string
  declarationHash: string
  /** shared/types/browser-skills.ts `BrowserSkillApprovalMode` (ports import no API shapes). */
  mode: 'per_run' | 'pre_approved'
  how: 'approved' | 'edited'
  approvedBy: string
  approvedAt: string
  filesSeen: string | null
  revokedAt: string | null
  revokedBy: string | null
}

export type BrowserSkillApprovalInsert = Omit<BrowserSkillApprovalRow, 'seq' | 'revokedAt' | 'revokedBy'>

export interface BrowserSkillApprovalRepository {
  /** The skill's latest row, or null. */
  latest(skillPath: string): BrowserSkillApprovalRow | null
  insert(row: BrowserSkillApprovalInsert): BrowserSkillApprovalRow
  /** Revoke row `seq` when it is still the skill's latest and not revoked; false otherwise. */
  revoke(seq: number, at: string, by: string): boolean
  setFilesSeen(seq: number, files: string): void
}

/** One Skill as the server's own copy holds it. */
export interface BrowserSkillContent {
  /**
   * Its identity: `.claude/skills/<name>` (the company's) or `<department>/.claude/skills/<name>` (a department's),
   * shared/core/browser-skill.ts `parseBrowserSkillPath`; as the server's copy spells it (the department folder as stored).
   */
  path: string
  /** `browser.yaml`'s text, or `too-large` (never read whole). */
  declaration: string | 'too-large'
  /** The whole folder's fingerprint (`git:<tree id>` / `shelf:<version>`): moves when any file of the Skill changes. */
  files: string
}

/** A Skill as one change left it, and whether that change touched `browser.yaml` (added or changed it). */
export interface BrowserSkillLanded extends BrowserSkillContent {
  declarationChanged: boolean
  /** `browser.yaml` right before this change (null: there was none; `too-large`: never read whole). */
  previousDeclaration: string | null
}

export interface BrowserSkillSource {
  /**
   * The company's and its departments' Skills that carry `browser.yaml`, by path (sorted, bounded) — never one inside a
   * private folder (its own repository; its name must not leak).
   */
  list(companyId: string): Promise<string[]>
  /** One Skill now, by its path (null: no such Skill, no `browser.yaml` in it, not a Skill path, or a private folder's). */
  read(companyId: string, path: string): Promise<BrowserSkillContent | null>
  /**
   * What one accepted push to the company repository changed (`<old> <new> <ref>` lines the push checker accepted): the
   * company's and departments' Skills with `browser.yaml` that it touched, each read **at the pushed commit** (not the
   * tip, which may already be someone else's).
   */
  pushed(companyId: string, refUpdates: string): Promise<BrowserSkillLanded[]>
  /**
   * A shelf Skill (the company's, `departmentId` null, or a department's) at exactly the version one publish wrote,
   * against the version current before it (null: none).
   */
  shelfLanded(companyId: string, item: { departmentId: string | null; name: string }, versions: { before: string | null; written: string }): Promise<BrowserSkillLanded | null>
}

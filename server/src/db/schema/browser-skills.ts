/**
 * 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval", redesign step ⑥; owner decisions
 * 2026-11-25): which version of a company Skill's `browser.yaml` an owner / admin approved. **A new table only.**
 * Behind the company handle (ports/browser-skills.ts).
 *
 * - One row per approval, newest last (`seq`); only a skill's **latest** row counts, and only for the declaration hash it
 *   names: approving another version supersedes it, and a declaration put back to an older text needs approving again.
 * - `how`: `approved` (pressed on the admin page) or `edited` (an owner / admin changed the declaration: that counts as
 *   approving it, and who did is kept in `approved_by`).
 * - `files_seen`: the Skill's whole-folder fingerprint the approver saw, or the one a run's card was last shown for; a
 *   Skill whose files moved since shows the card once (step ⑤ marks it seen). Owners / admins are told 「手順が直りました」
 *   once per folder version by the notice's own dedupe key (no column here).
 * - Who, what and when are fixed once written (trigger); revoking sets `revoked_at` / `revoked_by` once.
 */
export const browserSkillSchema = `
    CREATE TABLE IF NOT EXISTS browser_skill_approvals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      skill_path TEXT NOT NULL,
      declaration_hash TEXT NOT NULL CHECK (declaration_hash GLOB 'sha256:*'),
      mode TEXT NOT NULL CHECK (mode IN ('per_run', 'pre_approved')),
      how TEXT NOT NULL CHECK (how IN ('approved', 'edited')),
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      files_seen TEXT,
      revoked_at TEXT,
      revoked_by TEXT,
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_browser_skill_approvals_skill ON browser_skill_approvals(company_id, skill_path, seq);
    CREATE TRIGGER IF NOT EXISTS browser_skill_approvals_fixed BEFORE UPDATE ON browser_skill_approvals
    WHEN NEW.company_id IS NOT OLD.company_id OR NEW.skill_path IS NOT OLD.skill_path OR NEW.declaration_hash IS NOT OLD.declaration_hash
      OR NEW.mode IS NOT OLD.mode OR NEW.how IS NOT OLD.how OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
      OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoked_by IS NOT OLD.revoked_by))
    BEGIN
      SELECT RAISE(ABORT, 'an approval is fixed once written (approve again instead)');
    END;
`

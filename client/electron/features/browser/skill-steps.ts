// A company Skill's steps for the operator of a write task (agent-browser.md "The operator works from the approved steps"):
// its `SKILL.md` and `site-notes.md`, read from the member's own company folder and joined by the core's one rule
// (shared/core/browser-skill-steps.ts), so `work.ts` can check them against the seal the server answered for the folder
// version its frames come from — steps that differ, are missing or would be cut are never handed to the operator.
// The frames themselves never come from here: the server builds them from the approved `browser.yaml` it reads itself.
// Which Skill is the server's word (the frames run's `skill`: the company's `.claude/skills/<name>` or a department's
// `<department>/.claude/skills/<name>`, "Department Skills"; an older server's bare name is the company's). Every path goes
// through the allowed roots (a link out of the company folder is refused); nothing but a Skill path is read.
import fs from 'node:fs/promises'
import path from 'node:path'
import { browserSkillPathOf, parseBrowserSkillPath } from '../../../../shared/core/browser-skill'
import { BROWSER_SKILL_STEP_FILES, BROWSER_SKILL_STEPS_LIMITS, browserSkillStepsText, type BrowserSkillStepFile, type BrowserSkillStepsText } from '../../../../shared/core/browser-skill-steps'
import { isValidSkillName } from '../../../../shared/core/names'

/** The Skill's steps on this PC (none when no step file is there), or null when `skill` names no Skill place. */
export async function readBrowserSkillSteps(companyRoot: string, skill: string, validate: (p: string) => string): Promise<BrowserSkillStepsText | null> {
  const place = parseBrowserSkillPath(isValidSkillName(skill) ? browserSkillPathOf(null, skill) : skill)
  if (!place) return null
  const files: BrowserSkillStepFile[] = []
  for (const name of BROWSER_SKILL_STEP_FILES) {
    let file: string
    let size: number
    try {
      file = validate(path.join(companyRoot, ...place.path.split('/'), name))
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      size = stat.size
    } catch {
      // Not there (a department not downloaded) or outside the folder: left out — the seal then says what is missing.
      continue
    }
    if (size > BROWSER_SKILL_STEPS_LIMITS.fileBytes) { files.push({ name, tooLarge: true }); continue }
    try {
      files.push({ name, text: await fs.readFile(file, 'utf8') })
    } catch {
      continue
    }
  }
  return browserSkillStepsText(files)
}

// A company Skill's steps for the operator of a write task (agent-browser.md "Writes within frames, in the app", step ⑤b):
// its `SKILL.md` and `site-notes.md`, read from the member's own company folder, handed to the operator as outside text.
// The frames themselves never come from here: the server builds them from the approved `browser.yaml` it reads itself.
// Which Skill is the server's word (the frames run's `skill`: the company's `.claude/skills/<name>` or a department's
// `<department>/.claude/skills/<name>`, "Department Skills"; an older server's bare name is the company's). Every path goes
// through the allowed roots (a link out of the company folder is refused); nothing but a Skill path is read.
import fs from 'node:fs/promises'
import path from 'node:path'
import { browserSkillPathOf, parseBrowserSkillPath } from '../../../../shared/core/browser-skill'
import { isValidSkillName } from '../../../../shared/core/names'

const FILES = ['SKILL.md', 'site-notes.md'] as const
const MAX_BYTES = 64 * 1024

export async function readBrowserSkillSteps(companyRoot: string, skill: string, validate: (p: string) => string): Promise<string | null> {
  const place = parseBrowserSkillPath(isValidSkillName(skill) ? browserSkillPathOf(null, skill) : skill)
  if (!place) return null
  const parts: string[] = []
  for (const name of FILES) {
    try {
      const file = validate(path.join(companyRoot, ...place.path.split('/'), name))
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_BYTES) continue
      parts.push(`# ${name}\n${await fs.readFile(file, 'utf8')}`)
    } catch {
      // Not there (a department not downloaded), outside the folder, unreadable: left out.
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

// A company Skill's steps for the operator of a write task (agent-browser.md "Writes within frames, in the app", step ⑤b):
// its `SKILL.md` and `site-notes.md`, read from the member's own company folder, handed to the operator as outside text.
// The frames themselves never come from here: the server builds them from the approved `browser.yaml` it reads itself.
// Every path goes through the allowed roots (a link out of the company folder is refused), the name is a Skill name.
import fs from 'node:fs/promises'
import path from 'node:path'
import { isValidSkillName } from '../../../../shared/core/names'

const FILES = ['SKILL.md', 'site-notes.md'] as const
const MAX_BYTES = 64 * 1024

export async function readBrowserSkillSteps(companyRoot: string, skill: string, validate: (p: string) => string): Promise<string | null> {
  if (!isValidSkillName(skill)) return null
  const parts: string[] = []
  for (const name of FILES) {
    try {
      const file = validate(path.join(companyRoot, '.claude', 'skills', skill, name))
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_BYTES) continue
      parts.push(`# ${name}\n${await fs.readFile(file, 'utf8')}`)
    } catch {
      // Not there, outside the folder, unreadable: left out.
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

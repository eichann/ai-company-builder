// Pure parts of skills: the SKILL.md a new skill starts with, renaming a
// copied one, and the slash commands the chat offers.
import type { DepartmentConfig, Skill } from '../../types'

export interface NewSkillInput { name: string; description: string; prompt: string; folderName: string }

/** The SKILL.md of a new skill (frontmatter + the sections the wizard fills in). */
export function newSkillMarkdown(data: NewSkillInput): string {
  const promptContent = data.prompt || `このスキルを実行すると、AIアシスタントが「${data.name}」タスクを実行します。`
  return `---
name: ${data.name}
description: ${data.description}
---

# ${data.name}

${data.description}

## AIへの指示

${promptContent}

## ルール

<!-- rules/ フォルダにルールファイルを追加してください -->

## 参考資料

<!-- references/ フォルダに参考資料を追加してください -->
`
}

/** A copied skill's SKILL.md with the new name in its frontmatter. */
export function renameSkillMarkdown(content: string, name: string): string {
  return content.replace(
    /^(---\n[\s\S]*?name:\s*).+$/m,
    `$1${name}`,
  )
}

export interface SkillCommand { command: string; name: string; description?: string; color?: string }

/** The chat's slash commands: the shown department's skills, then the company-wide ones, one per folder name. */
export function skillCommands(skills: Skill[], companySkills: Skill[], departments: DepartmentConfig[], isCompanyWide: boolean): SkillCommand[] {
  const allSkills = isCompanyWide
    ? skills // Already showing company-wide
    : [...skills, ...companySkills]
  // Deduplicate by command (folder name)
  const seen = new Set<string>()
  return allSkills
    .filter(s => s.skillPath)
    .map(s => {
      const command = s.skillPath!.split('/').pop() || ''
      const dept = departments.find(d => d.id === s.departmentId)
      return {
        command,
        name: s.name,
        description: s.description,
        color: dept?.color || '#6366f1',
      }
    })
    .filter(item => {
      if (!item.command || seen.has(item.command)) return false
      seen.add(item.command)
      return true
    })
}

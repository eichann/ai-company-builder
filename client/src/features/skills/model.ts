// Pure parts of skills: the SKILL.md a new skill starts with, renaming a
// copied one, and the slash commands the chat offers.
import type { DepartmentConfig } from '../../types'

/** A web app inside a skill's folder (`tools/<name>/`). */
export interface SkillTool {
  name: string           // Folder name (e.g., "movie-studio")
  displayName: string    // From package.json name or folder name
  path: string           // Absolute path to tool directory
  hasPackageJson: boolean
  startCommand?: string  // "dev" or "start"
  port?: number          // If running, the port number
}

export interface Skill {
  id: string
  name: string
  description: string
  icon?: string
  departmentId: string
  group?: string          // Hierarchy group label (e.g., "全社", "営業部", "営業部 / 顧客A案件")
  isPrivate?: boolean     // true = .gitignore に含まれ同期されない（不可逆: 公開したら戻せない）
  isNurturing?: boolean   // true = 育て中（SKILL.md frontmatter status: nurturing）
  skillPath?: string      // Absolute path to skill directory
  // File paths relative to department folder
  files: {
    skillMd?: string      // SKILL.md
    rules?: string[]      // Rule files
    references?: string[] // Reference files
    scripts?: string[]    // Script files
    tools?: SkillTool[]   // Web app tools
  }
}

export interface NewSkillInput { name: string; description: string; prompt: string; folderName: string }

/** What creating or copying a skill answers: the new skill's id, or why nothing was made (shown in the dialog). */
export type SkillActionResult = { id: string } | { error: string }

export function skillNameTakenMessage(folderName: string): string {
  return `フォルダ名「${folderName}」のスキルはすでにあります。別のフォルダ名にしてください（今あるスキルはそのままです）。`
}
export const SKILL_ALREADY_SHARED_MESSAGE = 'このフォルダ名のスキルはすでに会社で共有されています。別のフォルダ名にしてください。'
export const SKILL_CREATE_FAILED = 'スキルを作成できませんでした。もう一度試してください。'
export const SKILL_COPY_FAILED = 'スキルをコピーできませんでした。もう一度試してください。'

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

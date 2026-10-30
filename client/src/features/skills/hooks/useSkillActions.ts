import { useCallback } from 'react'
import type { DepartmentConfig, Skill } from '../../../types'
import { copySkill, createSkillDirectory, makeSkillPrivate, publishSkill, readSkillFile, setSkillNurturing, writeSkillFile } from '../api'
import { newSkillMarkdown, renameSkillMarkdown, type NewSkillInput } from '../model'

interface Options {
  rootPath: string | undefined
  departments: DepartmentConfig[]
  /** The shown department's folder; '' on 全社. */
  departmentFolder: string
  /** Prefix of the ids the skills list gives this department's skills. */
  departmentId: string
  refreshSkills: () => unknown
}

/**
 * Creating (private until shared), copying, sharing and marking skills 育成中.
 * Create and copy answer the new skill's id, or null when nothing was made.
 */
export function useSkillActions({ rootPath, departments, departmentFolder, departmentId, refreshSkills }: Options) {
  const createSkill = useCallback(async (data: NewSkillInput): Promise<string | null> => {
    if (!rootPath || !departmentFolder) return null

    // Use the provided folder name (already validated as alphanumeric with - and _)
    const skillDirName = data.folderName

    const skillsBasePath = `${rootPath}/${departmentFolder}/.claude/skills`
    const skillPath = `${skillsBasePath}/${skillDirName}`
    const skillMdPath = `${skillPath}/SKILL.md`

    try {
      // Create .claude/skills directory if it doesn't exist
      await createSkillDirectory(skillsBasePath)

      // Create skill directory
      await createSkillDirectory(skillPath)

      // Create subdirectories (always create these even if empty)
      await createSkillDirectory(`${skillPath}/rules`)
      await createSkillDirectory(`${skillPath}/references`)
      await createSkillDirectory(`${skillPath}/scripts`)
      await createSkillDirectory(`${skillPath}/tools`)

      await writeSkillFile(skillMdPath, newSkillMarkdown(data))

      // Default to private (not shared): add to .gitignore
      const skillRelativePath = `${departmentFolder}/.claude/skills/${skillDirName}/`
      await makeSkillPrivate(rootPath, skillRelativePath)

      refreshSkills()
      return `${departmentId}-${skillDirName}`
    } catch (error) {
      console.error('Failed to create skill:', error)
      // TODO: Show error message to user
      return null
    }
  }, [rootPath, departmentFolder, departmentId, refreshSkills])

  const copySkillHere = useCallback(async (sourceSkillPath: string, name: string, folderName: string): Promise<string | null> => {
    if (!rootPath || !departmentFolder) return null

    const skillsBasePath = `${rootPath}/${departmentFolder}/.claude/skills`
    const destPath = `${skillsBasePath}/${folderName}`

    try {
      // Ensure .claude/skills directory exists
      await createSkillDirectory(skillsBasePath)

      // Copy entire skill directory
      const copyResult = await copySkill(sourceSkillPath, destPath)
      if (!copyResult.success) {
        console.error('Failed to copy skill:', copyResult.error)
        return null
      }

      // Update SKILL.md frontmatter with new name
      const skillMdPath = `${destPath}/SKILL.md`
      const content = await readSkillFile(skillMdPath)
      if (content) {
        await writeSkillFile(skillMdPath, renameSkillMarkdown(content, name))
      }

      // Copied skills are public by default (user intentionally copied them)

      refreshSkills()
      return `${departmentId}-${folderName}`
    } catch (error) {
      console.error('Failed to copy skill:', error)
      return null
    }
  }, [rootPath, departmentFolder, departmentId, refreshSkills])

  const shareSkill = useCallback(async (skill: Skill) => {
    if (!rootPath) return
    const dept = departments.find(d => d.id === skill.departmentId)
    if (!dept) return
    const skillFolderName = skill.skillPath?.split('/').pop()
    if (!skillFolderName) return

    const skillRelativePath = `${dept.folder}/.claude/skills/${skillFolderName}/`
    await publishSkill(rootPath, skillRelativePath)
    refreshSkills()
  }, [rootPath, departments, refreshSkills])

  const toggleNurturing = useCallback(async (skill: Skill) => {
    if (!skill.files.skillMd) return
    await setSkillNurturing(skill.files.skillMd, !skill.isNurturing)
    refreshSkills()
  }, [refreshSkills])

  return { createSkill, copySkillHere, shareSkill, toggleNurturing }
}

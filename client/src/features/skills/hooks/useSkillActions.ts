import { useCallback } from 'react'
import type { DepartmentConfig } from '../../../types'
import type { Skill } from '../model'
import { copySkill, createSkillDirectory, createSkillFile, makeSkillPrivate, pathExists, publishSkill, readSkillFile, setSkillNurturing, writeSkillFile } from '../api'
import { newSkillMarkdown, renameSkillMarkdown, skillNameTakenMessage, SKILL_ALREADY_SHARED_MESSAGE, SKILL_CREATE_FAILED, SKILL_COPY_FAILED, type NewSkillInput, type SkillActionResult } from '../model'

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
 * Create and copy never replace a skill that exists; they answer the new
 * skill's id, or the sentence saying why nothing was made.
 */
export function useSkillActions({ rootPath, departments, departmentFolder, departmentId, refreshSkills }: Options) {
  const createSkill = useCallback(async (data: NewSkillInput): Promise<SkillActionResult> => {
    if (!rootPath || !departmentFolder) return { error: SKILL_CREATE_FAILED }

    // The folder name is validated by the wizard (shared/core/names.ts).
    const skillDirName = data.folderName
    const skillsBasePath = `${rootPath}/${departmentFolder}/.claude/skills`
    const skillPath = `${skillsBasePath}/${skillDirName}`

    try {
      if (await pathExists(skillPath)) return { error: skillNameTakenMessage(skillDirName) }

      // Private until shared — but never a skill the company already has
      // (main refuses: the .gitignore line would not keep it private).
      const marked = await makeSkillPrivate(rootPath, `${departmentFolder}/.claude/skills/${skillDirName}/`)
      if (!marked.success) return { error: marked.code === 'already_shared' ? SKILL_ALREADY_SHARED_MESSAGE : SKILL_CREATE_FAILED }

      for (const dir of [skillsBasePath, skillPath, ...['rules', 'references', 'scripts', 'tools'].map(d => `${skillPath}/${d}`)]) {
        if (!await createSkillDirectory(dir)) return { error: SKILL_CREATE_FAILED }
      }
      const written = await createSkillFile(`${skillPath}/SKILL.md`, newSkillMarkdown(data))
      if (!written.success) return { error: written.code === 'name_taken' ? skillNameTakenMessage(skillDirName) : SKILL_CREATE_FAILED }

      refreshSkills()
      return { id: `${departmentId}-${skillDirName}` }
    } catch (error) {
      console.error('Failed to create skill:', error)
      return { error: SKILL_CREATE_FAILED }
    }
  }, [rootPath, departmentFolder, departmentId, refreshSkills])

  const copySkillHere = useCallback(async (sourceSkillPath: string, name: string, folderName: string): Promise<SkillActionResult> => {
    if (!rootPath || !departmentFolder) return { error: SKILL_COPY_FAILED }

    const skillsBasePath = `${rootPath}/${departmentFolder}/.claude/skills`
    const destPath = `${skillsBasePath}/${folderName}`

    try {
      if (await pathExists(destPath)) return { error: skillNameTakenMessage(folderName) }
      if (!await createSkillDirectory(skillsBasePath)) return { error: SKILL_COPY_FAILED }

      const copyResult = await copySkill(sourceSkillPath, destPath)
      if (!copyResult.success) {
        console.error('Failed to copy skill:', copyResult.error)
        return { error: copyResult.code === 'name_taken' ? skillNameTakenMessage(folderName) : SKILL_COPY_FAILED }
      }

      // The copy gets its new name in SKILL.md.
      const skillMdPath = `${destPath}/SKILL.md`
      const content = await readSkillFile(skillMdPath)
      if (content) {
        await writeSkillFile(skillMdPath, renameSkillMarkdown(content, name))
      }

      // Copied skills are public by default (user intentionally copied them)

      refreshSkills()
      return { id: `${departmentId}-${folderName}` }
    } catch (error) {
      console.error('Failed to copy skill:', error)
      return { error: SKILL_COPY_FAILED }
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

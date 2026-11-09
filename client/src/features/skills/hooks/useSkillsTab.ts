import { useCallback, useMemo, useState } from 'react'
import type { DepartmentConfig } from '../../../types'
import type { Skill, SkillTool } from '../model'
import { runCommand } from '../../../shared/commands/commands'
import type { NewSkillInput } from '../model'
import { useSkillActions } from './useSkillActions'
import { shelfFixWithAi } from '../../../../shared/skill-shelf'

interface Options {
  rootPath: string | undefined
  departments: DepartmentConfig[]
  /** The shown department's folder; '' on 全社. */
  departmentFolder: string
  departmentId: string
  skills: Skill[]
  refreshSkills: () => unknown
}

/**
 * The スキル tab's state: the chosen skill, the new-skill and copy dialogs, a
 * skill's tool shown full screen, and running a skill (a new consultation
 * that sends its slash command).
 */
export function useSkillsTab({ rootPath, departments, departmentFolder, departmentId, skills, refreshSkills }: Options) {
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [activeTool, setActiveTool] = useState<{ tool: SkillTool; port: number } | null>(null)
  const selectedSkill = useMemo(() => skills.find((s) => s.id === selectedSkillId), [skills, selectedSkillId])

  const { createSkill, copySkillHere, shareSkill, publishToCompany, editLocally, restoreCompany, requestToCompany, openBackup, toggleNurturing } = useSkillActions({
    rootPath, departments, departmentFolder, departmentId, refreshSkills,
  })

  const executeSkill = useCallback((id: string) => {
    const skill = skills.find((s) => s.id === id)
    // The skill's folder name is its slash command.
    const folderName = skill?.skillPath?.split('/').pop()
    if (folderName) void runCommand('chat.newConsultation', { message: `/${folderName} ` })
  }, [skills])

  /**
   * 「AI と一緒に直す」: a new consultation whose first message names the Skill and its folder
   * (working-folder relative), sent the way a skill's 実行 is (chat.newConsultation).
   */
  const fixWithAi = useCallback((skill: Skill) => {
    if (!rootPath || !skill.skillPath) return
    void runCommand('chat.newConsultation', shelfFixWithAi(rootPath, skill.skillPath))
  }, [rootPath])

  /** Answers why nothing was made (the dialog stays open and shows it), or null when done. */
  const create = useCallback(async (data: NewSkillInput): Promise<string | null> => {
    const result = await createSkill(data)
    if ('error' in result) return result.error
    setWizardOpen(false)
    setSelectedSkillId(result.id)
    return null
  }, [createSkill])

  const copy = useCallback(async (sourceSkillPath: string, name: string, folderName: string): Promise<string | null> => {
    const result = await copySkillHere(sourceSkillPath, name, folderName)
    if ('error' in result) return result.error
    setCopyOpen(false)
    setSelectedSkillId(result.id)
    return null
  }, [copySkillHere])

  return {
    selectedSkillId, selectedSkill, selectSkill: setSelectedSkillId,
    wizardOpen, setWizardOpen, copyOpen, setCopyOpen, activeTool, setActiveTool,
    executeSkill, create, copy, shareSkill, publishToCompany, editLocally, restoreCompany, requestToCompany, openBackup, fixWithAi, toggleNurturing,
  }
}

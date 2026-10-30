import { useCallback, useMemo, useState } from 'react'
import type { DepartmentConfig, Skill, SkillTool } from '../../../types'
import { useAppStore } from '../../../stores/appStore'
import type { NewSkillInput } from '../model'
import { useSkillActions } from './useSkillActions'

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
 * skill's tool shown full screen, and running a skill (its slash command goes
 * into the chat input).
 */
export function useSkillsTab({ rootPath, departments, departmentFolder, departmentId, skills, refreshSkills }: Options) {
  const setPendingChatInput = useAppStore((s) => s.setPendingChatInput)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [activeTool, setActiveTool] = useState<{ tool: SkillTool; port: number } | null>(null)
  const selectedSkill = useMemo(() => skills.find((s) => s.id === selectedSkillId), [skills, selectedSkillId])

  const { createSkill, copySkillHere, shareSkill, toggleNurturing } = useSkillActions({
    rootPath, departments, departmentFolder, departmentId, refreshSkills,
  })

  const executeSkill = useCallback((id: string) => {
    const skill = skills.find((s) => s.id === id)
    // The skill's folder name is its slash command.
    const folderName = skill?.skillPath?.split('/').pop()
    if (folderName) setPendingChatInput(`/${folderName} `, true)
  }, [skills, setPendingChatInput])

  const create = useCallback(async (data: NewSkillInput) => {
    const id = await createSkill(data)
    if (!id) return
    setWizardOpen(false)
    setSelectedSkillId(id)
  }, [createSkill])

  const copy = useCallback(async (sourceSkillPath: string, name: string, folderName: string) => {
    const id = await copySkillHere(sourceSkillPath, name, folderName)
    if (!id) return
    setCopyOpen(false)
    setSelectedSkillId(id)
  }, [copySkillHere])

  return {
    selectedSkillId, selectedSkill, selectSkill: setSelectedSkillId,
    wizardOpen, setWizardOpen, copyOpen, setCopyOpen, activeTool, setActiveTool,
    executeSkill, create, copy, shareSkill, toggleNurturing,
  }
}

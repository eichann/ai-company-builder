import { useState, useEffect, useCallback } from 'react'
import type { Skill } from '../types'

interface UseSkillsOptions {
  rootPath: string
  departmentFolder: string
  departmentId: string
}

interface UseSkillsResult {
  skills: Skill[]
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useSkills({ rootPath, departmentFolder, departmentId }: UseSkillsOptions): UseSkillsResult {
  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    if (!rootPath || !departmentFolder || !departmentId) {
      setSkills([])
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await window.electronAPI.listSkills(rootPath, departmentFolder, departmentId)

      if (result.success) {
        // Map the API response to Skill type
        const mappedSkills: Skill[] = result.skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          departmentId: skill.departmentId,
          isPrivate: skill.isPrivate,
          isNurturing: skill.isNurturing,
          skillPath: skill.skillPath,
          files: skill.files,
        }))
        setSkills(mappedSkills)
      } else {
        setError(result.error || 'Failed to load skills')
        setSkills([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setSkills([])
    } finally {
      setIsLoading(false)
    }
  }, [rootPath, departmentFolder, departmentId])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  return {
    skills,
    isLoading,
    error,
    refresh: loadSkills,
  }
}

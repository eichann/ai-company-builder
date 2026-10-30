import { useState, useEffect, useCallback, useRef } from 'react'
import type { Skill } from '../model'
import { listSkills } from '../api'

interface UseSkillsOptions {
  rootPath: string
  departmentFolder: string
  departmentId: string
  departmentName?: string
}

interface UseSkillsResult {
  skills: Skill[]
  isLoading: boolean
  error: string | null
  /** Rescan now, bypassing the main process's short cache (file events, sync, the member's own change). */
  refresh: () => Promise<void>
}

export function useSkills({ rootPath, departmentFolder, departmentId, departmentName }: UseSkillsOptions): UseSkillsResult {
  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may set the list (a forced rescan can finish
  // after a department switch started another one).
  const requestRef = useRef(0)

  const loadSkills = useCallback(async (force: boolean) => {
    const request = ++requestRef.current
    if (!rootPath || (!departmentFolder && !departmentId)) {
      setSkills([])
      return
    }

    // A background rescan keeps the current list on screen (no loading flash
    // on every file event); only a view switch shows the loading state.
    if (!force) setIsLoading(true)
    setError(null)

    try {
      const result = await listSkills(rootPath, departmentFolder, departmentId, departmentName, { force })
      if (request !== requestRef.current) return

      if (result.success) {
        // Map the API response to Skill type
        const mappedSkills: Skill[] = result.skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          departmentId: skill.departmentId,
          group: skill.group,
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
      if (request !== requestRef.current) return
      setError(err instanceof Error ? err.message : 'Unknown error')
      setSkills([])
    } finally {
      if (request === requestRef.current) setIsLoading(false)
    }
  }, [rootPath, departmentFolder, departmentId, departmentName])

  // A plain view switch may reuse the cached scan.
  useEffect(() => {
    void loadSkills(false)
  }, [loadSkills])

  const refresh = useCallback(() => loadSkills(true), [loadSkills])

  return {
    skills,
    isLoading,
    error,
    refresh,
  }
}

import { useCallback, useEffect, useRef } from 'react'
import { isChatInputRecentlyActive } from '../../../shared/lib/chatInputActivity'
import { subscribeFileChanges } from '../../../shared/lib/fileEvents'
import { perfMark } from '../../../shared/lib/perfDiagnostics'
import { scanAffected, skillsScopesAffected } from '../../../../shared/skills-refresh'

const SKILLS_MAX_DEFER_COUNT = 4

interface Options {
  rootPath: string | undefined
  /** The shown department's folder ('' = company-wide); null while it is not downloaded. */
  shownFolder: string | null
  shownIsCompany: boolean
  refreshSkills: () => unknown
  refreshCompanySkills: () => unknown
}

/**
 * Rescans the skills when a file event touches what the scans read (the AI
 * or a sync added, changed or removed a skill), without the member doing
 * anything: the shown list and the company-wide skills behind the slash commands.
 */
export function useSkillsAutoRefresh({ rootPath, shownFolder, shownIsCompany, refreshSkills, refreshCompanySkills }: Options) {
  // Skills rescans requested by file events, coalesced (120 ms, deferred up to
  // 1 s while the member is typing in the chat).
  const pendingSkillsRefreshRef = useRef({ shown: false, company: false })
  const deferredSkillsRefreshTimerRef = useRef<number | null>(null)
  const skillsDeferCountRef = useRef(0)

  const requestDeferredSkillsRefresh = useCallback((which: { shown: boolean; company: boolean }) => {
    const pending = pendingSkillsRefreshRef.current
    pending.shown ||= which.shown
    pending.company ||= which.company
    if (deferredSkillsRefreshTimerRef.current != null) return
    skillsDeferCountRef.current = 0

    const run = () => {
      const { shown, company } = pendingSkillsRefreshRef.current
      if (!shown && !company) {
        deferredSkillsRefreshTimerRef.current = null
        return
      }

      if (isChatInputRecentlyActive() && skillsDeferCountRef.current < SKILLS_MAX_DEFER_COUNT) {
        skillsDeferCountRef.current++
        perfMark('skill_layout.refresh_skills.deferred_for_chat_input')
        deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 250)
        return
      }

      pendingSkillsRefreshRef.current = { shown: false, company: false }
      deferredSkillsRefreshTimerRef.current = null
      skillsDeferCountRef.current = 0
      if (shown) void refreshSkills()
      if (company) void refreshCompanySkills()
    }

    deferredSkillsRefreshTimerRef.current = window.setTimeout(run, 120)
  }, [refreshSkills, refreshCompanySkills])

  useEffect(() => {
    return () => {
      if (deferredSkillsRefreshTimerRef.current != null) {
        window.clearTimeout(deferredSkillsRefreshTimerRef.current)
      }
    }
  }, [])

  // Rescan skills when a file event touches what the scans read: any
  // .claude/skills/ inside the shown department (any depth), the root
  // .claude/skills/ (company-wide view and slash commands), the root
  // .gitignore (private marks), or folders moved in/out of the department
  // (shared/skills-refresh.ts). The main process drops its cache on the same
  // events; the renderer's refresh is forced anyway.
  useEffect(() => {
    const root = rootPath
    if (!root) return
    return subscribeFileChanges((changes) => {
      perfMark('skill_layout.fs_change')
      const scopes = skillsScopesAffected(root, changes)
      if (!scopes) return
      const company = scanAffected(scopes, '')
      const shown = shownIsCompany ? company : (shownFolder ? scanAffected(scopes, shownFolder) : false)
      if (!shown && !company) return
      perfMark('skill_layout.skills_change')
      // The company-wide hook is idle while the company tab is shown (the shown list is the same scan).
      requestDeferredSkillsRefresh({ shown, company: company && !shownIsCompany })
    })
  }, [rootPath, shownFolder, shownIsCompany, requestDeferredSkillsRefresh])
}

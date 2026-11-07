import { useRef, useState } from 'react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import type { CompanyView } from '../../../types'
import { useAppStore } from '../../../stores/appStore'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { reopenRememberedCompany } from '../reopen'
import { rememberCompanyFolder, rememberedCompanyFolder } from '../restore-company'
import { offersCompanySwitch, switchCompany, switchTargets } from '../switching'
import { useCompanies } from './useCompanies'

const SYNC_POLL_MS = 200

interface Options {
  currentId: string | undefined
  userId: string | undefined
  /** A sync of the company on screen is running (useSync's state, also set by automatic 送る). */
  isSyncing: boolean
  /** An AI turn of this window works or waits for the member's answer (asked when the switch starts). */
  aiWorking: () => boolean
  /** useSaveBeforeLeaving's confirmLeave: every tab saved, or the member said to go on. */
  saveTabs: () => Promise<boolean>
}

export type SwitchQuestion = 'sync' | 'ai'

/**
 * Switching company from the title bar (switching.ts decides when): a company this computer
 * remembers reopens where it is (the same checks as after sign-in); any other one opens the
 * selector at its folder choice.
 */
export function useCompanySwitch({ currentId, userId, isSyncing, aiWorking, saveTabs }: Options) {
  const { companies } = useCompanies()
  const latest = useLatestRef({ isSyncing, aiWorking, saveTabs, userId })
  const [question, setQuestion] = useState<{ kind: SwitchQuestion; answer: (yes: boolean) => void } | null>(null)
  const [waitingForSync, setWaitingForSync] = useState(false)
  const stopWaiting = useRef<(() => void) | null>(null)
  const busy = useRef(false)

  const ask = (kind: SwitchQuestion) => new Promise<boolean>(resolve => setQuestion({ kind, answer: resolve }))

  // The screen this switch started from is still the one open (not signed out or switched meanwhile).
  const stillOn = (companyId: string | undefined) => useAppStore.getState().currentCompany?.id === companyId

  const whenSyncIdle = (from: string | undefined) => new Promise<boolean>(resolve => {
    setWaitingForSync(true)
    let timer: ReturnType<typeof setInterval> | undefined
    const done = (idle: boolean) => {
      clearInterval(timer)
      stopWaiting.current = null
      setWaitingForSync(false)
      resolve(idle)
    }
    timer = setInterval(() => {
      if (!stillOn(from)) done(false)
      else if (!latest.current.isSyncing) done(true)
    }, SYNC_POLL_MS)
    stopWaiting.current = () => done(false)
  })

  const prepareOpen = async (target: CompanyInfo, from: string | undefined): Promise<() => void> => {
    const user = latest.current.userId
    const remembered = user ? rememberedCompanyFolder<CompanyView>(user, target.id) : null
    const reopened = remembered ? await reopenRememberedCompany(remembered) : null
    // The folder is gone or access ended: chosen again on the selector.
    if (reopened?.outcome === 'forget' && user) rememberCompanyFolder(user, target.id, null)
    return () => {
      if (!stillOn(from)) return
      if (reopened?.outcome === 'open') useAppStore.getState().setCurrentCompany(reopened.company)
      else useAppStore.getState().chooseCompany(target.id)
    }
  }

  const switchTo = async (target: CompanyInfo) => {
    if (busy.current) return
    busy.current = true
    const from = useAppStore.getState().currentCompany?.id
    try {
      await switchCompany({
        syncRunning: () => latest.current.isSyncing,
        askDuringSync: () => ask('sync'),
        whenSyncIdle: () => whenSyncIdle(from),
        aiWorking: () => latest.current.aiWorking(),
        askDuringAi: () => ask('ai'),
        saveTabs: () => latest.current.saveTabs(),
        prepareOpen: () => prepareOpen(target, from),
      })
    } finally {
      busy.current = false
    }
  }

  const answer = (yes: boolean) => {
    question?.answer(yes)
    setQuestion(null)
  }

  return {
    shown: offersCompanySwitch(companies),
    targets: switchTargets(companies, currentId),
    switchTo,
    question: question?.kind ?? null,
    answer,
    waitingForSync,
    stopWaiting: () => stopWaiting.current?.(),
  }
}

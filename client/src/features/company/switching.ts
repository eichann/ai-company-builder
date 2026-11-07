// Switching to another company from the title bar, without React: when the
// switch may go ahead. A running sync is never left half-way (sync.md: it is
// waited for), an AI at work is asked about, and every open tab is saved first.

/** The title bar offers switching only to a member of two or more companies. */
export function offersCompanySwitch(companies: readonly unknown[]): boolean {
  return companies.length >= 2
}

/** The companies the menu lists: every one but the company on screen. */
export function switchTargets<T extends { id: string }>(companies: readonly T[], currentId: string | undefined): T[] {
  return companies.filter(c => c.id !== currentId)
}

export interface SwitchDeps {
  /** A sync of the company on screen is running (manual or automatic 送る). */
  syncRunning(): boolean
  /** The member chose to wait (true) or not to switch (false). */
  askDuringSync(): Promise<boolean>
  /** Resolves true once no sync runs, false when the member stopped waiting. */
  whenSyncIdle(): Promise<boolean>
  /** An AI turn works or waits for the member's answer (switching stops it). */
  aiWorking(): boolean
  /** True = switch anyway. */
  askDuringAi(): Promise<boolean>
  /** Saves every open tab, asking about what could not be saved; false = the member stayed. */
  saveTabs(): Promise<boolean>
  /**
   * The normal open-company flow's checks (reading the server and the disk); resolves to what
   * opens the other company, run at once and only when no sync started meanwhile.
   */
  prepareOpen(): Promise<() => void>
}

export type SwitchOutcome = 'opened' | 'cancelled'

export async function switchCompany(deps: SwitchDeps): Promise<SwitchOutcome> {
  let askedSync = false
  let askedAi = false
  for (;;) {
    if (deps.syncRunning()) {
      if (!askedSync) {
        if (!await deps.askDuringSync()) return 'cancelled'
        askedSync = true
      }
      if (!await deps.whenSyncIdle()) return 'cancelled'
      continue
    }
    if (!askedAi && deps.aiWorking()) {
      if (!await deps.askDuringAi()) return 'cancelled'
      askedAi = true
    }
    if (!await deps.saveTabs()) return 'cancelled'
    const open = await deps.prepareOpen()
    // The questions, saving and checks took time: an automatic sync may have started meanwhile.
    if (deps.syncRunning()) continue
    open()
    return 'opened'
  }
}

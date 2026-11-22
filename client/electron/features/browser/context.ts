// The context a browser run or a plan's registration holds (agent-browser.md "The card, the IPC and the
// request tool"; design 6b-2 §5-4): one generation, advanced by the shell's events — sign-out, a sign-in
// (also as another account), a change of the company's browser setting, the app quitting. Every async
// step captures it and asks "still the same?" after each answer (`BrowserRunnerDeps.context`): an answer
// that arrives after the context moved is dropped (no permit used, nothing sent).

export interface BrowserContext {
  /** Something the runs depend on changed: every capture made before reads false from now on. */
  advance(): void
  /** The company's policy answered: the generation moves only when its browser setting changed (or it was dropped). */
  policyAnswered(companyId: string, browserSetting: unknown): void
  /** The app is quitting: nothing starts or goes on from here. */
  quitting(): void
  /** The context now (the signed-in member, the generation, the company and, for a request, its conversation's signal). */
  capture(scope: { companyId: string; signal?: AbortSignal }): () => boolean
}

export function createBrowserContext(deps: { userId: () => string | null }): BrowserContext {
  let generation = 0
  let quit = false
  const settings = new Map<string, string>()
  return {
    advance() { generation++ },
    policyAnswered(companyId, browserSetting) {
      const text = JSON.stringify(browserSetting ?? null)
      const before = settings.get(companyId)
      settings.set(companyId, text)
      if (before !== undefined && before !== text) generation++
    },
    quitting() { quit = true; generation++ },
    capture({ signal }) {
      const user = deps.userId()
      const at = generation
      return () => !quit && user !== null && deps.userId() === user && generation === at && !(signal?.aborted ?? false)
    },
  }
}

// ACB foundation: the company and session on screen as one counter (an "era"), so work started for one company never
// lands on the next. Ended by appStore (another company, or none: a sign-out); read by the lists worked through
// (workThrough.ts: the やること list, a 案件's やること, the inbox). Rules: tasks-ui.md "Working through a list".
// Memory only: nothing here is saved or sent.

/** The era something was started in; compare it with `inEra` when its answer comes back. */
export type CompanyEra = number & { readonly companyEra: unique symbol }

let era = 0 as CompanyEra

export function currentCompanyEra(): CompanyEra {
  return era
}

/** Another company or a sign-out: everything started before answers into an era that has ended. */
export function endCompanyEra(): void {
  era = (era + 1) as CompanyEra
}

/**
 * Whether `started` is still the era on screen. An answer that comes back after it ended changes nothing on screen
 * (shows no item, says nothing); the request itself was the last company's and stays so.
 */
export function inEra(started: CompanyEra): boolean {
  return started === era
}

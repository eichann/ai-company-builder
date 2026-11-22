// 「止まっている」 by meaning (design-system.md 「止まっている」の色, owner decisions 2026-11-21 / 2026-11-22):
// the one place that says which look a stopped state gets, for the app and the admin console alike.
// A screen names what its stop means for the person looking at it; it never picks a colour itself.
// Pure data (no React, no Tailwind): the variant names are the token sets both apps' badges and
// callouts share (`warning`, `paused`, `failed`, `awaiting`).

/**
 * What a stop means for the person who sees it:
 * - `needsAction` — they have something to do; left alone it causes trouble (amber).
 * - `stoppedOnPurpose` — someone stopped it on purpose and it is known; nothing to do (grey).
 * - `failed` — it stopped on a failure; the reason and the fix are said (red).
 * - `awaitingApproval` — it waits for someone's approval or acceptance (amber, hourglass).
 */
export type StopMeaning = 'needsAction' | 'stoppedOnPurpose' | 'failed' | 'awaitingApproval'

/** The token set (badge / callout variant) and the badge's word of each meaning. */
export const STOP_LOOK = {
  needsAction: { variant: 'warning', word: '止まっています' },
  stoppedOnPurpose: { variant: 'paused', word: '止めています' },
  failed: { variant: 'failed', word: '止まりました' },
  awaitingApproval: { variant: 'awaiting', word: '承認を待っています' },
} as const satisfies Record<StopMeaning, { variant: string; word: string }>

export type StopVariant = (typeof STOP_LOOK)[StopMeaning]['variant']

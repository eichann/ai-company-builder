/**
 * Of requests made one after another, only the newest one's answer is used: an older answer that
 * arrives later (a slower read) never overwrites a newer one on screen.
 */
export interface LatestOnly {
  /** A request is being made: its ticket. */
  begin(): number
  /** Whether the answer to `ticket` may be used (no newer request was made since). */
  isLatest(ticket: number): boolean
}

export function createLatestOnly(): LatestOnly {
  let newest = 0
  return {
    begin: () => ++newest,
    isLatest: ticket => ticket === newest,
  }
}

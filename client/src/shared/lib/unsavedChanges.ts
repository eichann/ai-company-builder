// Generic: a part of a screen that keeps what the member typed until they save it, asked by the
// screen before it closes or moves on, so nothing typed disappears without a word.

export interface UnsavedChanges {
  /** What is typed and not saved yet, in the member's words (never the value itself); null = nothing. */
  pending: () => string | null
  /** Saves it: null when saved; else why not ('' = the part shows the reason or asks the member itself). */
  save: () => Promise<string | null>
}

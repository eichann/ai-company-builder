// A card's press whose answer never came (offline: it may or may not have reached the server). What happened is learnt by
// reading the server again — never by sending the press again: only the member's next press does that, once a read said
// it did not happen. The approval card and the job proposal card use it (`hooks/useUnknownResult.ts`).

/** What a read says about the press: it happened, it did not, or the server could not be read (null). */
export type PressOutcome = 'done' | 'not-done'
export type AfterUnknown = PressOutcome | 'unreadable'

/** The reads the card makes by itself after an unknown answer: at once, then a little apart (about 15 seconds in all). */
export const AUTO_WAITS: readonly number[] = [0, 2000, 5000, 8000]

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Reads after each wait in turn; `read` never sends anything. `done` ends it at once. `not-done` is only provisional until
 * the last read: the press may still be running on the server (an approval waits for its outside write before its state
 * moves; Codex review), so the reads go on and the last answer decides. `unreadable` when no read answered.
 */
export async function askAfterUnknown(read: () => Promise<PressOutcome | null>, waits: readonly number[] = AUTO_WAITS, wait: (ms: number) => Promise<void> = sleep): Promise<AfterUnknown> {
  let answered: PressOutcome | null = null
  for (const ms of waits) {
    if (ms > 0) await wait(ms)
    const outcome = await read().catch(() => null)
    if (outcome === 'done') return outcome
    if (outcome) answered = outcome
  }
  return answered ?? 'unreadable'
}

/**
 * Which presses are unknown now, per request or candidate (the card's store key), not per card: a card shown again (the
 * conversation switched back to) or a second card of the same request offers no press either until a read settles it.
 * Memory only — a restart reads the server again anyway.
 */
export interface Unsure<P> { checking: boolean; press: P }
const unsureByKey = new Map<string, Unsure<unknown>>()
const unsureListeners = new Map<string, Set<() => void>>()

export function unsureOf<P>(key: string): Unsure<P> | null {
  return (unsureByKey.get(key) as Unsure<P> | undefined) ?? null
}

export function setUnsure<P>(key: string, value: Unsure<P> | null): void {
  if (value) unsureByKey.set(key, value)
  else unsureByKey.delete(key)
  for (const l of unsureListeners.get(key) ?? []) l()
}

export function subscribeUnsure(key: string, listener: () => void): () => void {
  let set = unsureListeners.get(key)
  if (!set) unsureListeners.set(key, set = new Set())
  set.add(listener)
  return () => { set!.delete(listener); if (set!.size === 0) unsureListeners.delete(key) }
}

/** The card's words for one kind of press: 「承認できたかどうか」 and 「承認はまだ届いていません」. */
export interface UnknownWords { whether: string; notDone: string }

/** What the card says while it reads again, when it could not, and when the press did not happen. */
export function unknownMessage(words: UnknownWords, at: 'checking' | 'unreadable' | 'not-done'): string {
  if (at === 'checking') return `通信が切れて、${words.whether}分かりませんでした。結果を聞き直しています…`
  if (at === 'unreadable') return `通信が切れて、${words.whether}まだ分かりません。つながったら［結果を確かめる］を押してください（押しても、もう一度送ることはありません）。`
  return `確かめました。${words.notDone}。もう一度押してください（届いていたときは二重にはならず、結果が出ます）。`
}

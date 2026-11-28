// A card's press whose answer never came (offline: it may or may not have reached the server). What happened is learnt by
// reading the server again — never by sending the press again: only the member's next press does that, once a read said
// it did not happen. The approval card and the job proposal card use it (`hooks/useUnknownResult.ts`).

/** What a read says about the press: it happened, it did not, or the server could not be read (null). */
export type PressOutcome = 'done' | 'not-done'
export type AfterUnknown = PressOutcome | 'unreadable'

/** The reads the card makes by itself after an unknown answer: at once, then twice a little apart. */
export const AUTO_WAITS: readonly number[] = [0, 2000, 5000]

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Reads after each wait in turn until one answers; `unreadable` when none did. `read` never sends anything. */
export async function askAfterUnknown(read: () => Promise<PressOutcome | null>, waits: readonly number[] = AUTO_WAITS, wait: (ms: number) => Promise<void> = sleep): Promise<AfterUnknown> {
  for (const ms of waits) {
    if (ms > 0) await wait(ms)
    const outcome = await read().catch(() => null)
    if (outcome) return outcome
  }
  return 'unreadable'
}

/** The card's words for one kind of press: 「承認できたかどうか」 and 「承認はまだ届いていません」. */
export interface UnknownWords { whether: string; notDone: string }

/** What the card says while it reads again, when it could not, and when the press did not happen. */
export function unknownMessage(words: UnknownWords, at: 'checking' | 'unreadable' | 'not-done'): string {
  if (at === 'checking') return `通信が切れて、${words.whether}分かりませんでした。結果を聞き直しています…`
  if (at === 'unreadable') return `通信が切れて、${words.whether}まだ分かりません。つながったら［結果を確かめる］を押してください（押しても、もう一度送ることはありません）。`
  return `確かめました。${words.notDone}。もう一度押してください。`
}

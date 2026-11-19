// Identical server reads running at the same time share one request (owner-approved plan
// 「問い合わせを減らす計画」 段1; `ipc-and-main-process.md` "Shared reads"). Nothing is kept once a
// read has settled: this is no cache, only "the same question is already on its way".
//
// - A read is shared only within one *scope* (the server and the signed-in session: a sign-out
//   or a new sign-in is another scope), one *group* (a company) and one *key* (the question and
//   its conditions). A read whose scope changed while it ran is answered `discarded`, so an
//   answer that arrives after sign-out or a server change is never used.
// - `changed(group)` says something of that company changed (a push signal, the member's own
//   write). A read already on its way is then too old for anyone who asks afterwards: they get a
//   read of their own, started once the old one has settled (so answers keep their order and the
//   older one can never land after the newer). Callers that joined before the change keep theirs.
//   A read still waiting to start has seen no answer yet, so later changes join it rather than
//   queueing another one behind it (no backlog under a stream of changes).
// - There is no abort: one caller giving up never cancels the request for the others (each read
//   carries its own timeout).

export type SharedRead<V> = { discarded: false; value: V } | { discarded: true }

export interface InFlightReads {
  /** `run` once for every caller asking the same `group` × `key` in this scope until it settles. */
  read<V>(group: string, key: string, run: () => Promise<V>): Promise<SharedRead<V>>
  /** Something of `group` changed: reads already on their way are not joined any more. */
  changed(group: string): void
}

interface Flight {
  generation: number
  /** false while it waits for the read before it: it has asked the server nothing yet. */
  started: boolean
  /** Settles (never rejects) when the read is over: what a later read of the same key waits for. */
  done: Promise<void>
  answer: Promise<SharedRead<unknown>>
}

/** `scope()`: who and where is asking now (server × session); compared, never logged. */
export function createInFlightReads(scope: () => string): InFlightReads {
  const generations = new Map<string, number>()
  const flights = new Map<string, Flight>()

  return {
    read<V>(group: string, key: string, run: () => Promise<V>): Promise<SharedRead<V>> {
      const startScope = scope()
      const generation = generations.get(group) ?? 0
      const id = `${startScope}\u0000${group}\u0000${key}`
      const before = flights.get(id)
      if (before && (before.generation === generation || !before.started)) {
        // Not started yet: it will read after this change too.
        before.generation = generation
        return before.answer as Promise<SharedRead<V>>
      }
      // A change happened since the read on its way began: one more read, after that one.
      const flight = { generation, started: !before } as Flight
      const start = before ? before.done.then(() => { flight.started = true; return run() }) : run()
      const answer = start.then((value): SharedRead<V> => (scope() === startScope ? { discarded: false, value } : { discarded: true }))
      flight.answer = answer
      flight.done = answer.then(() => {}, () => {})
      flights.set(id, flight)
      void flight.done.then(() => { if (flights.get(id) === flight) flights.delete(id) })
      return answer
    },
    changed(group: string): void {
      generations.set(group, (generations.get(group) ?? 0) + 1)
    },
  }
}

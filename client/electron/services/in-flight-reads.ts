// Identical server reads running at the same time share one request (owner-approved plan
// 「問い合わせを減らす計画」 段1; `ipc-and-main-process.md` "Shared reads"). Nothing is kept once a
// question's reads have all settled: this is no cache, only "the same question is already on its way".
//
// - A read is shared only within one *scope* (the server and the signed-in session: a sign-out
//   or a new sign-in is another scope), one *group* (a company) and one *key* (the question and
//   its conditions). A read whose scope changed while it ran is answered `discarded`, so an
//   answer that arrives after sign-out or a server change is never used.
// - `changed(group)` says something of that company changed (a push signal, the member's own
//   write). A read already on its way is then too old for anyone who asks afterwards: they get a
//   read of their own, started at once (nobody waits behind the older one). Callers that joined
//   before the change keep theirs — unless it settles after a newer read of the same question
//   already did: then they get that newer answer, so nobody ever goes back to an older one.
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
  answer: Promise<SharedRead<unknown>>
}

/** One question while any of its reads is on its way (dropped when the last one settles). */
interface Question {
  /** The read new callers join, while it runs and nothing changed since it began. */
  current?: Flight
  /** Reads begun, in order; the newest settled one's number and answer. */
  begun: number
  newest?: { seq: number; value: unknown }
  running: number
}

/** `scope()`: who and where is asking now (server × session); compared, never logged. */
export function createInFlightReads(scope: () => string): InFlightReads {
  const generations = new Map<string, number>()
  const questions = new Map<string, Question>()

  return {
    read<V>(group: string, key: string, run: () => Promise<V>): Promise<SharedRead<V>> {
      const startScope = scope()
      const generation = generations.get(group) ?? 0
      const id = `${startScope}\u0000${group}\u0000${key}`
      const question = questions.get(id) ?? { begun: 0, running: 0 }
      questions.set(id, question)
      if (question.current && question.current.generation === generation) return question.current.answer as Promise<SharedRead<V>>
      const seq = ++question.begun
      question.running++
      const answer = run().then((value): SharedRead<V> => {
        if (scope() !== startScope) return { discarded: true }
        // A newer read of the same question settled first: its answer, never the older one.
        if (question.newest && question.newest.seq > seq) return { discarded: false, value: question.newest.value as V }
        question.newest = { seq, value }
        return { discarded: false, value }
      })
      const flight: Flight = { generation, answer }
      question.current = flight
      void answer.then(() => {}, () => {}).then(() => {
        if (question.current === flight) question.current = undefined
        if (--question.running === 0 && questions.get(id) === question) questions.delete(id)
      })
      return answer
    },
    changed(group: string): void {
      generations.set(group, (generations.get(group) ?? 0) + 1)
    },
  }
}

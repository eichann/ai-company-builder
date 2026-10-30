// Changes to the folders this computer leaves out (useSparseCheckout), one at
// a time per company folder, each built from the list as it is when its turn
// comes. Two quick 「ダウンロード」 clicks used to each send "the list I saw
// minus my folder": the second put the first folder back on the list, and it
// was removed from disk again. Pure: the reads and writes are injected.

export interface ExclusionQueueDeps<R> {
  /** This computer's list now (main's answer); null when it could not be read. */
  read: (rootPath: string) => Promise<string[] | null>
  apply: (rootPath: string, excluded: string[]) => Promise<R>
}

export function createExclusionQueue<R>({ read, apply }: ExclusionQueueDeps<R>) {
  const tails = new Map<string, Promise<unknown>>()

  /**
   * Run `update(current)` when the earlier changes for `rootPath` are done and
   * apply its answer. `current` is read afresh then, never an older copy.
   */
  function change(rootPath: string, update: (current: string[]) => string[]): Promise<R> {
    const run = async () => {
      const current = await read(rootPath)
      return apply(rootPath, update(current ?? []))
    }
    const previous = tails.get(rootPath) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tail = next.catch(() => undefined)
    tails.set(rootPath, tail)
    void tail.then(() => { if (tails.get(rootPath) === tail) tails.delete(rootPath) })
    return next
  }

  return { change }
}

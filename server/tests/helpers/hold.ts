/**
 * Interrupt points for race tests (TOCTOU: "check → await → write"). A service awaits a port (an account
 * check, a git read, a send); the test wraps that **real** port so its next call can be held, runs another
 * operation while the service waits, then releases it — each race in a fixed order, on the real database.
 * Production code has no hook for this: only the test wraps what it passes in.
 *
 * Two places to stop, named apart because they are different races:
 * - `stopBefore(kind, port)` — held **before** the port is called: what the other operation changes is what
 *   the port then reads (the service's later check may still be fooled by what it read earlier);
 * - `stopAfter(kind, port)` — held **after** the port answered: the service resumes with an answer read
 *   before the other operation (a stale read: the write must check again itself).
 * `pass(kind)` is the bare point, for a fake that does its own work around it.
 *
 * A call with no `held` slot waiting passes straight through, so the same service serves ordinary tests.
 */
type Deferred = { promise: Promise<void>; open: () => void }
const deferred = (): Deferred => {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

export interface Hold {
  /** Resolves once the held call has reached its point (the service is now waiting there). */
  arrived: Promise<void>
  /** Let the held call go on. */
  release: () => void
}

export function holdPoints<Kind extends string>() {
  const queue = new Map<Kind, Array<{ arrived: Deferred; gate: Deferred }>>()

  /** Hold the next call of `kind` (several: in the order they come). */
  function held(kind: Kind): Hold {
    const slot = { arrived: deferred(), gate: deferred() }
    queue.set(kind, [...(queue.get(kind) ?? []), slot])
    return { arrived: slot.arrived.promise, release: slot.gate.open }
  }

  /** The point itself: waits there when the test holds this kind, else returns at once. */
  async function pass(kind: Kind): Promise<void> {
    const slot = queue.get(kind)?.shift()
    if (slot) { slot.arrived.open(); await slot.gate.promise }
  }

  function stopBefore<A extends unknown[], R>(kind: Kind, port: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => { await pass(kind); return port(...args) }
  }

  function stopAfter<A extends unknown[], R>(kind: Kind, port: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => { const answer = await port(...args); await pass(kind); return answer }
  }

  return { held, pass, stopBefore, stopAfter }
}

/**
 * Runs the server clock (services/server-clock.ts, notifications.md "The server
 * clock"): once shortly after the server starts, then every few minutes — one
 * scheduler per server process, started by index.ts next to the retention
 * jobs. The clock itself refuses to overlap a run still going; a failed run is
 * logged (its name only) and the next one tries again. Timers are unref'd.
 */
import type { RetentionSchedule } from './agent-event-retention'

export function scheduleServerClock(
  runOnce: () => Promise<unknown>,
  options: { initialDelayMs?: number; intervalMs: number; log?: (message: string) => void },
): RetentionSchedule {
  const log = options.log ?? ((message: string) => console.log(message))
  const run = () => {
    runOnce().catch((error: unknown) => log(`[server-clock] run failed: ${error instanceof Error ? error.name : 'unknown error'}`))
  }
  const first = setTimeout(run, options.initialDelayMs ?? 30_000)
  const every = setInterval(run, options.intervalMs)
  first.unref?.()
  every.unref?.()
  return { stop() { clearTimeout(first); clearInterval(every) } }
}

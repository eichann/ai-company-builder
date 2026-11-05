/**
 * The access log's retention (services/plugin-calls.ts `cleanupAccessLog`,
 * plugins.md "Contract 3"): once a few seconds after the server starts, then every
 * day, so a year's limit holds for a connector nobody reads through any more. One
 * run per server, each company through its own handle. Timers are unref'd; a failed
 * run is logged (counts only, never an id) and the next one tries again.
 */
import type { RetentionSchedule } from './agent-event-retention'

export function scheduleAccessLogRetention(
  cleanup: () => { deleted: number },
  options: { initialDelayMs?: number; intervalMs?: number; log?: (message: string) => void } = {},
): RetentionSchedule {
  const log = options.log ?? ((message: string) => console.log(message))
  const run = () => {
    try {
      const { deleted } = cleanup()
      if (deleted > 0) log(`[plugin-calls] retention: deleted ${deleted} access log row(s) a year old`)
    } catch (error) {
      log(`[plugin-calls] retention failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    }
  }
  const first = setTimeout(run, options.initialDelayMs ?? 5_000)
  const every = setInterval(run, options.intervalMs ?? 24 * 60 * 60 * 1000)
  first.unref?.()
  every.unref?.()
  return { stop() { clearTimeout(first); clearInterval(every) } }
}

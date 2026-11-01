/**
 * Outbound mail's retention (services/outbound-mail.ts `cleanupBodies`,
 * `.claude/rules/outbound-mail.md`): once a few seconds after the server
 * starts, then every day — one run per server, each company through its own
 * handle. Timers are unref'd; a failed run is logged (counts only, never a
 * subject, body or address) and the next one tries again.
 */
import type { RetentionSchedule } from './agent-event-retention'

export function scheduleMailBodyRetention(
  cleanup: () => { deleted: number },
  options: { initialDelayMs?: number; intervalMs?: number; log?: (message: string) => void } = {},
): RetentionSchedule {
  const log = options.log ?? ((message: string) => console.log(message))
  let running = false
  const run = () => {
    if (running) return
    running = true
    try {
      const { deleted } = cleanup()
      if (deleted > 0) log(`[outbound-mail] retention: deleted the body of ${deleted} mail(s) sent or discarded 30+ days ago`)
    } catch (error) {
      log(`[outbound-mail] retention failed: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally {
      running = false
    }
  }
  const first = setTimeout(run, options.initialDelayMs ?? 5_000)
  const every = setInterval(run, options.intervalMs ?? 24 * 60 * 60 * 1000)
  first.unref?.()
  every.unref?.()
  return { stop() { clearTimeout(first); clearInterval(every) } }
}

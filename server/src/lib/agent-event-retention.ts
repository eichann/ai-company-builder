/**
 * The AI action log's retention (services/agent-events.ts `prune`): once a
 * few seconds after the server starts, then every day. Timers are unref'd so
 * they never keep the process alive; a failed run is logged (counts only) and
 * the next one tries again.
 */
export interface RetentionSchedule {
  stop(): void
}

export function scheduleAgentEventRetention(
  prune: () => Promise<{ deleted: number }>,
  options: { initialDelayMs?: number; intervalMs?: number; log?: (message: string) => void } = {},
): RetentionSchedule {
  const initialDelayMs = options.initialDelayMs ?? 5_000
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000
  const log = options.log ?? ((message: string) => console.log(message))
  let running = false

  const run = async () => {
    if (running) return
    running = true
    try {
      const { deleted } = await prune()
      if (deleted > 0) log(`[agent-events] retention: deleted ${deleted} event(s) past their company's retention`)
    } catch (error) {
      log(`[agent-events] retention failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => { void run() }, initialDelayMs)
  const every = setInterval(() => { void run() }, intervalMs)
  first.unref?.()
  every.unref?.()
  return {
    stop() {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}

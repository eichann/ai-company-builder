/**
 * The server's load, one line a minute on stdout (server.md "Request log"):
 *
 *   [load] <s>s req=<n> cpu=<%> loop_p50=<ms> loop_p99=<ms> loop_max=<ms> rss=<MB> db=<ms> git=<ms> ext=<ms>
 *
 * - req: request lines written in the period.
 * - cpu: this process's CPU time (user + system) over the period's wall time;
 *   above 100 when libuv's threads or GC work in parallel.
 * - loop_*: how late the event loop ran a timer that should run every 10 ms
 *   (perf_hooks monitorEventLoopDelay, the 10 ms subtracted, never below 0):
 *   the queueing every request waits through. better-sqlite3 runs on the loop,
 *   so a slow query shows here for every company.
 * - rss: resident memory at the end of the period.
 * - db / git / ext: ms during which at least one such operation ran anywhere in
 *   the server (requests or timers), as lib/request-log.ts counts them.
 *
 * Numbers and fixed words only. Started by index.ts (never by composition.ts,
 * which tests import); its timer is unref'd and the returned function stops it.
 */
import { monitorEventLoopDelay } from 'perf_hooks'
import { takeServerLoadCounters, type ServerLoadCounters } from './request-log'

const RESOLUTION_MS = 10
export const LOAD_LOG_INTERVAL_MS = 60_000

export interface LoadSample {
  elapsedMs: number
  /** process.cpuUsage() difference over the period, microseconds. */
  cpu: { user: number; system: number }
  /** Event-loop timer intervals, nanoseconds, as the histogram reports them (resolution included). */
  loop: { p50: number; p99: number; max: number }
  rssBytes: number
  counters: ServerLoadCounters
}

const lagMs = (ns: number) => Math.max(0, ns / 1e6 - RESOLUTION_MS)

export function loadLine(s: LoadSample): string {
  const cpuPercent = s.elapsedMs > 0 ? ((s.cpu.user + s.cpu.system) / 1000 / s.elapsedMs) * 100 : 0
  const { busyMs } = s.counters
  return [
    '[load]',
    `${Math.round(s.elapsedMs / 1000)}s`,
    `req=${s.counters.requests}`,
    `cpu=${cpuPercent.toFixed(1)}%`,
    `loop_p50=${lagMs(s.loop.p50).toFixed(1)}ms`,
    `loop_p99=${lagMs(s.loop.p99).toFixed(1)}ms`,
    `loop_max=${lagMs(s.loop.max).toFixed(1)}ms`,
    `rss=${Math.round(s.rssBytes / (1024 * 1024))}MB`,
    `db=${Math.round(busyMs.db)}ms`,
    `git=${Math.round(busyMs.git)}ms`,
    `ext=${Math.round(busyMs.ext)}ms`,
  ].join(' ')
}

export function startLoadLog(print: (line: string) => void = line => console.log(line), intervalMs = LOAD_LOG_INTERVAL_MS): () => void {
  const loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  loop.enable()
  takeServerLoadCounters() // the first period starts now
  let startedAt = performance.now()
  let cpuAt = process.cpuUsage()
  const timer = setInterval(() => {
    const now = performance.now()
    const cpu = process.cpuUsage(cpuAt)
    cpuAt = process.cpuUsage()
    const sample: LoadSample = {
      elapsedMs: now - startedAt,
      cpu,
      loop: loop.count > 0 ? { p50: loop.percentile(50), p99: loop.percentile(99), max: loop.max } : { p50: 0, p99: 0, max: 0 },
      rssBytes: process.memoryUsage.rss(),
      counters: takeServerLoadCounters(),
    }
    startedAt = now
    loop.reset()
    print(loadLine(sample))
  }, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    loop.disable()
  }
}

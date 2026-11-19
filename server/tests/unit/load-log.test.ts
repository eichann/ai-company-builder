/**
 * The per-minute `[load]` line (server.md "Request log"): the capacity
 * estimate ("how many people can one server hold") is read from it, so its
 * CPU share and event-loop delay must be what they say, in fixed words only.
 */
import { describe, expect, it } from 'vitest'
import { loadLine, startLoadLog } from '../../src/lib/load-log'

const base = {
  elapsedMs: 60_000,
  cpu: { user: 20_000_000, system: 10_000_000 },
  // The histogram reports the timer's whole interval: 10 ms resolution + the lag.
  loop: { p50: 10.5e6, p99: 35e6, max: 9e6 },
  rssBytes: 200 * 1024 * 1024,
  counters: { requests: 1234, busyMs: { db: 851.4, git: 0, ext: 12.6 } },
}

describe('load line', () => {
  it('states CPU as a share of the period, the loop lag beyond the 10 ms timer, and the totals', () => {
    expect(loadLine(base)).toBe(
      '[load] 60s req=1234 cpu=50.0% loop_p50=0.5ms loop_p99=25.0ms loop_max=0.0ms rss=200MB db=851ms git=0ms ext=13ms')
  })

  it('CPU follows the period length (30 s of CPU in 30 s is 100 %)', () => {
    expect(loadLine({ ...base, elapsedMs: 30_000 })).toContain(' cpu=100.0% ')
  })

  it('writes one line per period and stops when told', async () => {
    const printed: string[] = []
    const stop = startLoadLog(line => printed.push(line), 50)
    await new Promise(resolve => setTimeout(resolve, 180))
    stop()
    const count = printed.length
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(count).toBeGreaterThanOrEqual(2)
    expect(printed.length).toBe(count)
    for (const line of printed) {
      expect(line).toMatch(/^\[load\] \d+s req=\d+ cpu=[0-9.]+% loop_p50=[0-9.]+ms loop_p99=[0-9.]+ms loop_max=[0-9.]+ms rss=\d+MB db=\d+ms git=\d+ms ext=\d+ms$/)
    }
  })
})

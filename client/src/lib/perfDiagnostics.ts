type Metric = {
  count: number
  totalMs: number
  maxMs: number
}

export type PerfCutFlag =
  | 'fsEvents'
  | 'chatStreamRender'
  | 'chatAutoScroll'
  | 'disableWatchers'
  | 'chatInputBare'

const PERF_ENABLED_KEY = 'acb.perf.enabled'
const PERF_CUT_PREFIX = 'acb.perf.cut.'
const FLUSH_INTERVAL_MS = 5000

const flagState = {
  initialized: false,
  enabled: false,
  cuts: {
    fsEvents: false,
    chatStreamRender: false,
    chatAutoScroll: false,
    disableWatchers: false,
    chatInputBare: false,
  } as Record<PerfCutFlag, boolean>,
}

const metricMap = new Map<string, Metric>()
let flushTimer: number | null = null
let longTaskObserver: PerformanceObserver | null = null
let frameMonitorRaf: number | null = null
let lastFrameTs: number | null = null
let frameBaselineMs = 16.7
let frameSampleCount = 0
let eventLoopTimer: number | null = null
let started = false

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readStorageFlag(key: string): boolean {
  if (!canUseStorage()) return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeStorageFlag(key: string, enabled: boolean): void {
  if (!canUseStorage()) return
  try {
    if (enabled) {
      window.localStorage.setItem(key, '1')
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // ignore storage write errors
  }
}

function initializeFlagState(): void {
  if (flagState.initialized) return
  flagState.initialized = true
  flagState.enabled = readStorageFlag(PERF_ENABLED_KEY)
  flagState.cuts.fsEvents = readStorageFlag(`${PERF_CUT_PREFIX}fsEvents`)
  flagState.cuts.chatStreamRender = readStorageFlag(`${PERF_CUT_PREFIX}chatStreamRender`)
  flagState.cuts.chatAutoScroll = readStorageFlag(`${PERF_CUT_PREFIX}chatAutoScroll`)
  flagState.cuts.disableWatchers = readStorageFlag(`${PERF_CUT_PREFIX}disableWatchers`)
  flagState.cuts.chatInputBare = readStorageFlag(`${PERF_CUT_PREFIX}chatInputBare`)
}

export function isPerfDiagnosticsEnabled(): boolean {
  initializeFlagState()
  return flagState.enabled
}

export function isPerfCutEnabled(flag: PerfCutFlag): boolean {
  initializeFlagState()
  return flagState.cuts[flag]
}

export function setPerfDiagnosticsEnabled(enabled: boolean): void {
  initializeFlagState()
  flagState.enabled = enabled
  writeStorageFlag(PERF_ENABLED_KEY, enabled)
}

export function setPerfCutFlag(flag: PerfCutFlag, enabled: boolean): void {
  initializeFlagState()
  flagState.cuts[flag] = enabled
  writeStorageFlag(`${PERF_CUT_PREFIX}${flag}`, enabled)
}

function ensureMetric(name: string): Metric {
  const current = metricMap.get(name)
  if (current) return current
  const next: Metric = { count: 0, totalMs: 0, maxMs: 0 }
  metricMap.set(name, next)
  return next
}

export function perfMark(name: string): void {
  if (!isPerfDiagnosticsEnabled()) return
  const metric = ensureMetric(name)
  metric.count += 1
}

export function perfMeasure(name: string, durationMs: number): void {
  if (!isPerfDiagnosticsEnabled()) return
  const metric = ensureMetric(name)
  metric.count += 1
  metric.totalMs += durationMs
  metric.maxMs = Math.max(metric.maxMs, durationMs)
}

function flushMetrics(): void {
  if (!isPerfDiagnosticsEnabled()) return
  if (metricMap.size === 0) return

  const lines = Array.from(metricMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, metric]) => {
      const avgMs = metric.count > 0 ? metric.totalMs / metric.count : 0
      return `${name}: count=${metric.count}${metric.totalMs > 0 ? ` avg=${avgMs.toFixed(1)}ms max=${metric.maxMs.toFixed(1)}ms` : ''}`
    })

  console.info('[perf]', lines.join(' | '))
  metricMap.clear()
}

function startFlushLoop(): void {
  if (flushTimer != null) return
  if (!isPerfDiagnosticsEnabled()) return
  flushTimer = window.setInterval(flushMetrics, FLUSH_INTERVAL_MS)
}

function startLongTaskObserver(): void {
  if (!isPerfDiagnosticsEnabled()) return
  if (longTaskObserver != null) return
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      for (const entry of entries) {
        perfMeasure('longtask.ms', entry.duration)
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask not supported in this runtime
  }
}

function startFrameMonitor(): void {
  if (!isPerfDiagnosticsEnabled()) return
  if (typeof window === 'undefined') return
  if (frameMonitorRaf != null) return

  const tick = (ts: number) => {
    if (lastFrameTs != null) {
      const delta = ts - lastFrameTs
      if (delta > 0 && delta < 200) {
        frameSampleCount += 1
        // Track runtime baseline first, then detect jank relative to it.
        if (frameSampleCount <= 60) {
          frameBaselineMs = frameBaselineMs * 0.9 + delta * 0.1
        } else {
          const overBaseline = delta - frameBaselineMs
          if (overBaseline > 8) {
            perfMeasure('frame.jank_over_baseline.ms', overBaseline)
          }
          if (overBaseline > 25) {
            perfMark('frame.jank.25ms')
          }
          if (delta > 50) {
            perfMark('frame.drop.50ms')
          }
        }
      }
    }
    lastFrameTs = ts
    frameMonitorRaf = window.requestAnimationFrame(tick)
  }

  frameMonitorRaf = window.requestAnimationFrame(tick)
}

function startEventLoopMonitor(): void {
  if (!isPerfDiagnosticsEnabled()) return
  if (typeof window === 'undefined') return
  if (eventLoopTimer != null) return

  const intervalMs = 100
  let expected = performance.now() + intervalMs
  eventLoopTimer = window.setInterval(() => {
    const now = performance.now()
    const lag = now - expected
    expected = now + intervalMs

    if (lag > 20) {
      perfMeasure('eventloop.lag.ms', lag)
    }
    if (lag > 100) {
      perfMark('eventloop.block.100ms')
    }
  }, intervalMs)
}

function installGlobalApi(): void {
  if (typeof window === 'undefined') return
  const globalObj = window as unknown as {
    __acbPerf?: {
      status: () => {
        enabled: boolean
        cuts: Record<PerfCutFlag, boolean>
        keys: {
          enabled: string
          cuts: Record<PerfCutFlag, string>
        }
      }
      enable: () => void
      disable: () => void
      cut: (flag: PerfCutFlag, enabled?: boolean) => void
      clearCuts: () => void
    }
  }

  if (globalObj.__acbPerf) return

  const cutKeys: Record<PerfCutFlag, string> = {
    fsEvents: `${PERF_CUT_PREFIX}fsEvents`,
    chatStreamRender: `${PERF_CUT_PREFIX}chatStreamRender`,
    chatAutoScroll: `${PERF_CUT_PREFIX}chatAutoScroll`,
    disableWatchers: `${PERF_CUT_PREFIX}disableWatchers`,
    chatInputBare: `${PERF_CUT_PREFIX}chatInputBare`,
  }

  globalObj.__acbPerf = {
    status: () => ({
      enabled: isPerfDiagnosticsEnabled(),
      cuts: {
        fsEvents: isPerfCutEnabled('fsEvents'),
        chatStreamRender: isPerfCutEnabled('chatStreamRender'),
        chatAutoScroll: isPerfCutEnabled('chatAutoScroll'),
        disableWatchers: isPerfCutEnabled('disableWatchers'),
        chatInputBare: isPerfCutEnabled('chatInputBare'),
      },
      keys: {
        enabled: PERF_ENABLED_KEY,
        cuts: cutKeys,
      },
    }),
    enable: () => {
      setPerfDiagnosticsEnabled(true)
      startFlushLoop()
      startLongTaskObserver()
      startFrameMonitor()
      startEventLoopMonitor()
      console.info('[perf] enabled')
    },
    disable: () => {
      setPerfDiagnosticsEnabled(false)
      flushMetrics()
      console.info('[perf] disabled')
    },
    cut: (flag: PerfCutFlag, enabled = true) => {
      setPerfCutFlag(flag, enabled)
      console.info(`[perf] cut.${flag}=${enabled ? 'on' : 'off'}`)
    },
    clearCuts: () => {
      setPerfCutFlag('fsEvents', false)
      setPerfCutFlag('chatStreamRender', false)
      setPerfCutFlag('chatAutoScroll', false)
      setPerfCutFlag('disableWatchers', false)
      setPerfCutFlag('chatInputBare', false)
      console.info('[perf] all cut flags cleared')
    },
  }
}

export function startPerfDiagnostics(): void {
  if (started) return
  started = true
  installGlobalApi()
  if (!isPerfDiagnosticsEnabled()) return
  startFlushLoop()
  startLongTaskObserver()
  startFrameMonitor()
  startEventLoopMonitor()
  console.info('[perf] diagnostics active. Use window.__acbPerf.status() to inspect flags.')
}

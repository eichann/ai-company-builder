// The per-step states of 「ブラウザ操作」's runs, kept on this PC (agent-browser.md "The runner"): plan
// id, operation name, step, state, a fixed reason word, a time — never a value of the site or the
// plan. A plan with any record never runs again (one started and cut off by a crash included: its
// write may have gone out). A file that exists but cannot be read refuses every run (fails closed).
import fs from 'node:fs'
import path from 'node:path'
import { BROWSER_PLAN_MAX_AHEAD_MS, isBrowserRunReason, type BrowserStepRecord, type BrowserStepState } from '../../../shared/browser-runner'
import type { BrowserRunRecords } from './runner'

// A plan runs at most a day after it was made: records older than two days can no longer stop a run.
const KEEP_MS = 2 * BROWSER_PLAN_MAX_AHEAD_MS
const STATES: readonly BrowserStepState[] = ['pending', 'sent', 'succeeded', 'failed', 'unknown']
const WORD = /^[a-z0-9:_-]{1,80}$/i

function valid(r: unknown): r is BrowserStepRecord {
  if (!r || typeof r !== 'object') return false
  const x = r as Record<string, unknown>
  return typeof x.planId === 'string' && WORD.test(x.planId) && typeof x.operation === 'string' && WORD.test(x.operation)
    && Number.isInteger(x.step) && STATES.includes(x.state as BrowserStepState)
    && (x.reason === undefined || isBrowserRunReason(x.reason)) && typeof x.at === 'number'
}

export function createBrowserRunRecords(file: string, log: Pick<Console, 'warn'> = console): BrowserRunRecords & { all(): readonly BrowserStepRecord[] } {
  let records: BrowserStepRecord[] = []
  let broken = false
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error('not a list of records')
    records = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      broken = true
      log.warn('[browser] the record of earlier runs cannot be read; no run starts until it can')
    }
  }
  return {
    has: planId => broken || records.some(r => r.planId === planId),
    put(record) {
      if (broken) throw new Error('records unavailable')
      if (!valid(record)) throw new Error('not a record')
      const next = [...records.filter(r => r.at >= record.at - KEEP_MS), record]
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(tmp, file)
      records = next
    },
    all: () => records,
  }
}

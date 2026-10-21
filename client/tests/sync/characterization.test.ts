// Characterization of git:sync. characterization.golden.json was recorded
// from the original handler in main.ts (before it moved to
// electron/sync/git-sync.ts) by running these scenarios against both and
// requiring identical transcripts — results, dialog texts, every log line,
// commit hashes, backups and final trees. This test keeps the extracted sync
// on that recording: a difference here is a behaviour change. If one is
// intended, re-record with UPDATE_SYNC_GOLDEN=1 and review the JSON diff.
//
// The recording leaves out what varies by machine or git version: temp
// paths, wall-clock timestamps, commit hashes and the git error text that
// follows a log message.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARACTERIZATIONS, runCharacterization } from '../sync-harness/characterization-scenarios'

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'characterization.golden.json')
const CONCURRENCY = Number(process.env.SYNC_HARNESS_CONCURRENCY) || 4
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8')) as Record<string, unknown>
const recorded: Record<string, unknown> = {}

describe('git:sync characterization', { concurrency: CONCURRENCY }, () => {
  for (const name of Object.keys(CHARACTERIZATIONS)) {
    test(name, async t => {
      const transcript = await runCharacterization(name, undefined, t, { hashes: true, fullLogs: false })
      recorded[name] = transcript
      if (!process.env.UPDATE_SYNC_GOLDEN) assert.deepEqual(transcript, golden[name])
    })
  }
})

process.on('exit', () => {
  if (process.env.UPDATE_SYNC_GOLDEN && Object.keys(recorded).length === Object.keys(CHARACTERIZATIONS).length) {
    const ordered = Object.fromEntries(Object.keys(CHARACTERIZATIONS).map(k => [k, recorded[k]]))
    fs.writeFileSync(GOLDEN, JSON.stringify(ordered, null, 2) + '\n')
  }
})

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeClaudeHandoff } from '../../electron/handoff/claude'
import { writeCodexHandoff } from '../../electron/handoff/codex'
import { HandoffTrialStore } from '../../electron/handoff/trial-store'
import { generateCodexText } from '../../electron/agents/codex-text'
import { initial, delta, uncovered, recallQuestion, recallSystem } from './fixture'
import { probeClaudeRecall } from './probe-claude'

const provider = process.argv[2]
const output = process.argv[3]
if (!['claude-code', 'codex'].includes(provider) || !output || !path.isAbsolute(output)) throw new Error('Usage: run.ts <claude-code|codex> <absolute-new-output-directory>')
// Never overwrite an earlier experiment or read live app data.
fs.mkdirSync(output, { recursive: false, mode: 0o700 })
const cwd = path.join(output, 'empty-project')
fs.mkdirSync(cwd)
const store = new HandoffTrialStore(path.join(output, 'memo-store'))
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
const cli = process.env.ACB_HANDOFF_CLAUDE_CLI || path.join(os.homedir(), '.local/bin/claude')
const results: unknown[] = []
for (const [index, messages] of [initial.messages, delta].entries()) {
  const previousMemo = store.read()
  const input = { previousMemo, messages }
  const job = store.begin()
  try {
    const request = { input, cwd, env, signal: job.signal, save: job.save }
    const metrics = provider === 'claude-code' ? await writeClaudeHandoff({ ...request, cli }) : await writeCodexHandoff(request)
    const markdown = store.read()!
    fs.writeFileSync(path.join(output, `memo-${index + 1}.md`), markdown + '\n')
    results.push({ phase: `memo-${index + 1}`, inputBytes: Buffer.byteLength(JSON.stringify(input)), memoBytes: Buffer.byteLength(markdown), ...metrics })
    fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results.at(-1)))
  } finally { job.close() }
}
// Restart the host-side store too. No native ID or original transcript is passed to recall.
const restarted = new HandoffTrialStore(path.join(output, 'memo-store'))
const recall = JSON.stringify({ memo: restarted.read(), uncovered, question: recallQuestion })
let text: string
if (provider === 'claude-code') {
  const result = await probeClaudeRecall(cli, cwd, recallSystem, recall, env)
  text = result.text
  const { elapsedMs, usage, modelUsage, nativeSessionId } = result
  const metrics = { elapsedMs, usage, modelUsage, nativeSessionId }
  results.push({ phase: 'new-session-recall', ...metrics })
} else {
  text = await generateCodexText({ env, cwd, system: recallSystem, text: recall, signal: new AbortController().signal, modelId: 'gpt-5.6-luna', onMetrics: metrics => results.push({ phase: 'new-session-recall', ...metrics }) })
}
fs.writeFileSync(path.join(output, 'new-session-recall.md'), text + '\n')
// Archive: both snapshots disappear and outstanding tool calls fail even after restart.
const late = restarted.begin()
restarted.archive()
let lateSaveRejected = false
try { late.save('late') } catch { lateSaveRejected = true }
const archived = new HandoffTrialStore(path.join(output, 'memo-store'))
results.push({ phase: 'archive', lateSaveRejected, aborted: late.signal.aborted, memoMissingAfterRestart: archived.read() === undefined, files: fs.readdirSync(path.join(output, 'memo-store')) })
late.close()
fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results.slice(-2)))

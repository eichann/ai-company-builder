/**
 * 「ブラウザ操作」's operator launch (agent-browser.md "The operator and the preview", design memo §33.1):
 * a fake `claude` (a node script, started exactly as the real one through `spawnVoiceProcess`'s
 * /bin/sh wrapper) writes down the arguments, the working folder and the environment it really got,
 * and answers with the stream its scenario says. What is protected: the closed start (exact
 * arguments, an environment built from nothing — no secret of the app's environment —, a fresh empty
 * folder), the CLI fixed to its real path for the whole request, the version floor, and every init
 * check, tool request, oversize stream, non-JSON answer and time-out stopping the step.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readOperatorMessage, resolveClaudeBrowserOperatorCli, runClaudeBrowserOperatorStep, type BrowserOperatorCli,
} from '../electron/agents/claude-browser-operator'
import { browserOperatorArgs, BROWSER_OPERATOR_SYSTEM_PROMPT } from '../shared/browser-operator'
import { AGENTS } from '../shared/agents/registry'
import { browserOperatorOf } from '../electron/agents/registry'

const MODEL = AGENTS['claude-code'].tasks.browserOperator!
const FLOOR = AGENTS['claude-code'].browserOperatorCli!.min

let dir: string
let cliLink: string

/** The fake CLI: `--version` prints the scenario's version; otherwise it records its start and plays the scenario. */
const FAKE = (name: string) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path')
const here = path.dirname(process.argv[1])
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'))
if (process.argv.includes('--version')) { process.stdout.write(scenario.version + '\\n'); process.exit(0) }
let stdin = ''
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ script: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin }) + '\\n')
  if (scenario.grandchild) {
    const c = require('child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(here, 'grandchild.pid'), String(c.pid))
  }
  const model = process.argv[process.argv.indexOf('--model') + 1]
  const init = Object.assign({ type: 'system', subtype: 'init', cwd: process.cwd(), model, permissionMode: 'dontAsk', tools: [], mcp_servers: [], slash_commands: [], skills: [], plugins: [], agents: [] }, scenario.init || {})
  const out = []
  for (const line of scenario.lines) {
    if (line === '$INIT') out.push(JSON.stringify(init))
    else if (line === '$HUGE') out.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }] } }))
    else if (line === '$BIG') out.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1536 * 1024) }] } }))
    else out.push(typeof line === 'string' ? line : JSON.stringify(line))
  }
  process.stdout.write(out.join('\\n') + '\\n')
  if (scenario.sleepMs) setTimeout(() => {}, scenario.sleepMs)
})
`

const answer = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text })
const STOP = JSON.stringify({ do: 'stop', why: 'not-found', question: '' })

function scenario(s: { version?: string; lines?: unknown[]; init?: Record<string, unknown>; sleepMs?: number; grandchild?: boolean }) {
  fs.writeFileSync(path.join(dir, 'bin', 'scenario.json'), JSON.stringify({ version: '2.1.320 (Claude Code)', lines: ['$INIT', answer(STOP)], ...s }))
  fs.rmSync(path.join(dir, 'bin', 'calls.jsonl'), { force: true })
}
function calls(): Array<{ script: string; argv: string[]; cwd: string; env: Record<string, string>; stdin: string }> {
  try { return fs.readFileSync(path.join(dir, 'bin', 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

/** The app's environment, with secrets an operator must never get. */
const PARENT = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: os.homedir(), USER: 'member', LOGNAME: 'member',
  HTTPS_PROXY: 'http://proxy.example:8080', https_proxy: 'http://proxy.example:8080', NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  // Long unique markers: a short value ("gh", "aws") can appear by chance in a random temp folder's name.
  ANTHROPIC_API_KEY: 'sk-ant-PLANTED-SECRET-3d8e', CLAUDE_CONFIG_DIR: '/elsewhere-PLANTED-CONFIG-5b17', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_AGENT_SDK_X: '1',
  XDG_CONFIG_HOME: '/x', AWS_SECRET_ACCESS_KEY: 'aws-PLANTED-SECRET-91c2', GITHUB_TOKEN: 'ghp-PLANTED-SECRET-7f3a', SHELL: '/bin/zsh', TERM: 'xterm',
}

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-operator-test-')))
  fs.mkdirSync(path.join(dir, 'bin'))
  for (const name of ['claude-a', 'claude-b']) {
    fs.writeFileSync(path.join(dir, 'bin', name), FAKE(name))
    fs.chmodSync(path.join(dir, 'bin', name), 0o755)
  }
  cliLink = path.join(dir, 'claude')
  fs.symlinkSync(path.join(dir, 'bin', 'claude-a'), cliLink)
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

async function resolved(): Promise<BrowserOperatorCli> {
  const r = await resolveClaudeBrowserOperatorCli(cliLink, FLOOR, PARENT)
  assert.ok(r.ok, JSON.stringify(r))
  return r.cli
}
const step = (cli: BrowserOperatorCli, material: unknown = { m: 1 }, timeoutMs = 20_000, signal = new AbortController().signal) =>
  runClaudeBrowserOperatorStep({ cli, model: MODEL, material, signal, timeoutMs, parentEnv: PARENT })

test('the operator starts with exactly the closed arguments, in a fresh empty folder, with an environment built from nothing', async () => {
  scenario({})
  const cli = await resolved()
  const result = await step(cli, { request: 'material' })
  assert.deepEqual(result, { ok: true, text: STOP })
  const [call] = calls()
  assert.equal(call.script, 'claude-a')
  assert.deepEqual(call.argv, browserOperatorArgs(MODEL))
  assert.deepEqual(browserOperatorArgs(MODEL), [
    '-p', '--model', MODEL, '--safe-mode', '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config',
    '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1',
    '--output-format', 'stream-json', '--verbose', '--system-prompt', BROWSER_OPERATOR_SYSTEM_PROMPT,
  ])
  assert.equal(call.stdin, JSON.stringify({ request: 'material' }), 'the material is data on stdin')
  // The final environment the child got: the table, plus what /bin/sh itself sets.
  const shellOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'])
  const env = Object.fromEntries(Object.entries(call.env).filter(([k]) => !shellOwn.has(k)))
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'HOME', 'HTTPS_PROXY',
    'LANG', 'LOGNAME', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR', 'USER', 'https_proxy',
  ])
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.PATH, `${path.join(dir, 'bin')}:${fs.realpathSync(path.dirname(process.execPath))}:/usr/bin:/bin`)
  for (const secret of ['sk-ant-PLANTED-SECRET-3d8e', '/elsewhere-PLANTED-CONFIG-5b17', 'aws-PLANTED-SECRET-91c2', 'ghp-PLANTED-SECRET-7f3a']) assert.ok(!JSON.stringify(call.env).includes(secret), secret)
  // A new empty folder that is gone afterwards; TMPDIR another one.
  assert.notEqual(call.cwd, env.TMPDIR)
  assert.equal(fs.existsSync(call.cwd), false)
  assert.equal(fs.existsSync(env.TMPDIR), false)
  // Each step its own folder.
  await step(cli)
  assert.notEqual(calls()[1].cwd, call.cwd)
})

test('the CLI is fixed to its real path for the whole request: a PATH or link changed meanwhile is not used', async () => {
  scenario({})
  const cli = await resolved()
  assert.equal(cli.path, path.join(dir, 'bin', 'claude-a'))
  fs.rmSync(cliLink)
  fs.symlinkSync(path.join(dir, 'bin', 'claude-b'), cliLink)
  try {
    await step(cli)
    assert.equal(calls()[0].script, 'claude-a')
  } finally {
    fs.rmSync(cliLink)
    fs.symlinkSync(path.join(dir, 'bin', 'claude-a'), cliLink)
  }
})

test('below the version floor, a version that cannot be read, or no executable file: the operator never starts', async () => {
  scenario({ version: '2.1.300 (Claude Code)' })
  assert.deepEqual(await resolveClaudeBrowserOperatorCli(cliLink, FLOOR, PARENT), { ok: false, code: 'cli-too-old' })
  scenario({ version: 'Claude Code' })
  assert.deepEqual(await resolveClaudeBrowserOperatorCli(cliLink, FLOOR, PARENT), { ok: false, code: 'cli-too-old' })
  scenario({ version: FLOOR })
  assert.equal((await resolveClaudeBrowserOperatorCli(cliLink, FLOOR, PARENT)).ok, true)
  assert.deepEqual(await resolveClaudeBrowserOperatorCli(path.join(dir, 'missing'), FLOOR, PARENT), { ok: false, code: 'cli-missing' })
  assert.deepEqual(await resolveClaudeBrowserOperatorCli('claude', FLOOR, PARENT), { ok: false, code: 'cli-missing' }, 'never looked up on PATH')
  assert.deepEqual(await resolveClaudeBrowserOperatorCli(dir, FLOOR, PARENT), { ok: false, code: 'cli-missing' }, 'a folder')
  const plain = path.join(dir, 'not-executable')
  fs.writeFileSync(plain, FAKE('x'))
  assert.deepEqual(await resolveClaudeBrowserOperatorCli(plain, FLOOR, PARENT), { ok: false, code: 'cli-missing' })
  assert.equal(calls().length, 0, 'only --version was ever asked')
})

test('every start is checked: an init that is not the closed one, a missing or second init, a tool request, an oversize or non-JSON stream, an error answer, a time-out — each stops the step', async () => {
  const cases: Array<[Parameters<typeof scenario>[0], string]> = [
    [{ init: { tools: ['Bash'] } }, 'init-mismatch'],
    [{ init: { mcp_servers: [{ name: 'acb', status: 'connected' }] } }, 'init-mismatch'],
    [{ init: { slash_commands: ['compact'] } }, 'init-mismatch'],
    [{ init: { skills: ['x'] } }, 'init-mismatch'],
    [{ init: { plugins: [{ name: 'p' }] } }, 'init-mismatch'],
    [{ init: { agents: ['general-purpose'] } }, 'init-mismatch'],
    [{ init: { cwd: '/tmp' } }, 'init-mismatch'],
    [{ init: { permissionMode: 'bypassPermissions' } }, 'init-mismatch'],
    [{ init: { model: 'claude-haiku-4-5' } }, 'init-mismatch'],
    [{ init: { tools: 'none' } }, 'init-mismatch'],
    [{ lines: [answer(STOP)] }, 'init-mismatch'],
    [{ lines: ['$INIT', '$INIT', answer(STOP)] }, 'init-mismatch'],
    [{ lines: [] }, 'start-failed'],
    [{ lines: ['$INIT', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: {} }] } }, answer(STOP)] }, 'tool-asked'],
    [{ lines: ['$INIT', { type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'web_search' }] } }, answer(STOP)] }, 'tool-asked'],
    [{ lines: ['$INIT', '$HUGE', answer(STOP)] }, 'bad-answer'],
    [{ lines: ['$INIT', '$BIG', '$BIG', '$BIG', answer(STOP)] }, 'bad-answer'],
    [{ lines: ['$INIT', 'not json', answer(STOP)] }, 'bad-answer'],
    [{ lines: ['$INIT'] }, 'bad-answer'],
    [{ lines: ['$INIT', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Invalid API key · Please run /login' }] }, 'not-signed-in'],
    [{ lines: ['$INIT', { type: 'result', subtype: 'error_max_turns', is_error: true }] }, 'bad-answer'],
  ]
  const cli = await resolved()
  for (const [s, code] of cases) {
    scenario(s)
    assert.deepEqual(await step(cli), { ok: false, code }, JSON.stringify(s).slice(0, 120))
  }
  // A managed hook's system message before init is the company's own: not a reason to stop.
  scenario({ lines: [{ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart' }, '$INIT', answer(STOP)] })
  assert.deepEqual(await step(cli), { ok: true, text: STOP })
  // The CLI may report the model without its 1M suffix.
  scenario({ init: { model: MODEL.replace(/\[1m\]$/, '') } })
  assert.equal((await step(cli)).ok, true)
  // No answer in time: killed, `timeout`; stopped by its request: `cancelled`.
  scenario({ lines: ['$INIT'], sleepMs: 60_000 })
  assert.deepEqual(await step(cli, {}, 1500), { ok: false, code: 'timeout' })
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 300)
  assert.deepEqual(await step(cli, {}, 20_000, stop.signal), { ok: false, code: 'cancelled' })
})

test('a stream message out of order is refused before init, and only Claude Code is an operator', () => {
  const state = { init: false }
  const expected = { cwd: '/w', model: MODEL }
  assert.equal(readOperatorMessage({ type: 'assistant', message: { content: [] } }, state, expected), 'init-mismatch')
  assert.equal(readOperatorMessage(null, state, expected), 'init-mismatch')
  assert.ok(browserOperatorOf('claude-code'))
  assert.equal(browserOperatorOf('codex'), null)
  assert.equal(browserOperatorOf('api-key'), null)
})

test('a stopped step takes every process the CLI started with it (its own process group)', async () => {
  const cli = await resolved()
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  for (const [s, code] of [[{ lines: ['$INIT'], sleepMs: 60_000, grandchild: true }, 'timeout'], [{ lines: ['$INIT', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }], sleepMs: 60_000, grandchild: true }, 'tool-asked']] as const) {
    scenario(s)
    fs.rmSync(path.join(dir, 'bin', 'grandchild.pid'), { force: true })
    assert.deepEqual(await step(cli, {}, 1500), { ok: false, code })
    const pidFile = path.join(dir, 'bin', 'grandchild.pid')
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 20))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(alive(pid), false, `${code}: the CLI's own child is gone`)
  }
})

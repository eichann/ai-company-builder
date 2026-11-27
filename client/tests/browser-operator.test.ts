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
import { BROWSER_OPERATOR_IMAGE_MAX_BYTES } from '../shared/browser-operator'
import { browserOperatorArgs, BROWSER_OPERATOR_SYSTEM_PROMPT, operatorInitProblem } from '../shared/browser-operator'
import { BROWSER_OPERATOR_BROWSE_PROMPT } from '../shared/browser-browse'
import { AGENTS } from '../shared/agents/registry'
import { browserOperatorOf } from '../electron/agents/registry'
import { makeTempDir } from '../../shared/testing/temp-dirs'

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
  fs.writeFileSync(path.join(dir, 'bin', 'scenario.json'), JSON.stringify({ version: '2.1.330 (Claude Code)', lines: ['$INIT', answer(STOP)], ...s }))
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
  dir = fs.realpathSync(makeTempDir('acb-operator-test-'))
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

/** What the fake CLI read on stdin: the one stream-json user message. */
function userMessage(stdin: string): { type: string; message: { role: string; content: Array<Record<string, unknown>> } } {
  const lines = stdin.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, 'exactly one stream-json message')
  return JSON.parse(lines[0])
}

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
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--system-prompt', BROWSER_OPERATOR_SYSTEM_PROMPT,
  ])
  // The window tools' start (agent-browser.md "The operator's window tools") is the same closed start — still no tool —
  // with only its own fixed prompt.
  const browse = browserOperatorArgs(MODEL, 'browse')
  assert.deepEqual(browse.slice(0, -1), browserOperatorArgs(MODEL).slice(0, -1))
  assert.equal(browse.at(-1), BROWSER_OPERATOR_BROWSE_PROMPT)
  assert.equal(browse[browse.indexOf('--tools') + 1], '')
  // The material is data on stdin: one user message holding it as JSON text, and nothing else (no image for the preview).
  assert.deepEqual(userMessage(call.stdin), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: JSON.stringify({ request: 'material' }) }] } })
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

test('the screen image goes to the operator\'s stdin beside the material and nowhere else: no file in its folders, no argument, no variable; one over the cap is left out', async () => {
  scenario({})
  const cli = await resolved()
  // A JPEG-like body with a marker no other channel could carry by chance.
  const marker = Buffer.from('ACB-SCREEN-MARKER-9f31')
  const data = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), marker, Buffer.alloc(2048, 7)]))
  const result = await runClaudeBrowserOperatorStep({ cli, model: MODEL, material: { page: 'p' }, signal: new AbortController().signal, timeoutMs: 20_000, parentEnv: PARENT, prompt: 'browse', image: { mediaType: 'image/jpeg', data } })
  assert.deepEqual(result, { ok: true, text: STOP })
  const [call] = calls()
  const content = userMessage(call.stdin).message.content
  assert.deepEqual(content[0], { type: 'text', text: JSON.stringify({ page: 'p' }) })
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(data).toString('base64') } })
  assert.equal(content.length, 2)
  const b64 = Buffer.from(data).toString('base64').slice(0, 40)
  assert.ok(!call.argv.join(' ').includes(b64) && !JSON.stringify(call.env).includes(b64), 'never an argument or a variable')
  // Its working folder and TMPDIR are gone; nothing of the image was written anywhere under them meanwhile either (the
  // fake wrote only its own record outside them).
  assert.equal(fs.existsSync(call.cwd), false)
  assert.equal(fs.existsSync(call.env.TMPDIR), false)
  // An image over the cap is left out whole (the step still goes, with the text alone), never cut.
  scenario({})
  const big = new Uint8Array(BROWSER_OPERATOR_IMAGE_MAX_BYTES + 1)
  await runClaudeBrowserOperatorStep({ cli, model: MODEL, material: { page: 'p' }, signal: new AbortController().signal, timeoutMs: 20_000, parentEnv: PARENT, prompt: 'browse', image: { mediaType: 'image/jpeg', data: big } })
  assert.deepEqual(userMessage(calls()[0].stdin).message.content.map(c => c.type), ['text'])
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
    // Only a plugin built into the CLI binary passes (6c, CLI 2.1.330): the member's or a marketplace's never.
    [{ init: { plugins: [{ name: 'p', path: '/Users/x/.claude/plugins/p', source: 'p@market' }] } }, 'init-mismatch'],
    [{ init: { plugins: [{ name: 'p', path: 'builtin', source: 'q@builtin' }] } }, 'init-mismatch'],
    [{ init: { plugins: [{ name: 'p', path: '/Users/x/p', source: 'p@builtin' }] } }, 'init-mismatch'],
    [{ init: { plugins: [{ name: 'p', path: 'builtin', source: 'p@builtin', hooks: {} }] } }, 'init-mismatch'],
    [{ init: { plugins: 'builtin' } }, 'init-mismatch'],
    // Only the CLI's own agents (unusable without a tool): a member's agent never.
    [{ init: { agents: ['general-purpose', 'my-agent'] } }, 'init-mismatch'],
    [{ init: { agents: 'Plan' } }, 'init-mismatch'],
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

test('the init the real CLI 2.1.330 sends under every flag passes (6c, the owner\'s Mac): its built-in plugins and agents only', () => {
  const real = {
    type: 'system', subtype: 'init', cwd: '/w', model: 'claude-opus-5-5', permissionMode: 'dontAsk', tools: [], mcp_servers: [], slash_commands: [], skills: [],
    plugins: ['cc-plugin-sec-default', 'cc-plugin-agents-md', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map(name => ({ name, path: 'builtin', source: `${name}@builtin` })),
    agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
  }
  assert.equal(operatorInitProblem(real, { cwd: '/w', model: 'claude-opus-5-5[1m]' }), null)
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

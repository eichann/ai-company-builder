import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ACB_SET_KEYS, agentEnv, buildAgentEnv, configureAgentEnv, isDeniedName, normalizePassthroughNames,
  refusedPassthroughNames, resetAgentEnvForTests,
} from '../electron/agents/agent-env'
import { spawnAgentProcess } from '../electron/agents/process'
import { runClaudeOneShot } from '../electron/claude-oneshot'
import { getCodexStatus } from '../electron/agents/codex'
import { createClaudeConnection } from '../electron/agents/claude'

afterEach(() => resetAgentEnvForTests())

const SECRETS = {
  FAKE_SECRET_TOKEN: 'planted-token-value',
  GITHUB_TOKEN: 'ghp_planted',
  AWS_ACCESS_KEY_ID: 'AKIAPLANTED',
  AWS_SECRET_ACCESS_KEY: 'planted-aws',
  OPENAI_API_KEY: 'sk-planted',
  ANTHROPIC_API_KEY: 'sk-ant-planted',
  DATABASE_URL: 'postgres://u:p@h/db',
  GOOGLE_APPLICATION_CREDENTIALS: '/tmp/planted.json',
  CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth',
  STRIPE_KEY: 'planted',
  MY_SERVICE_PASSWORD: 'planted',
}

test('the allowlist keeps what the CLIs and tools need and drops everything else', () => {
  const source = {
    PATH: '/usr/bin:/bin', HOME: '/Users/m', USER: 'm', LOGNAME: 'm', SHELL: '/bin/zsh', TMPDIR: '/tmp/x',
    LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', LC_CTYPE: 'UTF-8', TERM: 'xterm', TZ: 'Asia/Tokyo',
    XDG_CONFIG_HOME: '/Users/m/.config', SSH_AUTH_SOCK: '/tmp/ssh.sock',
    HTTPS_PROXY: 'http://proxy:8080', https_proxy: 'http://proxy:8080', no_proxy: 'localhost', ALL_PROXY: 'socks5://p',
    NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/ca.pem', REQUESTS_CA_BUNDLE: '/ca.pem',
    CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_AGENT_SDK_VERSION: '0.3', ACB_DEBUG: '1',
    // not on the list
    EDITOR: 'vim', NVM_DIR: '/n', MY_APP_SETTING: 'x', CLAUDECODE: '1', npm_config_prefix: '/p',
    ...SECRETS,
  }
  const { env, dropped } = buildAgentEnv(source)
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK', 'HTTPS_PROXY', 'https_proxy', 'no_proxy', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
    'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_AGENT_SDK_VERSION', 'ACB_DEBUG']) {
    assert.equal(env[key], source[key as keyof typeof source], key)
  }
  for (const key of ['EDITOR', 'NVM_DIR', 'MY_APP_SETTING', 'CLAUDECODE', 'npm_config_prefix', ...Object.keys(SECRETS)]) {
    assert.ok(!(key in env), key)
    assert.ok(dropped.includes(key), key)
  }
  assert.deepEqual(dropped, [...dropped].sort())
})

test('Windows names are kept whatever their spelling (Path, SystemRoot, ProgramFiles(x86), …)', () => {
  const source = {
    Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', SYSTEMDRIVE: 'C:', ComSpec: 'C:\\Windows\\cmd.exe', PATHEXT: '.COM;.EXE',
    APPDATA: 'a', LOCALAPPDATA: 'l', USERPROFILE: 'u', USERNAME: 'm', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\m',
    ProgramData: 'pd', ProgramFiles: 'pf', 'ProgramFiles(x86)': 'pf86', ProgramW6432: 'pw', windir: 'C:\\Windows',
    TEMP: 't', TMP: 't', PROCESSOR_ARCHITECTURE: 'AMD64',
    OneDrive: 'C:\\Users\\m\\OneDrive', AZURE_CLIENT_SECRET: 'planted',
  }
  const { env } = buildAgentEnv(source)
  for (const key of Object.keys(source).filter(k => k !== 'OneDrive' && k !== 'AZURE_CLIENT_SECRET')) assert.equal(env[key], source[key as keyof typeof source], key)
  assert.ok(!('OneDrive' in env))
  assert.ok(!('AZURE_CLIENT_SECRET' in env))
})

test('deny beats allow: a secret-looking name under an allowed prefix or in the pass-through list is dropped', () => {
  const source = { CLAUDE_CODE_OAUTH_TOKEN: 'x', ACB_SECRET: 'x', XDG_SESSION_PASSWORD: 'x', LC_API_KEY: 'x', JAVA_HOME: '/j', GITHUB_TOKEN: 'x', AWS_PROFILE: 'p' }
  const { env } = buildAgentEnv(source, ['JAVA_HOME', 'GITHUB_TOKEN', 'aws_profile'])
  assert.deepEqual(env, { JAVA_HOME: '/j' })
  for (const name of Object.keys(SECRETS)) assert.equal(isDeniedName(name), true, name)
  for (const name of ['PATH', 'HOME', 'JAVA_HOME', 'SSH_AUTH_SOCK', 'ANTHROPIC_BASE_URL', 'PYTHONPATH']) assert.equal(isDeniedName(name), false, name)
})

test('ACB-set keys are always kept, even if a deny rule would match', () => {
  const source: Record<string, string> = Object.fromEntries(ACB_SET_KEYS.map(key => [key, 'v']))
  const { env, dropped } = buildAgentEnv(source)
  assert.deepEqual(Object.keys(env).sort(), [...ACB_SET_KEYS].sort())
  assert.deepEqual(dropped, [])
  for (const key of ACB_SET_KEYS) assert.equal(isDeniedName(key), false)
})

test('pass-through names: exact names only, case-insensitive, secrets and patterns refused', () => {
  assert.deepEqual(buildAgentEnv({ java_home: '/j', PYTHONPATH: '/p', OTHER: 'o' }, ['JAVA_HOME', 'pythonpath']).env, { java_home: '/j', PYTHONPATH: '/p' })
  assert.deepEqual(buildAgentEnv({ MY_X: '1' }, ['MY_*', '*']).env, {})
  assert.deepEqual(normalizePassthroughNames([' JAVA_HOME ', 'java_home', 'GITHUB_TOKEN', 'BAD-NAME', 'MY_*', 3, 'PYTHONPATH']), ['JAVA_HOME', 'PYTHONPATH'])
  assert.deepEqual(refusedPassthroughNames(['JAVA_HOME', 'NPM_TOKEN', 'MY_*']), { invalid: ['MY_*'], denied: ['NPM_TOKEN'] })
  assert.equal(normalizePassthroughNames(Array.from({ length: 80 }, (_, i) => `V${i}`)).length, 50)
})

test('agentEnv logs dropped names once per app start, never values', () => {
  const lines: string[] = []
  configureAgentEnv({ passthroughNames: () => ['JAVA_HOME'], log: line => lines.push(line) })
  const env = agentEnv({ PATH: '/bin', JAVA_HOME: '/j', ...SECRETS })
  assert.deepEqual(env, { PATH: '/bin', JAVA_HOME: '/j' })
  agentEnv({ PATH: '/bin', ...SECRETS })
  agentEnv({ PATH: '/bin', ...SECRETS, EDITOR: 'vim' })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[agent-env\] not passed to AI processes: /)
  assert.match(lines[0], /FAKE_SECRET_TOKEN/)
  assert.equal(lines[1], '[agent-env] not passed to AI processes: EDITOR')
  for (const value of Object.values(SECRETS)) assert.ok(!lines.join('\n').includes(value), value)
})

test('an unreadable pass-through setting means no extras', () => {
  configureAgentEnv({ passthroughNames: () => { throw new Error('config') }, log: () => {} })
  assert.deepEqual(agentEnv({ PATH: '/bin', JAVA_HOME: '/j' }), { PATH: '/bin' })
})

// --- What an AI process actually receives -----------------------------------

const posix = process.platform !== 'win32'

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acb-agent-env-'))
}

/** A fake CLI that writes its environment to `dump` and prints `stdout`. */
function fakeCli(dir: string, name: string, dump: string, stdout = '') {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\nenv > '${dump}'\nprintf '%s' '${stdout}'\nexit 0\n`, { mode: 0o755 })
  return file
}

const readEnv = (dump: string) => Object.fromEntries(fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))

function withPlantedProcessEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }
  Object.assign(process.env, SECRETS)
  return run().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
}

test('spawnAgentProcess: the child never sees a planted secret, from the caller or from process.env', { skip: !posix }, async () => {
  configureAgentEnv({ passthroughNames: () => [], log: () => {} })
  const dir = scratch()
  const dump = path.join(dir, 'env.txt')
  await withPlantedProcessEnv(async () => {
    const child = spawnAgentProcess({ command: '/bin/sh', args: ['-c', `env > '${dump}'`], env: { ...process.env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true' } })
    await new Promise(resolve => child.on('close', resolve))
    const env = readEnv(dump)
    for (const key of Object.keys(SECRETS)) assert.ok(!(key in env), key)
    assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'true')
    assert.ok(env.PATH)
    // No env from the caller at all: process.env is filtered too.
    const bare = spawnAgentProcess({ command: '/bin/sh', args: ['-c', `env > '${dump}'`] })
    await new Promise(resolve => bare.on('close', resolve))
    for (const key of Object.keys(SECRETS)) assert.ok(!(key in readEnv(dump)), key)
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Claude Code chat through the real provider and SDK: the CLI gets no planted secret', { skip: !posix }, async () => {
  configureAgentEnv({ passthroughNames: () => [], log: () => {} })
  const dir = scratch()
  const dump = path.join(dir, 'env.txt')
  const cli = fakeCli(dir, 'claude', dump)
  await withPlantedProcessEnv(async () => {
    const connection = createClaudeConnection({
      getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => cli,
      // The shell environment as main.ts hands it over: everything, secrets included.
      getShellEnv: () => ({ ...process.env as Record<string, string> }),
    })
    const model = connection.createChatModel({ workingDirectory: dir })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanguageModelV3 call options, loosely
      const { stream } = await (model as any).doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      for await (const part of stream) void part
    } catch { /* the fake CLI speaks no protocol; only its environment matters */ }
    for (let i = 0; i < 50 && !fs.existsSync(dump); i++) await new Promise(resolve => setTimeout(resolve, 100))
    const env = readEnv(dump)
    for (const key of Object.keys(SECRETS)) assert.ok(!(key in env), key)
    assert.ok(env.PATH)
    assert.ok(env.CLAUDE_CODE_ENTRYPOINT, 'what the SDK sets still arrives')
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('one-shot claude -p (commit messages, voice): no planted secret, process.env not merged back', { skip: !posix }, async () => {
  configureAgentEnv({ passthroughNames: () => [], log: () => {} })
  const dir = scratch()
  const dump = path.join(dir, 'env.txt')
  const cli = fakeCli(dir, 'claude', dump, '{"result":"ok"}')
  const messages = { cancelled: 'c', timedOut: 't', spawnFailed: 's', stdinFailed: 'i', tooLong: 'l', exitFailed: 'e', invalid: 'v' }
  await withPlantedProcessEnv(async () => {
    const text = await runClaudeOneShot({ cli, cwd: dir, model: 'm', systemPrompt: 's', input: {}, signal: new AbortController().signal, env: { PATH: process.env.PATH, ...SECRETS }, timeoutMs: 10_000, messages })
    assert.equal(text, 'ok')
    const env = readEnv(dump)
    for (const key of Object.keys(SECRETS)) assert.ok(!(key in env), key)
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Codex app-server: no planted secret', { skip: !posix }, async () => {
  configureAgentEnv({ passthroughNames: () => ['JAVA_HOME'], log: () => {} })
  const dir = scratch()
  const dump = path.join(dir, 'env.txt')
  fakeCli(dir, 'codex', dump)
  const status = await getCodexStatus({ PATH: `${dir}:/usr/bin:/bin`, JAVA_HOME: '/j', ...SECRETS }, 'darwin')
  assert.equal(status.authenticated, false)
  const env = readEnv(dump)
  for (const key of Object.keys(SECRETS)) assert.ok(!(key in env), key)
  assert.equal(env.JAVA_HOME, '/j')
  fs.rmSync(dir, { recursive: true, force: true })
})

// 「Claude にログインする」 (services/claude-sign-in.ts, shared/claude-sign-in.ts):
// the app starts the official CLI's own sign-in and asks its status, never
// blocks a member it cannot judge, and always ends a sign-in in a clear state.
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claudeAccountNotice, claudeSignInSupported, readClaudeAuthStatus, signInPageUrl } from '../shared/claude-sign-in'
import { createClaudeSignIn, withSignIn, type ClaudeSignInDeps, type SignInChild } from '../electron/services/claude-sign-in'
import { claudeCodeReady } from '../src/features/chat/claudeSetup'
import type { ClaudeCodeStatus } from '../shared/ipc-contract'

const SIGNED_IN_TEAM = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgName: 'Example', subscriptionType: 'team' })
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
const PAGE = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'
const ROOT = '/Users/me/Company'

class FakeChild extends EventEmitter implements SignInChild {
  stdout = new EventEmitter() as SignInChild['stdout'] & EventEmitter
  stderr = new EventEmitter() as SignInChild['stderr'] & EventEmitter
  stdin = { end: () => undefined }
  killed: NodeJS.Signals | undefined
  /** A CLI stuck somewhere that does not end on SIGTERM. */
  stubborn = false
  constructor(readonly args: string[], readonly cwd: string) { super() }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killed = signal
    if (!this.stubborn || signal === 'SIGKILL') setImmediate(() => this.emit('close', null))
    return true
  }
  answer(stdout: string, code: number) {
    setImmediate(() => { (this.stdout as EventEmitter).emit('data', Buffer.from(stdout)); this.emit('close', code) })
  }
}

/** A fake CLI: `auth status` answers from `statuses` in turn; `auth login` is driven by the test. */
function world(options: { statuses?: string[]; version?: string; cli?: string | null; loginTimeoutMs?: number; stubborn?: boolean; slowStatus?: boolean } = {}) {
  const statuses = [...(options.statuses ?? [SIGNED_OUT])]
  const spawned: FakeChild[] = []
  const opened: string[] = []
  const deps: ClaudeSignInDeps = {
    cliPath: () => (options.cli === undefined ? '/Users/me/.local/bin/claude' : options.cli),
    env: () => ({ PATH: '/usr/bin' }),
    readVersion: async () => options.version ?? '2.1.328 (Claude Code)',
    spawn: (_cli, args, _env, cwd) => {
      const child = new FakeChild(args, cwd)
      child.stubborn = !!options.stubborn
      spawned.push(child)
      if (args[1] === 'status' && !options.slowStatus) {
        const out = statuses.length > 1 ? statuses.shift()! : statuses[0]
        child.answer(out, out.includes('"loggedIn":false') ? 1 : 0)
      }
      return child
    },
    openExternal: async url => { opened.push(url) },
    loginTimeoutMs: options.loginTimeoutMs,
    statusTimeoutMs: 20,
    killGraceMs: 20,
  }
  const service = createClaudeSignIn(deps)
  const logins = () => spawned.filter(c => c.args[1] === 'login')
  const nextLogin = async () => {
    for (let i = 0; i < 50 && logins().length === 0; i++) await new Promise(r => setImmediate(r))
    const login = logins().at(-1)
    assert.ok(login, 'the app started claude auth login')
    return login
  }
  return { service, spawned, opened, logins, nextLogin }
}

describe('reading claude auth status', () => {
  it('signed out only when the CLI says loggedIn: false itself', () => {
    assert.equal(readClaudeAuthStatus(SIGNED_OUT).state, 'signed-out')
    // Today's members keep working whenever the answer cannot be read.
    for (const unreadable of ['', 'Not logged in. Run claude auth login to authenticate.', '{"loggedIn":"no"}', '{broken', 'error: unknown command \'auth\'']) {
      assert.equal(readClaudeAuthStatus(unreadable).state, 'unknown', unreadable)
    }
    // Bedrock / Vertex sign in elsewhere: never treated as signed out.
    assert.equal(readClaudeAuthStatus(JSON.stringify({ loggedIn: false, apiProvider: 'bedrock' })).state, 'unknown')
  })

  it('keeps only the account kind, never the address or the organisation', () => {
    const signIn = readClaudeAuthStatus(SIGNED_IN_TEAM)
    assert.deepEqual(signIn, { state: 'signed-in', account: 'team' })
    assert.ok(!JSON.stringify(signIn).includes('example'))
  })

  it('tells a personal account apart, as a notice only', () => {
    const personal = readClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }))
    assert.equal(personal.account, 'personal')
    assert.match(claudeAccountNotice(personal) ?? '', /個人/)
    assert.equal(claudeAccountNotice(readClaudeAuthStatus(SIGNED_IN_TEAM)), undefined)
  })
})

describe('the sign-in page address', () => {
  it('is taken only from Anthropic\'s own hosts', () => {
    assert.equal(signInPageUrl(`If the browser didn't open, visit: ${PAGE}\n`), PAGE)
    // A terminal hyperlink (OSC 8) around the address.
    assert.equal(signInPageUrl(`visit: \x1b]8;;${PAGE}\x07${PAGE}\x1b]8;;\x07\n`), PAGE)
    // Sentence punctuation after the address stays out of it (it would corrupt the sign-in state).
    assert.equal(signInPageUrl(`Open ${PAGE}.\n`), PAGE)
    assert.equal(signInPageUrl(`(see ${PAGE})\n`), PAGE)
    for (const other of ['https://claude.ai.evil.example/x', 'http://claude.ai/x', 'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'https://example.com/claude.ai']) {
      assert.equal(signInPageUrl(`visit: ${other}`), undefined, other)
    }
  })
})

describe('checking the sign-in', () => {
  it('the floor is the CLI whose auth status no longer signs the member out (2.1.317)', () => {
    assert.equal(claudeSignInSupported('2.1.316 (Claude Code)'), false)
    assert.equal(claudeSignInSupported('2.1.317 (Claude Code)'), true)
    assert.equal(claudeSignInSupported('3.0.0 (Claude Code)'), true)
    assert.equal(claudeSignInSupported(''), false)
  })

  it('runs no auth command on a CLI older than the floor (keeps today\'s behaviour)', async () => {
    const { service, spawned } = world({ version: '2.1.316 (Claude Code)' })
    assert.deepEqual(await service.check(ROOT), { signIn: { state: 'unknown' }, signInSupported: false })
    assert.equal(spawned.length, 0)
  })

  it('asks in the chat\'s company folder, and without one never blocks (project settings may sign in another way)', async () => {
    const { service, spawned } = world()
    assert.equal((await service.check(ROOT)).signIn.state, 'signed-out')
    assert.deepEqual(spawned.map(c => c.cwd), [ROOT])
    assert.deepEqual(await service.check(undefined), { signIn: { state: 'unknown' }, signInSupported: false })
    assert.equal(spawned.length, 1)
  })

  it('a slow auth status is unknown and is left to finish (stopping it could cut a token refresh)', async () => {
    const { service, spawned } = world({ slowStatus: true })
    assert.equal((await service.check(ROOT)).signIn.state, 'unknown')
    assert.equal(spawned[0].killed, undefined)
    // At quit, best effort: a check still running is stopped too.
    service.stop()
    assert.equal(spawned[0].killed, 'SIGTERM')
  })

  it('several windows asking at once share one auth status', async () => {
    const { service, spawned } = world({ statuses: [SIGNED_IN_TEAM] })
    const answers = await Promise.all([service.check(ROOT), service.check(ROOT), service.check(ROOT)])
    assert.equal(spawned.length, 1)
    assert.ok(answers.every(a => a.signIn.state === 'signed-in'))
  })
})

describe('signing in', () => {
  it('already signed in (terminal or desktop app): changes nothing, starts no login', async () => {
    const { service, logins } = world({ statuses: [SIGNED_IN_TEAM] })
    const result = await service.start(ROOT)
    assert.equal(result.outcome, 'signed-in')
    assert.equal(logins().length, 0)
  })

  it('a finished login counts only once the CLI reports it signed in', async () => {
    const ok = world({ statuses: [SIGNED_OUT, SIGNED_IN_TEAM] })
    const pending = ok.service.start(ROOT)
    ;(await ok.nextLogin()).answer('Login successful.\n', 0)
    assert.equal((await pending).outcome, 'signed-in')

    const notReally = world({ statuses: [SIGNED_OUT, SIGNED_OUT] })
    const second = notReally.service.start(ROOT)
    ;(await notReally.nextLogin()).answer('', 0)
    assert.equal((await second).outcome, 'still-signed-out')

    // Exit 0 but the CLI's answer afterwards cannot be read: not reported as signed in.
    const unread = world({ statuses: [SIGNED_OUT, 'not json'] })
    const third = unread.service.start(ROOT)
    ;(await unread.nextLogin()).answer('', 0)
    assert.equal((await third).outcome, 'unverified')
  })

  it('two windows or two companies pressing at once share one login', async () => {
    const { service, nextLogin, logins } = world()
    const a = service.start(ROOT)
    const b = service.start(ROOT)
    await nextLogin()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(logins().length, 1)
    service.cancel()
    assert.deepEqual(await a, await b)
  })

  it('やめる stops the CLI and ends cancelled; the next press starts again', async () => {
    const { service, nextLogin, logins } = world()
    const pending = service.start(ROOT)
    const login = await nextLogin()
    assert.equal(service.cancel(), true)
    assert.equal(login.killed, 'SIGTERM')
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal(service.cancel(), false)
    const again = service.start(ROOT)
    await new Promise(r => setTimeout(r, 5))
    assert.equal(logins().length, 2)
    service.cancel()
    await again
  })

  it('a browser that never comes back is stopped after the time limit', async () => {
    const { service, nextLogin } = world({ loginTimeoutMs: 20 })
    const pending = service.start(ROOT)
    const login = await nextLogin()
    const result = await pending
    assert.equal(login.killed, 'SIGTERM')
    assert.equal(result.outcome, 'timed-out')
    assert.match(result.message, /インターネット/)
  })

  it('a CLI that ignores やめる is killed, and the sign-in still ends', async () => {
    const { service, nextLogin } = world({ stubborn: true })
    const pending = service.start(ROOT)
    const login = await nextLogin()
    service.cancel()
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal(login.killed, 'SIGKILL')
  })

  it('a CLI removed after it was found (the shell answers 127) says it is not installed', async () => {
    const { service, nextLogin } = world()
    const pending = service.start(ROOT)
    ;(await nextLogin()).answer('', 127)
    assert.equal((await pending).outcome, 'not-installed')
  })

  it('the sign-in runs in the chat\'s folder; without one nothing is started', async () => {
    const { service, nextLogin, spawned } = world()
    const pending = service.start(ROOT)
    assert.equal((await nextLogin()).cwd, ROOT)
    service.cancel()
    await pending
    const none = world()
    assert.equal((await none.service.start(undefined)).outcome, 'failed')
    assert.equal(none.spawned.length, 0)
    assert.ok(spawned.length > 0)
  })

  it('a failed login (offline, refused) ends failed with a plain message', async () => {
    const { service, nextLogin } = world()
    const pending = service.start(ROOT)
    ;(await nextLogin()).answer('', 1)
    const result = await pending
    assert.equal(result.outcome, 'failed')
    assert.doesNotMatch(result.message, /claude auth|terminal|ターミナル/)
  })

  it('quitting the app stops a sign-in left running', async () => {
    const { service, nextLogin } = world()
    const pending = service.start(ROOT)
    const login = await nextLogin()
    service.stop()
    assert.equal(login.killed, 'SIGTERM')
    assert.equal((await pending).outcome, 'cancelled')
  })

  it('not installed or too old: no login is started', async () => {
    const missing = world({ cli: null })
    assert.equal((await missing.service.start(ROOT)).outcome, 'not-installed')
    const old = world({ version: '2.1.200 (Claude Code)' })
    assert.equal((await old.service.start(ROOT)).outcome, 'outdated')
    assert.equal(missing.spawned.length + old.spawned.length, 0)
  })

  it('opens again only the Anthropic page the CLI printed', async () => {
    const { service, nextLogin, opened } = world()
    assert.equal(await service.openPage(), false)
    const pending = service.start(ROOT)
    const login = await nextLogin()
    // The address arrives in two chunks: the first half is never taken for the page.
    const cut = PAGE.indexOf('?')
    ;(login.stdout as EventEmitter).emit('data', Buffer.from(`Opening browser to sign in…\nIf the browser didn't open, visit: ${PAGE.slice(0, cut)}`))
    assert.equal(await service.openPage(), false)
    ;(login.stdout as EventEmitter).emit('data', Buffer.from(`${PAGE.slice(cut)}\n`))
    assert.equal(await service.openPage(), true)
    assert.deepEqual(opened, [PAGE])
    service.cancel()
    await pending
  })

  it('finds the page address printed on stderr too', async () => {
    const { service, nextLogin, opened } = world()
    const pending = service.start(ROOT)
    const login = await nextLogin()
    ;(login.stderr as EventEmitter).emit('data', Buffer.from(`visit: ${PAGE}\n`))
    assert.equal(await service.openPage(), true)
    assert.deepEqual(opened, [PAGE])
    service.cancel()
    await pending
  })
})

describe('the chat\'s gate', () => {
  const installed: ClaudeCodeStatus = { available: true, authenticated: true, cliPath: '/x/claude', version: 'installed', error: null, checkedAt: 0 }
  it('stops the chat only for the CLI\'s plain signed-out; unknown and unsupported open it as before', () => {
    const ready = (signIn: { state: 'signed-in' | 'signed-out' | 'unknown' }, signInSupported: boolean) => claudeCodeReady(withSignIn(installed, { signIn, signInSupported }))
    assert.equal(ready({ state: 'signed-in' }, true), true)
    assert.equal(ready({ state: 'unknown' }, true), true)
    assert.equal(ready({ state: 'unknown' }, false), true)
    assert.equal(ready({ state: 'signed-out' }, true), false)
    assert.equal(claudeCodeReady(withSignIn({ ...installed, available: false }, { signIn: { state: 'signed-in' }, signInSupported: true })), false)
  })
})

// 「Claude にログインする」 (services/claude-sign-in.ts, shared/claude-sign-in.ts):
// the app starts the official CLI's own sign-in and asks its status, never
// blocks a member it cannot judge, and always ends a sign-in in a clear state.
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claudeAccountNotice, claudeSignInSupported, readClaudeAuthStatus, signInPageUrl } from '../shared/claude-sign-in'
import { createClaudeSignIn, type ClaudeSignInDeps, type SignInChild } from '../electron/services/claude-sign-in'

const SIGNED_IN_TEAM = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgName: 'Example', subscriptionType: 'team' })
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
const PAGE = 'https://claude.com/cai/oauth/authorize?code=true&state=abc'

class FakeChild extends EventEmitter implements SignInChild {
  stdout = new EventEmitter() as SignInChild['stdout'] & EventEmitter
  stdin = { end: () => undefined }
  killed: NodeJS.Signals | undefined
  /** A CLI stuck somewhere that does not end on SIGTERM. */
  stubborn = false
  constructor(readonly args: string[]) { super() }
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
function world(options: { statuses?: string[]; version?: string; cli?: string | null; loginTimeoutMs?: number; stubborn?: boolean } = {}) {
  const statuses = [...(options.statuses ?? [SIGNED_OUT])]
  const spawned: FakeChild[] = []
  const opened: string[] = []
  const deps: ClaudeSignInDeps = {
    cliPath: () => (options.cli === undefined ? '/Users/me/.local/bin/claude' : options.cli),
    env: () => ({ PATH: '/usr/bin' }),
    readVersion: async () => options.version ?? '2.1.328 (Claude Code)',
    spawn: (_cli, args) => {
      const child = new FakeChild(args)
      child.stubborn = !!options.stubborn
      spawned.push(child)
      if (args[1] === 'status') {
        const out = statuses.length > 1 ? statuses.shift()! : statuses[0]
        child.answer(out, out.includes('"loggedIn":false') ? 1 : 0)
      }
      return child
    },
    openExternal: async url => { opened.push(url) },
    loginTimeoutMs: options.loginTimeoutMs,
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
    assert.deepEqual(await service.check(), { signIn: { state: 'unknown' }, signInSupported: false })
    assert.equal(spawned.length, 0)
  })

  it('several windows asking at once share one auth status', async () => {
    const { service, spawned } = world({ statuses: [SIGNED_IN_TEAM] })
    const answers = await Promise.all([service.check(), service.check(), service.check()])
    assert.equal(spawned.length, 1)
    assert.ok(answers.every(a => a.signIn.state === 'signed-in'))
  })
})

describe('signing in', () => {
  it('already signed in (terminal or desktop app): changes nothing, starts no login', async () => {
    const { service, logins } = world({ statuses: [SIGNED_IN_TEAM] })
    const result = await service.start()
    assert.equal(result.outcome, 'signed-in')
    assert.equal(logins().length, 0)
  })

  it('a finished login counts only once the CLI reports it signed in', async () => {
    const ok = world({ statuses: [SIGNED_OUT, SIGNED_IN_TEAM] })
    const pending = ok.service.start()
    ;(await ok.nextLogin()).answer('Login successful.\n', 0)
    assert.equal((await pending).outcome, 'signed-in')

    const notReally = world({ statuses: [SIGNED_OUT, SIGNED_OUT] })
    const second = notReally.service.start()
    ;(await notReally.nextLogin()).answer('', 0)
    assert.equal((await second).outcome, 'still-signed-out')
  })

  it('two windows or two companies pressing at once share one login', async () => {
    const { service, nextLogin, logins } = world()
    const a = service.start()
    const b = service.start()
    await nextLogin()
    await new Promise(r => setTimeout(r, 10))
    assert.equal(logins().length, 1)
    service.cancel()
    assert.deepEqual(await a, await b)
  })

  it('やめる stops the CLI and ends cancelled; the next press starts again', async () => {
    const { service, nextLogin, logins } = world()
    const pending = service.start()
    const login = await nextLogin()
    assert.equal(service.cancel(), true)
    assert.equal(login.killed, 'SIGTERM')
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal(service.cancel(), false)
    const again = service.start()
    await new Promise(r => setTimeout(r, 5))
    assert.equal(logins().length, 2)
    service.cancel()
    await again
  })

  it('a browser that never comes back is stopped after the time limit', async () => {
    const { service, nextLogin } = world({ loginTimeoutMs: 20 })
    const pending = service.start()
    const login = await nextLogin()
    const result = await pending
    assert.equal(login.killed, 'SIGTERM')
    assert.equal(result.outcome, 'timed-out')
    assert.match(result.message, /インターネット/)
  })

  it('a CLI that ignores やめる is killed, and the sign-in still ends', async () => {
    const { service, nextLogin } = world({ stubborn: true })
    const pending = service.start()
    const login = await nextLogin()
    service.cancel()
    assert.equal((await pending).outcome, 'cancelled')
    assert.equal(login.killed, 'SIGKILL')
  })

  it('a failed login (offline, refused) ends failed with a plain message', async () => {
    const { service, nextLogin } = world()
    const pending = service.start()
    ;(await nextLogin()).answer('', 1)
    const result = await pending
    assert.equal(result.outcome, 'failed')
    assert.doesNotMatch(result.message, /claude auth|terminal|ターミナル/)
  })

  it('quitting the app stops a sign-in left running', async () => {
    const { service, nextLogin } = world()
    const pending = service.start()
    const login = await nextLogin()
    service.stop()
    assert.equal(login.killed, 'SIGTERM')
    assert.equal((await pending).outcome, 'cancelled')
  })

  it('not installed or too old: no login is started', async () => {
    const missing = world({ cli: null })
    assert.equal((await missing.service.start()).outcome, 'not-installed')
    const old = world({ version: '2.1.200 (Claude Code)' })
    assert.equal((await old.service.start()).outcome, 'outdated')
    assert.equal(missing.spawned.length + old.spawned.length, 0)
  })

  it('opens again only the Anthropic page the CLI printed', async () => {
    const { service, nextLogin, opened } = world()
    assert.equal(await service.openPage(), false)
    const pending = service.start()
    const login = await nextLogin()
    ;(login.stdout as EventEmitter).emit('data', Buffer.from(`Opening browser to sign in…\nIf the browser didn't open, visit: ${PAGE}\n`))
    assert.equal(await service.openPage(), true)
    assert.deepEqual(opened, [PAGE])
    service.cancel()
    await pending
  })
})

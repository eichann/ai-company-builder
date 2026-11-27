/**
 * A site's login kept on this PC (agent-browser.md "Keeping a login on disk"). What is protected:
 * - a login is kept only for a member whose sandbox is 囲う and whose own level on the site is not 使わない, on a
 *   platform where the sandbox runs; everyone else keeps today's memory-only login;
 * - no AI turn without the sandbox runs while a kept login is on disk: every kept login on this PC goes first (the
 *   disk is read, so an earlier run's or a crash's leftovers go too), the run keeps nothing more, and a turn whose
 *   removal failed does not start — also for the agents' record-only re-run;
 * - the right logins go when the sandbox leaves 囲う, the level drops to 使わない, the site or the mode goes, the server
 *   refuses the policy, the member signs out or another account signs in — and only those: two members or two
 *   companies never share or remove each other's;
 * - where it lives: under the app's data folder, which every enclosed turn is denied, never in a company folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserSiteSetting } from '../../shared/core/browser-operation'
import type { AgentPolicy, BrowserSiteLevel } from '../../shared/types/agent-sandbox'
import { browserLoginStorage } from '../../shared/core/browser-operation'
import { browserReadPartition, browserWritePartition } from '../shared/browser-operation'
import { managedSettingsTouchSandbox, resolveSandbox, sandboxKeepsPlaceUnread, type ResolvedSandbox } from '../shared/agents/sandbox-policy'
import { claudeManagedSandboxPresent } from '../electron/agents/claude-managed-settings'
import { createClaudeConnection } from '../electron/agents/claude'
import { createBrowserController, type BrowserShell, type BrowserWindowSpec } from '../electron/features/browser/controller'
import {
  createKeptLogins, keptFolderIn, keptLoginFolder, turnEnclosesKeptLogins, type AiTurnFacts,
} from '../electron/features/browser/kept-logins'
import { removeLeftoverBrowserPartitions } from '../electron/features/browser/leftovers'
import { createAgentPolicyStore, parseBrowserLevels } from '../electron/services/agent-policy-store'

const SITE: BrowserSiteSetting = { host: 'manager.example.net', level: 'write', assetHosts: [] }
const OTHER: BrowserSiteSetting = { host: 'desk.example.net', level: 'read', assetHosts: [] }
/** Removals run on the disk (fs.promises) after the call: give them real time. */
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 2)) }

function policy(mode: 'enforce' | 'observe' | 'off', sites: BrowserSiteSetting[] = [SITE], levels: BrowserSiteLevel[] | null = sites.map(s => ({ host: s.host, level: 'read' })), browserMode: 'on' | 'off' = 'on'): AgentPolicy {
  return {
    version: 'v',
    sandbox: { mode, allowedDomains: [], deniedReadPaths: [], onUnavailable: 'record-only', source: 'company' },
    browser: { mode: browserMode, sites, source: 'company' },
    ...(levels ? { browserLevels: levels } : {}),
  }
}

function world(options: { platformEncloses?: boolean; partitionsDir?: string; insideCompanyFolder?: (p: string) => boolean; before?: (userData: string) => void } = {}) {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-')))
  const partitions = options.partitionsDir ?? path.join(userData, 'Partitions')
  fs.mkdirSync(path.join(userData, 'Partitions'), { recursive: true })
  options.before?.(userData)
  const opened: Array<BrowserWindowSpec & { closed: boolean; close: () => void }> = []
  const cleared: string[] = []
  const shell: BrowserShell = {
    open(spec) {
      const entry = { ...spec, closed: false, close() { entry.closed = true; spec.onClosed() } }
      opened.push(entry)
      // What Chromium does for a `persist:` partition: its folder under Partitions.
      if (spec.partition.startsWith('persist:')) {
        const dir = path.join(userData, 'Partitions', spec.partition.slice('persist:'.length), 'Network')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'Cookies'), 'sid=secret')
      }
      return { focus() {}, close: () => entry.close(), updateSite() {} }
    },
    async clearPartition(partition) { cleared.push(partition) },
  }
  const kept = createKeptLogins({ partitionsDir: () => partitions, clearSession: p => shell.clearPartition(p), platformEncloses: options.platformEncloses ?? true, insideCompanyFolder: options.insideCompanyFolder, log: { warn() {} } })
  let user: string | null = 'user-1'
  const changed: string[] = []
  const browser = createBrowserController({
    shell, kept, userId: () => user, log: { warn() {} }, onChanged: c => changed.push(c),
    turnEnclosesKept: turn => turnEnclosesKeptLogins(path.join(userData, 'Partitions'), turn),
  })
  const onDisk = () => fs.readdirSync(path.join(userData, 'Partitions')).sort()
  return { userData, browser, opened, cleared, changed, onDisk, setUser: (u: string | null) => { user = u } }
}

const HOME = '/Users/member'
const resolvedFor = (userData: string, companyRoot = `${HOME}/AI Company Builder/acme`): ResolvedSandbox =>
  resolveSandbox({ allowedDomains: [], deniedReadPaths: [] }, { home: HOME, companyRoot, appDataDirs: [userData] })
const enclosed = (userData: string): AiTurnFacts => ({ sandbox: { mode: 'enforce', resolved: resolvedFor(userData) }, companyRoot: `${HOME}/AI Company Builder/acme`, workingDirectory: `${HOME}/AI Company Builder/acme` })

// ---------------------------------------------------------------------------
// The rule and the place
// ---------------------------------------------------------------------------

test('the company\'s half: on disk only for 囲う and a level that may use the site; unknown is memory', () => {
  assert.equal(browserLoginStorage('enforce', 'read'), 'disk')
  assert.equal(browserLoginStorage('enforce', 'write'), 'disk')
  assert.equal(browserLoginStorage('enforce', 'none'), 'memory')
  assert.equal(browserLoginStorage('enforce', undefined), 'memory', 'an older server that does not say')
  assert.equal(browserLoginStorage('observe', 'write'), 'memory')
  assert.equal(browserLoginStorage('off', 'write'), 'memory')
})

test('the place: denied to both agents under 囲う, never in or around a company folder', () => {
  const userData = `${HOME}/Library/Application Support/ai-company-builder`
  const place = `${userData}/Partitions`
  assert.equal(sandboxKeepsPlaceUnread(resolvedFor(userData), place, `${HOME}/AI Company Builder/acme`), true)
  // A root re-allowed inside the denied place: Claude reads what allowRead names, Codex leaves that denied place out.
  const reopened: ResolvedSandbox = { allowedDomains: [], denyRead: [userData], allowRead: [`${userData}/acme`], allowWrite: [] }
  assert.equal(sandboxKeepsPlaceUnread(reopened, place, `${userData}/acme`), false)
  assert.equal(sandboxKeepsPlaceUnread({ ...reopened, allowRead: [place] }, place, undefined), false)
  assert.equal(sandboxKeepsPlaceUnread({ ...reopened, allowRead: [`${HOME}/Library`] }, place, undefined), false, 'Claude: an allowed root around it wins')
  assert.equal(sandboxKeepsPlaceUnread({ ...reopened, allowRead: [] }, place, undefined), true)
  assert.equal(sandboxKeepsPlaceUnread({ ...reopened, allowRead: [], allowWrite: [userData] }, place, undefined), false)
  // The kept logins inside the company folder (a company folder around the app's data).
  assert.equal(sandboxKeepsPlaceUnread(resolvedFor(userData, HOME), place, HOME), false)
  // A place no denied place covers.
  assert.equal(sandboxKeepsPlaceUnread(resolvedFor(userData), `${HOME}/elsewhere/Partitions`, `${HOME}/AI Company Builder/acme`), false)
  // The turn: only enforce counts.
  assert.equal(turnEnclosesKeptLogins(place, { sandbox: { mode: 'enforce', resolved: resolvedFor(userData) }, companyRoot: `${HOME}/AI Company Builder/acme`, workingDirectory: `${HOME}/AI Company Builder/acme` }), true)
  const enforced = { sandbox: { mode: 'enforce' as const, resolved: resolvedFor(userData) }, companyRoot: `${HOME}/AI Company Builder/acme` }
  assert.equal(turnEnclosesKeptLogins(place, enforced), false, 'no working folder (Codex then runs its legacy read-only mode)')
  assert.equal(turnEnclosesKeptLogins(place, { ...enforced, workingDirectory: enforced.companyRoot, sandboxMayBeOff: true }), false, 'a managed setting may switch it off')
  assert.equal(turnEnclosesKeptLogins(place, { sandbox: { mode: 'observe', resolved: resolvedFor(userData) } }), false)
  assert.equal(turnEnclosesKeptLogins(place, {}), false, 'no sandbox at all (the API key\'s tools, no policy)')
})

test('one folder per account × company × site; a removal names exactly whose', () => {
  const a = keptLoginFolder('u1', 'c1', 'x.example.net')
  assert.notEqual(a, keptLoginFolder('u2', 'c1', 'x.example.net'))
  assert.notEqual(a, keptLoginFolder('u1', 'c2', 'x.example.net'))
  assert.notEqual(a, keptLoginFolder('u1', 'c1', 'y.example.net'))
  assert.equal(keptFolderIn(a, { userId: 'u1', companyId: 'c1', host: 'x.example.net' }), true)
  assert.equal(keptFolderIn(a, { userId: 'u1', companyId: 'c2' }), false)
  assert.equal(keptFolderIn(a, { userId: 'u2' }), false)
  assert.equal(keptFolderIn(a, { otherThan: 'u1' }), false)
  assert.equal(keptFolderIn(a, { otherThan: 'u2' }), true)
  assert.equal(keptFolderIn(a, { userId: 'u1', companyId: 'c1', exceptHosts: ['x.example.net'] }), false)
  assert.equal(keptFolderIn(a, { userId: 'u1', companyId: 'c1', exceptHosts: ['y.example.net'] }), true)
  assert.equal(keptFolderIn(a.toUpperCase(), { all: true }), false, 'only exact names are kept logins')
})

test('a window kept on disk reads and writes through sessions in memory only', () => {
  const kept = `persist:${keptLoginFolder('u', 'c', 'x.example.net')}`
  assert.doesNotMatch(browserReadPartition(kept), /^persist:/)
  assert.doesNotMatch(browserWritePartition(kept), /^persist:/)
})

test('at start a kept login stays (the policy decides); any other browser folder still goes', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-start-'))
  const partitions = path.join(userData, 'Partitions')
  const name = keptLoginFolder('u', 'c', 'x.example.net')
  for (const folder of [name, name.toUpperCase(), 'acb-browser-0123456789abcdef0123456789abcdef', `${name}-x`]) fs.mkdirSync(path.join(partitions, folder), { recursive: true })
  removeLeftoverBrowserPartitions(userData, { warn() {} })
  assert.deepEqual(fs.readdirSync(partitions), [name])
})

// ---------------------------------------------------------------------------
// Keeping, and taking away
// ---------------------------------------------------------------------------

test('kept for 囲う with a level; memory for everyone else, as before', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host, kept: true }] })
  w.browser.open('c1', SITE.host)
  assert.match(w.opened[0].partition, /^persist:acb-browser-keep-/)

  for (const [label, p] of [
    ['observe', policy('observe')], ['off', policy('off')], ['使わない', policy('enforce', [SITE], [{ host: SITE.host, level: 'none' }])],
    ['an older server (no levels)', policy('enforce', [SITE], null)],
  ] as const) {
    const m = world()
    m.browser.policyAnswered('c1', p)
    // Settings says the sandbox is why when it is (agent-browser.md "The window a run needs").
    const bySandbox = label === 'observe' || label === 'off'
    assert.deepEqual(m.browser.sites('c1'), { sites: [{ host: SITE.host, ...(bySandbox ? { notKeptBySandbox: true } : {}) }] }, label)
    m.browser.open('c1', SITE.host)
    assert.doesNotMatch(m.opened[0].partition, /^persist:/, label)
  }
  const windows = world({ platformEncloses: false })
  windows.browser.policyAnswered('c1', policy('enforce'))
  windows.browser.open('c1', SITE.host)
  assert.doesNotMatch(windows.opened[0].partition, /^persist:/, 'a platform where the sandbox never runs')
})

test('the sandbox leaving 囲う, 使わない, the site or the mode gone: that kept login goes from the disk, its window closes', async () => {
  for (const [label, next] of [
    ['observe', policy('observe', [SITE, OTHER])],
    ['使わない', policy('enforce', [SITE, OTHER], [{ host: SITE.host, level: 'none' }, { host: OTHER.host, level: 'read' }])],
    ['site removed', policy('enforce', [OTHER])],
    ['mode off', policy('enforce', [SITE, OTHER], null, 'off')],
  ] as const) {
    const w = world()
    w.browser.policyAnswered('c1', policy('enforce', [SITE, OTHER]))
    w.browser.open('c1', SITE.host)
    w.browser.open('c1', OTHER.host)
    assert.equal(w.onDisk().length, 2, label)
    w.browser.policyAnswered('c1', next)
    await settle()
    assert.equal(w.opened[0].closed, true, label)
    assert.ok(!w.onDisk().includes(keptLoginFolder('user-1', 'c1', SITE.host)), label)
    if (label === 'observe' || label === 'mode off') assert.deepEqual(w.onDisk(), [], label)
    else assert.deepEqual(w.onDisk(), [keptLoginFolder('user-1', 'c1', OTHER.host)], `${label}: the other site stays`)
  }
})

test('the server refusing the policy removes that company\'s kept logins; offline keeps them', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.policyAnswered('c2', policy('enforce'))
  w.browser.open('c1', SITE.host)
  w.browser.open('c2', SITE.host)
  w.browser.policyFailed('c1')
  await settle()
  assert.equal(w.onDisk().length, 2, 'no server: not a reason to forget')
  w.browser.policyFailed('c1', { refused: true })
  await settle()
  assert.deepEqual(w.onDisk(), [keptLoginFolder('user-1', 'c2', SITE.host)], 'only that company\'s')
})

test('two companies and two members never share a kept login; signing out removes all, another account the others\'', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.policyAnswered('c2', policy('enforce'))
  w.browser.open('c1', SITE.host)
  w.browser.open('c2', SITE.host)
  assert.notEqual(w.opened[0].partition, w.opened[1].partition)
  w.browser.policyAnswered('c1', policy('observe'))
  await settle()
  assert.deepEqual(w.onDisk(), [keptLoginFolder('user-1', 'c2', SITE.host)], 'another company\'s change leaves this one')

  w.setUser('user-2')
  w.browser.signedIn('user-2')
  w.browser.policyAnswered('c2', policy('enforce'))
  w.browser.open('c2', SITE.host)
  await settle()
  assert.deepEqual(w.onDisk(), [keptLoginFolder('user-2', 'c2', SITE.host)], 'another account: the first one\'s go')
  w.browser.signedIn('user-2')
  await settle()
  assert.deepEqual(w.onDisk(), [keptLoginFolder('user-2', 'c2', SITE.host)], 'the same account keeps its own')
  w.browser.signedOut()
  await settle()
  assert.deepEqual(w.onDisk(), [])
})

test('「ログインを消す」 removes the kept login too', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.open('c1', SITE.host)
  w.changed.length = 0
  assert.deepEqual(await w.browser.clearLogin('c1', SITE.host), { ok: true })
  assert.deepEqual(w.onDisk(), [])
  // Its partition is not used again in this run, and Settings never promises a kept login it will not keep.
  assert.ok(w.changed.includes('c1'))
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host }] })
  w.browser.open('c1', SITE.host)
  assert.doesNotMatch(w.opened[1].partition, /^persist:/)
})

test('a window already open in memory when the site becomes kept: Settings does not say kept until it closes', () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('observe'))
  w.browser.open('c1', SITE.host)
  w.browser.policyAnswered('c1', policy('enforce'))
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host }] })
  w.opened[0].onClosed()
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host, kept: true }] })
})

// ---------------------------------------------------------------------------
// Every AI turn
// ---------------------------------------------------------------------------

test('an enclosed turn leaves the kept logins; any other removes every one on this PC first and the run keeps nothing more', async () => {
  const w = world()
  // An earlier run's (or a crash's) kept login of another account and company, found on the disk.
  fs.mkdirSync(path.join(w.userData, 'Partitions', keptLoginFolder('someone', 'cx', 'x.example.net')))
  w.browser.policyAnswered('c1', policy('enforce', [SITE, OTHER]))
  w.browser.open('c1', SITE.host)
  assert.equal(await w.browser.beforeAiTurn(enclosed(w.userData)), true)
  assert.equal(w.onDisk().length, 2, 'an enclosed turn removes nothing')

  const asked = w.browser.beforeAiTurn({ companyRoot: `${HOME}/AI Company Builder/acme` })
  // Stopped before anything is awaited: the window is closed, and windows opened now live in memory (also a site
  // whose kept login this run never loaded).
  assert.equal(w.opened[0].closed, true)
  w.browser.open('c1', SITE.host)
  w.browser.open('c1', OTHER.host)
  assert.doesNotMatch(w.opened[1].partition, /^persist:/)
  assert.doesNotMatch(w.opened[2].partition, /^persist:/)
  assert.equal(await asked, true)
  assert.deepEqual(w.onDisk(), [], 'every account\'s and company\'s')
  assert.ok(w.cleared.includes(w.opened[0].partition), 'the loaded session cleared too')
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host }, { host: OTHER.host }] }, 'not kept for the rest of this run')
  assert.ok(w.changed.includes('c1'), 'the settings are told')

  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.signedIn('user-1')
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host }] }, 'a new answer does not bring keeping back in this run')
})

test('a run reopens the window of a login kept on this PC (also one an earlier run left), never one the app removed — and says why', async () => {
  const signal = new AbortController().signal
  // An earlier run's kept login, on disk: the run opens its window in that same kept session.
  const w = world({ before: u => fs.mkdirSync(path.join(u, 'Partitions', keptLoginFolder('user-1', 'c1', SITE.host))) })
  w.browser.policyAnswered('c1', policy('enforce', [SITE, OTHER]))
  assert.deepEqual(await w.browser.windowForRun('c1', SITE.host, signal), { kind: 'opened' })
  assert.equal(w.opened[0].partition, `persist:${keptLoginFolder('user-1', 'c1', SITE.host)}`)
  assert.deepEqual(await w.browser.windowForRun('c1', OTHER.host, signal), { kind: 'none', loginRemoved: false }, 'nothing kept for that site')
  // A turn without the sandbox removes it: no window opens again, and the run says why.
  assert.equal(await w.browser.beforeAiTurn({}), true)
  assert.deepEqual(await w.browser.windowForRun('c1', SITE.host, signal), { kind: 'none', loginRemoved: true })
  assert.equal(w.opened.length, 1)
  // The member opens it again: the reason is gone with it.
  w.browser.open('c1', SITE.host)
  w.opened[1].close()
  assert.deepEqual(await w.browser.windowForRun('c1', SITE.host, signal), { kind: 'opened' }, 'its memory login now')
  w.browser.policyAnswered('c1', policy('enforce', [OTHER]))
  w.browser.policyAnswered('c1', policy('enforce', [SITE, OTHER]))
  assert.deepEqual(await w.browser.windowForRun('c1', SITE.host, signal), { kind: 'none', loginRemoved: false }, 'that reason is not said again once the member opened it')

  // A memory login made while the sandbox was 記録だけ still counts once keeping is allowed (it then opens kept).
  const upgraded = world()
  upgraded.browser.policyAnswered('c1', policy('observe'))
  upgraded.browser.open('c1', SITE.host)
  upgraded.opened[0].close()
  upgraded.browser.policyAnswered('c1', policy('enforce'))
  assert.deepEqual(await upgraded.browser.windowForRun('c1', SITE.host, signal), { kind: 'opened' })

  // The sandbox loosened while the server could not be reached: the next answer still says why.
  const outage = world()
  outage.browser.policyAnswered('c1', policy('enforce'))
  outage.browser.open('c1', SITE.host)
  outage.browser.policyFailed('c1')
  outage.browser.policyAnswered('c1', policy('observe'))
  await settle()
  assert.deepEqual(await outage.browser.windowForRun('c1', SITE.host, signal), { kind: 'none', loginRemoved: true }, 'told after an outage too')

  const changed = world()
  changed.browser.policyAnswered('c1', policy('enforce'))
  changed.browser.open('c1', SITE.host)
  changed.browser.policyAnswered('c1', policy('observe'))
  await settle()
  assert.deepEqual(await changed.browser.windowForRun('c1', SITE.host, signal), { kind: 'none', loginRemoved: true }, 'the sandbox is no longer 囲う')
})

test('observe, no sandbox and an enforce turn whose company folder holds the app\'s data are not enclosed', async () => {
  for (const turn of [
    (u: string): AiTurnFacts => ({ sandbox: { mode: 'observe', resolved: resolvedFor(u) } }),
    (): AiTurnFacts => ({}),
    (u: string): AiTurnFacts => ({ sandbox: { mode: 'enforce', resolved: resolvedFor(u, path.dirname(u)) }, companyRoot: path.dirname(u) }),
  ]) {
    const w = world()
    w.browser.policyAnswered('c1', policy('enforce'))
    w.browser.open('c1', SITE.host)
    assert.equal(await w.browser.beforeAiTurn(turn(w.userData)), true)
    assert.deepEqual(w.onDisk(), [])
  }
})

test('a kept login that cannot be removed stops the turn (it never runs next to it)', async () => {
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-blocked-'))
  const notAFolder = path.join(blocked, 'Partitions')
  fs.writeFileSync(notAFolder, 'x')
  const w = world({ partitionsDir: notAFolder })
  w.browser.policyAnswered('c1', policy('enforce'))
  assert.equal(await w.browser.beforeAiTurn({}), false)
})

// ---------------------------------------------------------------------------
// The chat server asks before every turn's agent starts
// ---------------------------------------------------------------------------

test('the chat server asks before the agent starts, with no sandbox for the API key, and refuses the turn when told no', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  const facts: AiTurnFacts[] = []
  let keyReads = 0
  let keyReadsAtGate = -1
  const server = await startChatServer({
    getAuthMode: () => 'api-key', getApiKey: () => { keyReads++; return 'k' }, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    beforeAiTurn: async turn => { facts.push(turn); keyReadsAtGate = keyReads; return false },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', appSessionId: 'conv', companyRootPath: '/tmp/acme' }),
    })
    assert.equal(res.status, 503)
    assert.match((await res.json() as { error: string }).error, /ログインを消せなかった/)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].sandbox, undefined, 'the API key\'s tools run without the sandbox')
    assert.equal(facts[0].companyRoot, '/tmp/acme')
    assert.equal(keyReads, keyReadsAtGate, 'no model was made after the refusal')
    assert.equal(server.turns.runningCount(), 0)
  } finally {
    server.server.close()
  }
})

// ---------------------------------------------------------------------------
// The levels in the policy
// ---------------------------------------------------------------------------

test('the policy\'s levels: only the listed sites, a known level; a site named twice counts for none', () => {
  const hosts = [SITE.host, OTHER.host]
  assert.deepEqual(parseBrowserLevels([{ host: SITE.host, level: 'write' }, { host: 'evil.example.org', level: 'write' }, { host: OTHER.host, level: 'admin' }], hosts), [{ host: SITE.host, level: 'write' }])
  assert.deepEqual(parseBrowserLevels([{ host: SITE.host, level: 'read' }, { host: SITE.host, level: 'none' }], hosts), [])
  assert.deepEqual(parseBrowserLevels([{ host: SITE.host, level: 'read', extra: 1 }], hosts), [])
  assert.deepEqual(parseBrowserLevels(undefined, hosts), [])
})

test('the store says a refused policy (401 / 403 / 404) apart from no server or an error', async () => {
  let status = 403
  const store = createAgentPolicyStore({
    baseUrl: () => 'https://acb.example.com', cookies: () => [], log: { warn() {} },
    fetch: (async () => { if (status === 0) throw new Error('offline'); return new Response('{}', { status }) }) as typeof fetch,
  })
  const seen: boolean[] = []
  store.onRefreshFailed((_c, detail) => seen.push(detail.refused))
  for (const s of [403, 401, 404, 500, 0]) { status = s; await store.refresh('c1') }
  assert.deepEqual(seen, [true, true, true, false, false])
})

// ---------------------------------------------------------------------------
// The place, as Chromium will write it (it follows links)
// ---------------------------------------------------------------------------

test('a link planted in place of the sessions\' folder: the link goes, its target stays, nothing is kept this run', () => {
  const company = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-company-')))
  fs.writeFileSync(path.join(company, 'memo.md'), 'x')
  const w = world({ before: userData => {
    fs.rmSync(path.join(userData, 'Partitions'), { recursive: true })
    fs.symlinkSync(company, path.join(userData, 'Partitions'))
  } })
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.open('c1', SITE.host)
  assert.doesNotMatch(w.opened[0].partition, /^persist:/, 'memory, never a cookie written through the link')
  assert.equal(fs.existsSync(path.join(w.userData, 'Partitions')), false, 'the link itself is gone')
  assert.ok(fs.existsSync(path.join(company, 'memo.md')), 'what it pointed to is untouched')
  assert.deepEqual(fs.readdirSync(company), ['memo.md'], 'nothing was written into the company folder')
  assert.deepEqual(w.browser.sites('c1'), { sites: [{ host: SITE.host }] }, 'nothing kept this run')
})

test('a link or a shared file planted inside a kept login\'s folder: the folder goes, nothing is kept this run', () => {
  const company = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-company-')))
  for (const plant of [
    (folder: string) => fs.symlinkSync(company, path.join(folder, 'Network')),
    (folder: string) => { fs.writeFileSync(path.join(company, 'Cookies'), ''); fs.linkSync(path.join(company, 'Cookies'), path.join(folder, 'Cookies')) },
  ]) {
    const name = keptLoginFolder('user-1', 'c1', SITE.host)
    const w = world({ before: userData => { const folder = path.join(userData, 'Partitions', name); fs.mkdirSync(folder); plant(folder) } })
    w.browser.policyAnswered('c1', policy('enforce'))
    w.browser.open('c1', SITE.host)
    assert.doesNotMatch(w.opened[0].partition, /^persist:/)
    assert.ok(!w.onDisk().includes(name), 'the planted folder is removed')
    assert.ok(fs.existsSync(company), 'never followed')
  }
})

test('a link above the sessions\' folder (where it really is differs) is never used', () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-real-')))
  fs.mkdirSync(path.join(real, 'Partitions'))
  const link = `${real}-link`
  fs.symlinkSync(real, link)
  const kept = createKeptLogins({ partitionsDir: () => path.join(link, 'Partitions'), clearSession: async () => {}, platformEncloses: true, log: { warn() {} } })
  assert.equal(kept.partition('u', 'c', SITE.host), null)
  const direct = createKeptLogins({ partitionsDir: () => path.join(real, 'Partitions'), clearSession: async () => {}, platformEncloses: true, log: { warn() {} } })
  assert.match(direct.partition('u', 'c', SITE.host) ?? '', /^persist:/, 'the same folder by its real path is used')
})

test('a removal never follows a link planted in place of the sessions\' folder', async () => {
  const company = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-kept-company-')))
  const lookalike = keptLoginFolder('someone', 'cx', 'x.example.net')
  fs.mkdirSync(path.join(company, lookalike))
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.open('c1', SITE.host)
  fs.renameSync(path.join(w.userData, 'Partitions'), path.join(w.userData, 'Moved'))
  fs.symlinkSync(company, path.join(w.userData, 'Partitions'))
  assert.equal(await w.browser.beforeAiTurn({}), true)
  assert.ok(fs.existsSync(path.join(company, lookalike)), 'nothing in the company folder is removed')
  assert.equal(fs.existsSync(path.join(w.userData, 'Partitions')), false, 'the link itself is gone')
})

test('a kept login an earlier run left is found at start and removed before an unenclosed turn', async () => {
  const name = keptLoginFolder('someone', 'cx', 'x.example.net')
  const w = world({ before: userData => fs.mkdirSync(path.join(userData, 'Partitions', name)) })
  assert.equal(await w.browser.beforeAiTurn({}), true)
  assert.deepEqual(w.onDisk(), [])
})

test('a sessions\' folder inside a company folder (by name or where it really is) is never used', () => {
  const w = world({ insideCompanyFolder: () => true })
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.open('c1', SITE.host)
  assert.doesNotMatch(w.opened[0].partition, /^persist:/)
  assert.deepEqual(w.onDisk(), [])
})

test('an earlier kept login of this account is reused when its folder is plain', () => {
  const name = keptLoginFolder('user-1', 'c1', SITE.host)
  const w = world({ before: userData => { fs.mkdirSync(path.join(userData, 'Partitions', name, 'Network'), { recursive: true }); fs.writeFileSync(path.join(userData, 'Partitions', name, 'Network', 'Cookies'), 'x') } })
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.open('c1', SITE.host)
  assert.equal(w.opened[0].partition, `persist:${name}`)
})

// ---------------------------------------------------------------------------
// What a failure or a PC that never kept anything does
// ---------------------------------------------------------------------------

test('a PC that never kept a login reads no disk before an unenclosed turn (no turn refused over it)', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('observe'))
  // The disk would refuse every read now: nothing was found at start and nothing was kept since, so it is not read.
  fs.rmSync(path.join(w.userData, 'Partitions'), { recursive: true })
  fs.writeFileSync(path.join(w.userData, 'Partitions'), 'x')
  assert.equal(await w.browser.beforeAiTurn({}), true)
})

test('a removal that leaves something on disk stops keeping for the rest of the run', async () => {
  const w = world()
  w.browser.policyAnswered('c1', policy('enforce'))
  w.browser.policyAnswered('c2', policy('enforce'))
  w.browser.open('c1', SITE.host)
  fs.renameSync(path.join(w.userData, 'Partitions'), path.join(w.userData, 'Moved'))
  fs.writeFileSync(path.join(w.userData, 'Partitions'), 'x')
  w.browser.policyFailed('c1', { refused: true })
  await settle()
  assert.deepEqual(w.browser.sites('c2'), { sites: [{ host: SITE.host }] }, 'another company\'s site is not kept either')
})

// ---------------------------------------------------------------------------
// Claude Code's managed settings may switch its sandbox off
// ---------------------------------------------------------------------------

test('a managed `sandbox` (or a managed file that cannot be read) counts as "may be off"', () => {
  assert.equal(managedSettingsTouchSandbox({ kind: 'json', text: '{"permissions":{"deny":["Read(~/.ssh/**)"]}}' }), false)
  assert.equal(managedSettingsTouchSandbox({ kind: 'json', text: '{"sandbox":{"enabledPlatforms":["linux"]}}' }), true)
  assert.equal(managedSettingsTouchSandbox({ kind: 'json', text: '{"Sandbox":{}}' }), true)
  assert.equal(managedSettingsTouchSandbox({ kind: 'json', text: 'not json' }), true)
  assert.equal(managedSettingsTouchSandbox({ kind: 'plist', text: '<key>sandbox</key>' }), true)
  assert.equal(managedSettingsTouchSandbox({ kind: 'plist', text: '<key>permissions</key>' }), false)

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-managed-')))
  const file = path.join(dir, 'managed-settings.json')
  const folder = path.join(dir, 'managed-settings.d')
  const sources = [{ kind: 'json' as const, path: file }, { kind: 'json' as const, path: folder, folder: true }]
  assert.equal(claudeManagedSandboxPresent(sources), false, 'none at all')
  fs.writeFileSync(file, '{"permissions":{}}')
  assert.equal(claudeManagedSandboxPresent(sources), false)
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, '10-mdm.json'), '{"sandbox":{"enabled":false}}')
  assert.equal(claudeManagedSandboxPresent(sources), true, 'a drop-in file')

  const connection = (present: boolean) => createClaudeConnection({
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude',
    getShellEnv: () => ({}), managedSandboxPresent: () => present,
  })
  assert.equal(connection(true).sandboxMayBeOff?.(), true)
  assert.equal(connection(false).sandboxMayBeOff?.(), false)
})

test('the chat server tells the gate an enforce Claude turn\'s working folder and that its sandbox may be off', async () => {
  const { startChatServer } = await import('../electron/chat-server')
  const facts: AiTurnFacts[] = []
  const server = await startChatServer({
    getAuthMode: () => 'claude-code', getApiKey: () => undefined, buildSystemPrompt: () => '', getShellEnv: () => ({}),
    getPermissionMode: () => 'default', isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => '/test/claude', listenPort: 0,
    managedSandboxPresent: () => true,
    getAgentSandbox: async (_c, root) => ({ settings: { mode: 'enforce', allowedDomains: [], deniedReadPaths: [], onUnavailable: 'stop' }, host: { home: HOME, companyRoot: root } }),
    beforeAiTurn: async turn => { facts.push(turn); return false },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], companyId: 'co', appSessionId: 'conv', companyRootPath: '/tmp/acme', workingDirectory: '/tmp/acme' }),
    })
    assert.equal(res.status, 503)
    assert.equal(facts[0].sandbox?.mode, 'enforce')
    assert.equal(facts[0].sandboxMayBeOff, true)
    assert.equal(facts[0].workingDirectory, '/tmp/acme')
  } finally {
    server.server.close()
  }
})

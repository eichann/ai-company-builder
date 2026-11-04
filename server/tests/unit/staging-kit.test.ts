// The staging kit (staging/, README there): its secrets never reach the output and are made
// once (setup is idempotent), its settings refuse colliding ports, and the "follow production"
// hook moves the kit's own checkout to the commit the private config names — backing up the
// databases first — or keeps the version it has when the config cannot be read.
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM modules without type declarations (staging/ is not a package)
import * as kit from '../../../staging/lib/kit.mjs'
// @ts-expect-error -- see above
import { followProduction } from '../../../staging/bootstrap.mjs'
// @ts-expect-error -- see above
import { markProduction } from '../../../staging/mark-production.mjs'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-staging-kit-test-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const mode = (p: string) => fs.statSync(p).mode & 0o777
const env = (extra: Record<string, string> = {}) => ({ ACB_STAGING_HOME: path.join(tmp, 'home'), ACB_KIT_CONFIG: path.join(tmp, 'no-config'), ...extra })

function git(args: string[], cwd?: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('secrets', () => {
  it('are created once, owner-only, and never printed', () => {
    const lines: string[] = []
    const logger = kit.createLogger((l: string) => lines.push(l))
    const s = kit.settingsFrom(env())
    const p = kit.kitPaths(s.home)
    const first = kit.prepareSecrets(s, p, logger)
    expect(first.created).toHaveLength(3)
    const values = [p.authSecret, p.kek, p.fakeHubspotKey].map(f => fs.readFileSync(f, 'utf8').trim())
    for (const f of [p.authSecret, p.kek, p.fakeHubspotKey, p.env]) expect(mode(f)).toBe(0o600)
    expect(mode(p.secrets)).toBe(0o700)
    expect(fs.readFileSync(p.env, 'utf8')).toContain(`AUTH_SECRET=${values[0]}`)
    expect(Buffer.from(values[1], 'base64')).toHaveLength(32) // the server's KEK format
    expect(values[2].startsWith(kit.PRACTICE_HUBSPOT_PREFIX)).toBe(true)

    const again = kit.prepareSecrets(s, p, logger)
    expect(again.created).toEqual([])
    expect([p.authSecret, p.kek, p.fakeHubspotKey].map(f => fs.readFileSync(f, 'utf8').trim())).toEqual(values)

    const out = lines.join('\n')
    for (const v of values) expect(out).not.toContain(v)
    // and the logger hides them even when a message carries one
    logger.log(`oops ${values[1]}`)
    expect(lines.at(-1)).toBe('oops [secret]')
  })

  it('a secret file is never overwritten', () => {
    const f = path.join(tmp, 's', 'k')
    expect(kit.ensureSecretFile(f, () => 'first-value').created).toBe(true)
    expect(kit.ensureSecretFile(f, () => 'second-value')).toEqual({ created: false, value: 'first-value' })
  })

  it('the accounts file round-trips and is owner-only', () => {
    const f = path.join(tmp, 'accounts.txt')
    const m = new Map([['a-owner@example.invalid', { password: kit.newPassword(), role: 'オーナー' }]])
    kit.saveAccounts(f, m)
    expect(mode(f)).toBe(0o600)
    expect(kit.loadAccounts(f)).toEqual(m)
  })
})

describe('settings', () => {
  it('default to ports that do not collide with a hand-made staging (13001 / 3100)', () => {
    const s = kit.settingsFrom(env())
    expect([s.port, s.project, s.private]).toEqual([14001, 'acb-staging-kit', null])
  })
  it('refuse equal or invalid ports', () => {
    expect(() => kit.settingsFrom(env({ ACB_STAGING_PORT: '14010' }))).toThrow(/differ/)
    expect(() => kit.settingsFrom(env({ ACB_STAGING_PORT: '80' }))).toThrow(/port/)
  })
  it('only allow compose projects named acb-staging…, so down -v / --rmi reach nothing else', () => {
    expect(kit.settingsFrom(env({ ACB_STAGING_PROJECT: 'acb-staging-test' })).project).toBe('acb-staging-test')
    expect(() => kit.settingsFrom(env({ ACB_STAGING_PROJECT: 'acb' }))).toThrow(/acb-staging/)
    expect(() => kit.settingsFrom(env({ ACB_STAGING_PROJECT: 'supabase_db' }))).toThrow(/acb-staging/)
  })
  it('read the private setting from the local config file', () => {
    const cfg = path.join(tmp, 'config')
    fs.writeFileSync(cfg, '# onboarding\nACB_KIT_PRIVATE=example-org/ops:staging/kit.conf\n')
    expect(kit.settingsFrom(env({ ACB_KIT_CONFIG: cfg })).private).toEqual({ kind: 'github', repo: 'example-org/ops', path: 'staging/kit.conf' })
    expect(() => kit.parsePrivateSpec('example-org/ops:../x')).toThrow()
    expect(() => kit.parsePrivateSpec('file:relative')).toThrow()
  })
})

describe('deleting (reset / remove)', () => {
  it('refuses a folder without the kit\'s marker, the home folder, its parents and /', () => {
    const home = path.join(tmp, 'user')
    const kitHome = path.join(home, 'acb-staging-kit')
    fs.mkdirSync(kitHome, { recursive: true })
    const p = kit.kitPaths(kitHome)
    expect(() => kit.assertKitHome(p, home)).toThrow(/検証キットのフォルダではない/) // no marker yet
    fs.mkdirSync(p.secrets, { recursive: true })
    fs.writeFileSync(p.env, 'x')
    expect(() => kit.assertKitHome(p, home)).not.toThrow()
    for (const bad of [home, tmp, '/']) {
      const q = kit.kitPaths(bad)
      if (bad !== '/') { // even with a marker
        fs.mkdirSync(q.secrets, { recursive: true, mode: 0o700 })
        fs.writeFileSync(q.env, 'x')
      }
      expect(() => kit.assertKitHome(q, home)).toThrow()
    }
  })
})

describe('private kit config', () => {
  const sha = 'a'.repeat(40)
  it('parses the production commit and the plugin lock lines', () => {
    expect(kit.parsePrivateConfig(`# x\nproduction ${sha}\nexample-org/connectors hubspot@0.3.0 abc\n`))
      .toEqual({ production: sha, pluginsLockPath: null, lockLines: ['example-org/connectors hubspot@0.3.0 abc'] })
    expect(() => kit.parsePrivateConfig('production main\n')).toThrow()
  })
  it('mark-production changes only the production line', () => {
    const file = path.join(tmp, 'kit.conf')
    fs.writeFileSync(file, `production ${sha}\nexample-org/connectors hubspot@0.3.0 abc\n`)
    const next = 'b'.repeat(40)
    expect(markProduction(next, { ACB_KIT_PRIVATE: `file:${file}` })).toEqual({ sha: next, changed: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(`production ${next}\nexample-org/connectors hubspot@0.3.0 abc\n`)
    expect(markProduction(next, { ACB_KIT_PRIVATE: `file:${file}` }).changed).toBe(false)
  })
  it('mark-production starts from empty only when the config is not there, never when it cannot be read', () => {
    const missing = path.join(tmp, 'new.conf')
    expect(markProduction('c'.repeat(40), { ACB_KIT_PRIVATE: `file:${missing}` }).changed).toBe(true)
    expect(kit.parsePrivateConfig(fs.readFileSync(missing, 'utf8')).production).toBe('c'.repeat(40))
    const unreadable = path.join(tmp, 'dir.conf')
    fs.mkdirSync(unreadable) // reading a folder fails with something other than "not there"
    expect(() => markProduction('d'.repeat(40), { ACB_KIT_PRIVATE: `file:${unreadable}` })).toThrow(/could not read/)
  })
  it('decideUpdate', () => {
    expect(kit.decideUpdate({ localSha: null, remoteSha: sha })).toEqual({ action: 'clone', to: sha })
    expect(kit.decideUpdate({ localSha: sha, remoteSha: sha })).toEqual({ action: 'none' })
    expect(kit.decideUpdate({ localSha: sha, remoteSha: 'b'.repeat(40) }).action).toBe('update')
    expect(kit.decideUpdate({ localSha: sha, remoteSha: null, error: 'x' }).action).toBe('offline')
    expect(kit.decideUpdate({ localSha: null, remoteSha: null, error: 'x' }).action).toBe('cannot-start')
  })
})

describe('following production (bootstrap.mjs)', () => {
  function makeRemote() {
    const work = path.join(tmp, 'work')
    fs.mkdirSync(work)
    git(['init', '-q', '-b', 'main'], work)
    const commit = (msg: string) => {
      git(['add', '-A'], work)
      git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', msg], work)
      return git(['rev-parse', 'HEAD'], work)
    }
    // A version without the kit (an older production commit).
    fs.writeFileSync(path.join(work, 'README'), 'no kit\n')
    const nokit = commit('before the kit')
    fs.mkdirSync(path.join(work, 'staging'))
    fs.writeFileSync(path.join(work, 'staging', 'kit.mjs'), '// kit\n')
    const one = commit('one')
    const two = commit('two')
    const bare = path.join(tmp, 'remote.git')
    git(['clone', '-q', '--bare', work, bare])
    return { bare, one, two, nokit }
  }

  it('checks out the private config\'s commit, then moves with it after backing up the databases', () => {
    const { bare, one, two, nokit } = makeRemote()
    const conf = path.join(tmp, 'kit.conf')
    fs.writeFileSync(conf, `production ${one}\nexample-org/connectors hubspot@0.3.0 abc\n`)
    const s = kit.settingsFrom(env({ ACB_STAGING_REMOTE: bare, ACB_KIT_PRIVATE: `file:${conf}` }))
    const p = kit.kitPaths(s.home)
    const lines: string[] = []
    const logger = kit.createLogger((l: string) => lines.push(l))
    let stopped = 0
    const stop = () => { stopped++ }

    const first = followProduction(s, p, logger, { stop })
    expect(first.private).toBe('ok')
    expect(first.note).toMatch(/本番と同じ版/)
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(one)
    expect(fs.readFileSync(p.lock, 'utf8')).toBe('example-org/connectors hubspot@0.3.0 abc\n')
    expect(mode(p.lock)).toBe(0o600)

    // Same commit: nothing to do.
    expect(followProduction(s, p, logger, { stop }).note).toBeNull()

    // Production moved: stop, back up, check out, say so.
    fs.mkdirSync(p.data, { recursive: true })
    fs.writeFileSync(path.join(p.data, 'app.sqlite'), 'db')
    markProduction(two, { ACB_KIT_PRIVATE: `file:${conf}` })
    const moved = followProduction(s, p, logger, { stop })
    expect(moved.note).toMatch(/^検証環境を本番と同じ版（\d+\/\d+）に更新しました。$/)
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(two)
    expect(stopped).toBe(1)
    const backups = fs.readdirSync(p.backups)
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(p.backups, backups[0], 'app.sqlite'), 'utf8')).toBe('db')
    expect(fs.readFileSync(path.join(p.data, 'app.sqlite'), 'utf8')).toBe('db') // the data is kept

    // A target without the kit: nothing is stopped or switched.
    markProduction(nokit, { ACB_KIT_PRIVATE: `file:${conf}` })
    const noKit = followProduction(s, p, logger, { stop })
    expect(noKit.note).toMatch(/検証キットが入っていないため、更新しませんでした/)
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(two)
    expect(stopped).toBe(1)

    // An older target (a rollback): updated, with a warning.
    markProduction(one, { ACB_KIT_PRIVATE: `file:${conf}` })
    lines.length = 0
    followProduction(s, p, logger, { stop })
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(one)
    expect(lines.join('\n')).toMatch(/古い版に戻します/)

    // The config cannot be read (offline, no access): keep the version, say so, name no place.
    fs.rmSync(conf)
    const offline = followProduction(s, p, logger, { stop })
    expect(offline.private).toBe('unreadable')
    expect(offline.note).toMatch(/いまの版のまま起動します/)
    expect(offline.note).not.toContain(conf)
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(one)
  }, 60_000)

  it('without the private setting follows the public branch and loads no private parts', () => {
    const { bare, two } = makeRemote()
    const s = kit.settingsFrom(env({ ACB_STAGING_REMOTE: bare }))
    const p = kit.kitPaths(s.home)
    const res = followProduction(s, p, kit.createLogger(() => {}), { stop: () => {} })
    expect(res.private).toBe('none')
    expect(git(['-C', p.app, 'rev-parse', 'HEAD'])).toBe(two)
    expect(fs.existsSync(p.lock)).toBe(false)
  }, 60_000)
})

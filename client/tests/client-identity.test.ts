import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAppGit } from '../electron/services/app-git'
import { build } from 'vite'
import { buildInfoDefine, compactUtc, computeBuildInfo } from '../scripts/build-info'
import {
  CLIENT_PLATFORM_HEADER,
  CLIENT_VERSION_HEADER,
  gitIdentityConfig,
  installServerFetchIdentity,
} from '../electron/client-identity'

const root = fileURLToPath(new URL('..', import.meta.url))
const git = (args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim()

test('build identity = package version + short commit + commit date, dev runs marked -dev', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  const sha = git(['rev-parse', '--short=7', 'HEAD'])
  const commitDate = compactUtc(new Date(Number(git(['log', '-1', '--format=%ct', 'HEAD'])) * 1000))

  const release = computeBuildInfo({ root, dev: false, now: new Date('2026-10-21T12:00:00Z') })
  assert.equal(release.version, `${pkg.version}+${sha}.${commitDate}`)
  assert.match(release.version, /^\d+\.\d+\.\d+\+[0-9a-f]{7}\.\d{14}$/)
  assert.equal(release.builtAt, '2026-10-21T12:00:00.000Z')
  assert.equal(release.dev, false)

  const dev = computeBuildInfo({ root, dev: true })
  assert.equal(dev.version, `${pkg.version}-dev+${sha}.${commitDate}`)
  assert.equal(dev.dev, true)
})

test('the identity is embedded into the bundled main-process module', async () => {
  const info = computeBuildInfo({ root, dev: false })
  const outDir = mkdtempSync(path.join(tmpdir(), 'acb-identity-build-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      root,
      define: buildInfoDefine(info),
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        lib: { entry: path.join(root, 'electron/client-identity.ts'), formats: ['es'], fileName: () => 'identity.mjs' },
      },
    })
    const bundled = await import(pathToFileURL(path.join(outDir, 'identity.mjs')).href)
    assert.deepEqual(bundled.BUILD_INFO, info)
    assert.equal(bundled.clientIdentityHeaders()[CLIENT_VERSION_HEADER], info.version)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/** The app's git (services/app-git.ts createGit) for `repo`, inheriting `env` as the environment. */
function appGitWith(repo: string, appGitDir: string, env: NodeJS.ProcessEnv) {
  const saved = process.env
  process.env = env // createGit inherits process.env when it builds the git
  try {
    return createAppGit({ token: () => '', appGitDir: () => appGitDir }).create(repo)
  } finally {
    process.env = saved
  }
}

test('createGit passes the identity headers to git as http.extraHeader', async () => {
  const config = gitIdentityConfig()
  assert.deepEqual(config, [
    `http.extraHeader=${CLIENT_VERSION_HEADER}: 0.0.0-unbundled+nogit.00000000000000`,
    `http.extraHeader=${CLIENT_PLATFORM_HEADER}: ${process.platform}/${process.arch}`,
  ])

  // What git itself sees through the app's createGit (services/app-git.ts on
  // sync/git-factory.ts): the identity headers after the guarded settings.
  const appGitDir = mkdtempSync(path.join(tmpdir(), 'acb-app-git-'))
  try {
    const git = appGitWith(root, appGitDir, process.env)
    assert.deepEqual((await git.raw(['config', '--get-all', 'http.extraHeader'])).trim().split('\n'), config.map(c => c.slice('http.extraHeader='.length)))
    assert.equal((await git.raw(['config', '--get', 'http.postBuffer'])).trim(), '524288000')
    // No diffstat after a fast-forward pull: it would download, in a partial
    // clone, every teammate change outside the member's departments.
    assert.equal((await git.raw(['config', '--get', 'merge.stat'])).trim(), 'false')
    assert.equal((await git.raw(['config', '--get', 'credential.helper'])).trim(), '') // last value wins
    // The member's own hooks and templates never apply (git-factory appGitDirs).
    assert.equal((await git.raw(['config', '--get', 'core.hooksPath'])).trim(), path.join(appGitDir, 'hooks').split(path.sep).join('/'))
  } finally {
    rmSync(appGitDir, { recursive: true, force: true })
  }
})

// The 2026-07-29 sync freeze: `rebase --continue` after a conflicted pick
// opened vi with no terminal and blocked forever. The member's environment
// and git config may name any editor; the app's git must never start one.
// This editor records that it ran and fails, so a regression shows up as a
// failed rebase and a marker file rather than a hang.
test('sync never opens an editor when continuing a rebase, whatever editor the environment names', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acb-git-editor-'))
  try {
    const marker = path.join(dir, 'editor-was-opened')
    const editor = path.join(dir, 'editor.sh')
    writeFileSync(editor, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`)
    chmodSync(editor, 0o755)
    const hostile: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: editor, GIT_SEQUENCE_EDITOR: editor, EDITOR: editor, VISUAL: editor }

    // A local commit that conflicts with the server's, stopped mid-rebase
    // (set up with plain git, which may not open an editor either).
    const repo = path.join(dir, 'repo')
    const setupEnv = { ...process.env, GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false' }
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, env: setupEnv, stdio: 'pipe' }).toString()
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo])
    run(['config', 'user.name', 'member'])
    run(['config', 'user.email', 'member@example.com'])
    run(['config', 'core.editor', editor])
    writeFileSync(path.join(repo, 'memo.md'), 'base\n')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'base'])
    run(['checkout', '-q', '-b', 'server'])
    writeFileSync(path.join(repo, 'memo.md'), 'server\n')
    run(['commit', '-q', '-am', 'server change'])
    run(['checkout', '-q', 'main'])
    writeFileSync(path.join(repo, 'memo.md'), 'local\n')
    run(['commit', '-q', '-am', 'local change'])
    assert.throws(() => run(['rebase', 'server']), 'the rebase stops on the conflict')
    writeFileSync(path.join(repo, 'memo.md'), 'server\nlocal\n')
    run(['add', 'memo.md'])

    const git = appGitWith(repo, path.join(dir, 'app-git'), hostile)
    await git.rebase(['--continue']) // what git-sync.ts runs after resolving a conflict
    assert.equal(existsSync(marker), false, 'an editor was started')
    assert.equal(run(['log', '-1', '--format=%s']).trim(), 'local change')
    assert.equal(run(['rev-parse', 'HEAD~1']).trim(), run(['rev-parse', 'server']).trim())

    // The sequence editor too (an interactive rebase's todo list).
    await git.rebase(['-i', 'HEAD~1'])
    assert.equal(existsSync(marker), false, 'a sequence editor was started')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetches to the server origin carry the identity headers, others are untouched', async () => {
  const calls: Array<{ url: string; headers: Headers }> = []
  const target = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) })
      return new Response('{}')
    }) as typeof fetch,
  }
  let serverUrl = 'https://acb.example.com'
  installServerFetchIdentity(() => serverUrl, target)
  installServerFetchIdentity(() => serverUrl, target) // idempotent

  await target.fetch('https://acb.example.com/api/companies/c1', { headers: { Cookie: 'a=b' } })
  await target.fetch(new URL('https://acb.example.com/api/me'))
  await target.fetch(new Request('https://acb.example.com/api/git/repos/c1', { headers: { 'X-Other': '1' } }))
  await target.fetch('https://acb.example.com/api/me', { headers: { [CLIENT_VERSION_HEADER]: 'explicit' } })
  await target.fetch('https://api.anthropic.com/v1/messages')
  await target.fetch('http://127.0.0.1:4000/api/session')
  serverUrl = ''
  await target.fetch('https://acb.example.com/api/me')

  const version = (i: number) => calls[i].headers.get(CLIENT_VERSION_HEADER)
  assert.equal(version(0), '0.0.0-unbundled+nogit.00000000000000')
  assert.equal(calls[0].headers.get(CLIENT_PLATFORM_HEADER), `${process.platform}/${process.arch}`)
  assert.equal(calls[0].headers.get('Cookie'), 'a=b')
  assert.ok(version(1))
  assert.ok(version(2))
  assert.equal(calls[2].headers.get('X-Other'), '1')
  assert.equal(version(3), 'explicit')
  assert.equal(version(4), null)
  assert.equal(version(5), null)
  assert.equal(version(6), null)
  assert.equal(calls.length, 7)
})

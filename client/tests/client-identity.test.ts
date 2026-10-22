import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import simpleGit from 'simple-git'
import { createConfiguredGit } from '../electron/sync/git-factory'
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

  // vite.config.ts applies the same define to the Electron main entry.
  const viteConfig = readFileSync(path.join(root, 'vite.config.ts'), 'utf8')
  const mainEntry = viteConfig.slice(viteConfig.indexOf("entry: 'electron/main.ts'"), viteConfig.indexOf("entry: 'electron/preload.ts'"))
  assert.match(mainEntry, /define: buildInfoDefine\(computeBuildInfo\(\{ root: __dirname, dev: command === 'serve' \}\)\)/)
})

test('createGit passes the identity headers to git as http.extraHeader', async () => {
  const config = gitIdentityConfig()
  assert.deepEqual(config, [
    `http.extraHeader=${CLIENT_VERSION_HEADER}: 0.0.0-unbundled+nogit.00000000000000`,
    `http.extraHeader=${CLIENT_PLATFORM_HEADER}: ${process.platform}/${process.arch}`,
  ])

  // simple-git turns `config` into `-c` arguments: git itself sees both values.
  const seen = await simpleGit(root, { config }).raw(['config', '--get-all', 'http.extraHeader'])
  assert.deepEqual(seen.trim().split('\n'), config.map(c => c.slice('http.extraHeader='.length)))

  // createGit (electron/main.ts) hands them to the shared git factory
  // (electron/sync/git-factory.ts), which appends them after the guarded
  // settings — check what git actually sees through that factory.
  const main = readFileSync(path.join(root, 'electron/main.ts'), 'utf8')
  const start = main.indexOf('function createGit(')
  assert.ok(start >= 0, 'createGit not found in electron/main.ts')
  const body = main.slice(start, main.indexOf('\n}\n', start))
  assert.match(body, /createConfiguredGit\(/)
  assert.match(body, /extraConfig: gitIdentityConfig\(\)/)
  const appGitDir = mkdtempSync(path.join(tmpdir(), 'acb-app-git-'))
  const git = createConfiguredGit(root, { binary: 'git', askPassPath: '/nonexistent', token: '', appGitDir, extraConfig: config })
  assert.deepEqual((await git.raw(['config', '--get-all', 'http.extraHeader'])).trim().split('\n'), config.map(c => c.slice('http.extraHeader='.length)))
  assert.equal((await git.raw(['config', '--get', 'http.postBuffer'])).trim(), '524288000')
  // No diffstat after a fast-forward pull: it would download, in a partial
  // clone, every teammate change outside the member's departments.
  assert.equal((await git.raw(['config', '--get', 'merge.stat'])).trim(), 'false')
  assert.equal((await git.raw(['config', '--get', 'credential.helper'])).trim(), '') // last value wins
  assert.equal((await git.raw(['var', 'GIT_EDITOR'])).trim(), 'true')
  // The member's own hooks and templates never apply (git-factory appGitDirs).
  assert.equal((await git.raw(['config', '--get', 'core.hooksPath'])).trim(), path.join(appGitDir, 'hooks').split(path.sep).join('/'))
  rmSync(appGitDir, { recursive: true, force: true })
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

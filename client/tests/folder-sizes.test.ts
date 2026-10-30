import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { folderSizesView, serverFolderSizes } from '../electron/sync/folder-sizes'

function repoWithOrigin(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acb-folder-sizes-')))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: path.join(root, 'tpl') }
  fs.mkdirSync(env.GIT_TEMPLATE_DIR)
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n')
  const repo = path.join(root, 'repo')
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' })
  fs.mkdirSync(repo)
  git(['init', '-q'])
  for (const f of ['README.md', 'コンテンツ/動画/a.mp4', 'コンテンツ/記事/b.md', '営業部/c.md', '.claude/skills/s.md']) {
    fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true })
    fs.writeFileSync(path.join(repo, f), f)
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'x'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return { root: repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('the request names the company and folders safely (encoded, every measured folder) and carries the session cookies', async () => {
  const calls: Array<{ url: string; cookie: string }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, cookie: (init.headers as Record<string, string>).Cookie })
    return new Response(JSON.stringify({ success: true, data: { path: '', size: 0, files: 0, folders: [], measured: {} } }))
  }) as unknown as typeof fetch
  const fetchSizes = serverFolderSizes({ baseUrl: 'http://acb.test', companyId: 'co 1/x', cookies: ['a=1', 'b=2'], fetchImpl })
  await fetchSizes('コンテンツ&measure=経理部', ['営業部', '総務 部'])
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/companies/co%201%2Fx/folder-sizes')
  assert.equal(url.searchParams.get('path'), 'コンテンツ&measure=経理部')
  assert.deepEqual(url.searchParams.getAll('measure'), ['営業部', '総務 部'])
  assert.equal(calls[0].cookie, 'a=1; b=2')
})

test('server unreachable: the folders are listed from the local trees, without sizes', async () => {
  const fetchSizes = serverFolderSizes({ baseUrl: 'http://acb.test', companyId: 'co', cookies: [], fetchImpl: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch })
  const { root, cleanup } = repoWithOrigin()
  try {
    const top = await folderSizesView(simpleGit(root), fetchSizes, '', ['営業部'])
    assert.equal(top.offline, true)
    assert.equal(top.size, null)
    assert.deepEqual(top.folders.map(f => [f.path, f.size, f.hasChildren]), [['.claude', null, true], ['コンテンツ', null, true], ['営業部', null, true]])
    assert.deepEqual(top.measured, { '営業部': null })
    const sub = await folderSizesView(simpleGit(root), null, 'コンテンツ', [])
    assert.deepEqual(sub.folders.map(f => f.path), ['コンテンツ/記事', 'コンテンツ/動画'])
  } finally {
    cleanup()
  }
})

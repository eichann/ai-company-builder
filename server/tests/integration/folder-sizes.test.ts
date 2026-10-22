/**
 * Integration Test: GET /api/companies/:companyId/folder-sizes — folder sizes
 * of the shared branch for the desktop app's "ダウンロードするフォルダ"
 * settings (a partial clone cannot compute them without downloading the
 * blobs it left out).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const currentUser = vi.hoisted(() => ({ id: 'fs-member' as string | null }))

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockImplementation(async () =>
    currentUser.id
      ? { id: currentUser.id, email: `${currentUser.id}@example.com`, name: currentUser.id, image: null, emailVerified: true }
      : null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { Hono } from 'hono'
import { db, initDatabase } from '../../src/db'
import { folderSizesRoute } from '../../src/routes/folder-sizes'

const app = new Hono()
app.route('/api/companies/:companyId/folder-sizes', folderSizesRoute)

const CO = 'fs-co'
const REPOS_DIR = process.env.REPOS_DIR as string
const ts = () => new Date().toISOString()
let work: string

interface Body {
  success?: boolean
  error?: string
  data?: {
    path: string
    size: number
    files: number
    folders: Array<{ name: string; path: string; size: number; files: number; hasChildren: boolean }>
    measured: Record<string, number | null>
  }
}

async function get(query: string, userId: string | null = 'fs-member') {
  currentUser.id = userId
  const res = await app.request(`/api/companies/${CO}/folder-sizes${query}`)
  return { status: res.status, body: await res.json() as Body }
}

const FILES: Record<string, number> = {
  'README.md': 10,
  'コンテンツ/top.md': 100,
  'コンテンツ/動画/intro.mp4': 5000,
  'コンテンツ/動画/編集/cut.md': 300,
  'コンテンツ/記事/a.md': 40,
  '営業部/提案書.md': 7,
  '.claude/skills/s/SKILL.md': 20,
}

beforeAll(() => {
  initDatabase()
  db.prepare('INSERT INTO companies (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(CO, CO, CO, 'fs-owner', ts(), ts())
  db.prepare('INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('fs-m1', 'fs-member', CO, 'member', ts(), ts())

  work = mkdtempSync(join(tmpdir(), 'acb-folder-sizes-'))
  const bare = join(REPOS_DIR, `${CO}.git`)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(work, 'gitconfig'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' })
  git(work, ['init', '-q', '--bare', '-b', 'main', bare])
  const clone = join(work, 'clone')
  git(work, ['init', '-q', '-b', 'main', clone])
  for (const [rel, size] of Object.entries(FILES)) {
    mkdirSync(join(clone, dirname(rel)), { recursive: true })
    writeFileSync(join(clone, rel), Buffer.alloc(size, 1))
  }
  git(clone, ['add', '-A'])
  git(clone, ['commit', '-q', '-m', 'seed'])
  git(clone, ['push', '-q', bare, 'main'])
})

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('GET /folder-sizes', () => {
  it('requires a session and membership', async () => {
    expect((await get('', null)).status).toBe(401)
    expect((await get('', 'fs-stranger')).status).toBe(404)
  })

  it('the root: total size and every root folder (dotfolders included) with its size', async () => {
    const r = await get('')
    expect(r.status).toBe(200)
    expect(r.body.data?.size).toBe(5477)
    expect(r.body.data?.files).toBe(7)
    expect(r.body.data?.folders).toEqual([
      { name: '.claude', path: '.claude', size: 20, files: 1, hasChildren: true },
      { name: 'コンテンツ', path: 'コンテンツ', size: 5440, files: 4, hasChildren: true },
      { name: '営業部', path: '営業部', size: 7, files: 1, hasChildren: false },
    ])
  })

  it('a department: its sub-folders, lazily one level at a time, and measured folders', async () => {
    const r = await get(`?path=${encodeURIComponent('コンテンツ')}&measure=${encodeURIComponent('コンテンツ/動画')}&measure=${encodeURIComponent('営業部')}&measure=nope`)
    expect(r.status).toBe(200)
    expect(r.body.data?.path).toBe('コンテンツ')
    expect(r.body.data?.size).toBe(5440)
    expect(r.body.data?.folders).toEqual([ // sorted by name, Japanese collation
      { name: '記事', path: 'コンテンツ/記事', size: 40, files: 1, hasChildren: false },
      { name: '動画', path: 'コンテンツ/動画', size: 5300, files: 2, hasChildren: true },
    ])
    expect(r.body.data?.measured).toEqual({ 'コンテンツ/動画': 5300, '営業部': 7, nope: null })
    const deeper = await get(`?path=${encodeURIComponent('コンテンツ/動画')}`)
    expect(deeper.body.data?.folders).toEqual([{ name: '編集', path: 'コンテンツ/動画/編集', size: 300, files: 1, hasChildren: false }])
  })

  it('NFD spellings resolve; unknown folders are 404; traversal is 400', async () => {
    expect((await get(`?path=${encodeURIComponent('コンテンツ'.normalize('NFD'))}`)).status).toBe(200)
    expect((await get('?path=nope')).status).toBe(404)
    expect((await get(`?path=${encodeURIComponent('README.md')}`)).status).toBe(404)
    expect((await get(`?path=${encodeURIComponent('../x')}`)).status).toBe(400)
  })
})

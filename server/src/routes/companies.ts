import { Hono } from 'hono'
import { db, generateId, now } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import { installPreReceiveHook } from './git'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const companiesRoute = new Hono()

// Default departments for new companies
// Folder names are intentionally the same as the Japanese department names —
// the department folder pattern allows Japanese (see CLAUDE.md naming rules)
const DEFAULT_DEPARTMENTS = [
  { name: '営業部', nameEn: 'Sales', folder: '営業部', icon: 'Storefront', color: '#3b82f6', description: '顧客対応、提案書作成、売上管理' },
  { name: '経理部', nameEn: 'Accounting', folder: '経理部', icon: 'ChartPie', color: '#10b981', description: '経費処理、月次決算、予算管理' },
  { name: '人事部', nameEn: 'HR', folder: '人事部', icon: 'Users', color: '#ec4899', description: '採用、労務管理、研修企画' },
  { name: 'コンテンツ', nameEn: 'Contents', folder: 'コンテンツ', icon: 'Article', color: '#8b5cf6', description: 'ブログ、SNS、マーケティング資料' },
  { name: '開発部', nameEn: 'Development', folder: '開発部', icon: 'Code', color: '#6366f1', description: 'プロダクト開発、技術調査' },
  { name: '総務', nameEn: 'General Affairs', folder: '総務', icon: 'Buildings', color: '#f59e0b', description: '社内調整、備品管理、総合窓口' },
]

// Helper: Initialize default departments for a company
function initializeDefaultDepartments(companyId: string, userId: string) {
  const timestamp = now()

  const insertStmt = db.prepare(`
    INSERT INTO departments (
      id, company_id, parent_id,
      name, name_en, folder,
      icon, color, description,
      sort_order, is_active,
      created_at, updated_at, created_by
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)

  DEFAULT_DEPARTMENTS.forEach((dept, index) => {
    const id = generateId()
    insertStmt.run(
      id,
      companyId,
      dept.name,
      dept.nameEn,
      dept.folder,
      dept.icon,
      dept.color,
      dept.description,
      index,
      timestamp,
      timestamp,
      userId
    )
  })
}

// Helper: Convert snake_case object to camelCase
function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    result[camelKey] = value
  }
  return result
}

// Base directory for Git repositories
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const REPOS_DIR = process.env.REPOS_DIR || join(DATA_DIR, 'repos')
const WORKDIR_DIR = join(DATA_DIR, 'workdirs') // Must match departments.ts so GETs reuse the same clone

// Helper: Create slug from name
function createSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Helper: Build a unique slug. Japanese-only names produce an empty base
// slug, so fall back to the company id; collisions get a numeric suffix
// instead of rejecting creation (the client has no slug input to fix it).
// An explicitly requested slug (admin panel) is sanitized and honored.
function buildUniqueSlug(name: string, requestedSlug: unknown, companyId: string): string {
  const base =
    (typeof requestedSlug === 'string' && createSlug(requestedSlug)) ||
    createSlug(name) ||
    `company-${companyId.slice(0, 8)}`

  let slug = base
  for (let n = 2; ; n++) {
    const existing = db.prepare('SELECT id FROM companies WHERE slug = ?').get(slug)
    if (!existing) return slug
    slug = `${base}-${n}`
  }
}

// Helper: Create Git bare repo for company
function createCompanyRepo(companyId: string): string {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true })
  }
  const repoPath = join(REPOS_DIR, `${companyId}.git`)
  if (!existsSync(repoPath)) {
    mkdirSync(repoPath, { recursive: true })
    // Pin the branch name: the client hardcodes origin/main, so the repo must
    // never default to the container git's default (master).
    execFileSync('git', ['init', '--bare', '--initial-branch=main', repoPath], { stdio: 'pipe' })
    // Same setup as the repo-creation endpoint in git.ts: enable HTTP push
    // and protect against gitlink pushes.
    execFileSync('git', ['-C', repoPath, 'config', 'http.receivepack', 'true'], { stdio: 'pipe' })
    installPreReceiveHook(repoPath)
  }
  return repoPath
}

// Helper: Seed default department folders into the company repo, so the
// filesystem (source of truth) matches the DB rows created by
// initializeDefaultDepartments. Without this, GET /departments returns an
// empty list (it only returns DB rows whose folder exists on disk).
function seedDepartmentFolders(companyId: string, bareRepoPath: string): void {
  const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
  const workDir = join(WORKDIR_DIR, sanitizedId)

  if (!existsSync(WORKDIR_DIR)) {
    mkdirSync(WORKDIR_DIR, { recursive: true })
  }
  if (!existsSync(workDir)) {
    execFileSync('git', ['clone', bareRepoPath, workDir], { stdio: 'pipe' })
  }
  // The bare repo is empty here; pin the unborn branch to main regardless of
  // the host git's init.defaultBranch
  execFileSync('git', ['-C', workDir, 'checkout', '-B', 'main'], { stdio: 'pipe' })

  // Normalize line endings to LF on every platform: scripts inside shared
  // skills break under Git Bash on Windows when checked out as CRLF.
  // (text=auto only applies to files git detects as text — binaries are safe.)
  writeFileSync(
    join(workDir, '.gitattributes'),
    '# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n'
  )

  // Same folder layout as the create-department endpoint in departments.ts
  for (const dept of DEFAULT_DEPARTMENTS) {
    const folderPath = join(workDir, dept.folder)
    mkdirSync(folderPath, { recursive: true })
    writeFileSync(join(folderPath, '.gitkeep'), '')

    const personalDir = join(folderPath, '.personal')
    mkdirSync(personalDir, { recursive: true })
    writeFileSync(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')
  }

  execFileSync('git', ['-C', workDir, 'add', '-A'], { stdio: 'pipe' })
  // Explicit identity: seeding must not depend on host-level git config
  execFileSync('git', [
    '-C', workDir,
    '-c', 'user.name=AI Company Builder',
    '-c', 'user.email=system@ai-company-builder.local',
    'commit', '-m', 'Initialize default department folders',
  ], { stdio: 'pipe' })
  execFileSync('git', ['-C', workDir, 'push', 'origin', 'main'], { stdio: 'pipe' })
}

// List companies for the current user
companiesRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const stmt = db.prepare(`
    SELECT c.*, m.role
    FROM companies c
    JOIN memberships m ON c.id = m.company_id
    WHERE m.user_id = ?
    ORDER BY c.created_at DESC
  `)
  const companies = stmt.all(user.id) as Record<string, unknown>[]

  return c.json({
    success: true,
    data: companies.map(toCamelCase),
  })
})

// Get a specific company
companiesRoute.get('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')

  // Check if user has access to this company
  const membership = db.prepare(`
    SELECT * FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId)

  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Record<string, unknown>

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: (membership as { role: string }).role,
    },
  })
})

// Create a new company
companiesRoute.post('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json()
  const { name } = body

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'Company name is required' }, 400)
  }

  const id = generateId()
  const slug = buildUniqueSlug(name, body.slug, id)
  const timestamp = now()

  // Create Git repo
  let repoPath: string | null = null
  try {
    repoPath = createCompanyRepo(id)
  } catch (e) {
    console.error('Failed to create repo:', e)
    // Continue without repo - can be created later
  }

  // Insert company
  db.prepare(`
    INSERT INTO companies (id, name, slug, owner_id, repo_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), slug, user.id, repoPath, timestamp, timestamp)

  // Add owner as member with 'owner' role
  const membershipId = generateId()
  db.prepare(`
    INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
    VALUES (?, ?, ?, 'owner', ?, ?)
  `).run(membershipId, user.id, id, timestamp, timestamp)

  // Initialize default departments
  try {
    initializeDefaultDepartments(id, user.id)
  } catch (e) {
    console.error('Failed to initialize departments:', e)
    // Continue - company is created, departments can be added later
  }

  // Seed the matching folders into the repo (filesystem = source of truth)
  if (repoPath) {
    try {
      seedDepartmentFolders(id, repoPath)
    } catch (e) {
      console.error('Failed to seed department folders:', e)
      // Continue - folders can be created later via the departments API
    }
  }

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Record<string, unknown>

  return c.json({
    success: true,
    data: {
      ...toCamelCase(company),
      role: 'owner',
    },
  }, 201)
})

// Get company members
companiesRoute.get('/:id/members', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }

  // For now, allow any member to view the member list
  const members = db.prepare(`
    SELECT m.id, m.user_id, m.company_id, m.role, m.created_at
    FROM memberships m
    WHERE m.company_id = ?
    ORDER BY m.created_at ASC
  `).all(companyId) as Array<{ id: string; user_id: string; company_id: string; role: string; created_at: string }>

  // Enrich with user info from auth.sqlite
  const userIds = members.map(m => m.user_id)
  const usersMap = getUsersByIds(userIds)

  return c.json({
    success: true,
    data: members.map(m => {
      const userInfo = usersMap.get(m.user_id)
      return {
        id: m.id,
        userId: m.user_id,
        companyId: m.company_id,
        role: m.role,
        createdAt: m.created_at,
        email: userInfo?.email ?? null,
        name: userInfo?.name ?? null,
      }
    }),
  })
})

// Invite a member to company (by email or user_id)
companiesRoute.post('/:id/members', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership || !['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can invite members' }, 403)
  }

  const body = await c.req.json()
  const { userId, role = 'member' } = body

  if (!userId) {
    return c.json({ error: 'userId is required' }, 400)
  }

  if (!['owner', 'admin', 'member'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400)
  }

  // Check if already a member
  const existingMembership = db.prepare(`
    SELECT id FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(userId, companyId)

  if (existingMembership) {
    return c.json({ error: 'User is already a member' }, 409)
  }

  const id = generateId()
  const timestamp = now()

  db.prepare(`
    INSERT INTO memberships (id, user_id, company_id, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, companyId, role, timestamp, timestamp)

  return c.json({
    success: true,
    data: { id, userId, companyId, role, createdAt: timestamp },
  }, 201)
})

// Remove a member from company
companiesRoute.delete('/:id/members/:userId', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')
  const targetUserId = c.req.param('userId')

  // Check if user is admin/owner of this company
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership || !['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can remove members' }, 403)
  }

  // Cannot remove the owner
  const targetMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(targetUserId, companyId) as { role: string } | undefined

  if (targetMembership?.role === 'owner') {
    return c.json({ error: 'Cannot remove the owner' }, 403)
  }

  db.prepare(`
    DELETE FROM memberships WHERE user_id = ? AND company_id = ?
  `).run(targetUserId, companyId)

  return c.json({
    success: true,
    message: 'Member removed',
  })
})

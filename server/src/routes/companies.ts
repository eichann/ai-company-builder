import { Hono } from 'hono'
import { db, generateId, now } from '../db'
import { getUserFromRequest, getUsersByIds } from '../lib/auth'
import { gitAsync, initBareRepo, internalGitEnv } from '../lib/git-server'
import { withCompanyLock } from '../lib/company-lock'
import { getClientActivityForCompany } from '../lib/client-activity'
import { parseClientVersion } from '../lib/client-version'
import { deleteUserRules, ensureCompanyScope, removeManagerFromCompany, syncCompanyScopes } from '../lib/permission-store'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
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
async function createCompanyRepo(companyId: string): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true })
  const repoPath = join(REPOS_DIR, `${companyId}.git`)
  if (!existsSync(repoPath)) {
    // Same setup as the repo-creation endpoint in git.ts: branch main, HTTP
    // push, force-push protection, pre-receive hook.
    await initBareRepo(repoPath)
  }
  return repoPath
}

// Watchdog for each git command of the seeding. The push runs the
// pre-receive checker; a hung checker must fail the seeding, not leave the
// request (and the company's working-clone lock) waiting forever. Generous:
// nothing else waits on it now, and the checker (node + tsx) has taken over a
// minute for this tiny push on a loaded host — cutting it would leave the
// company without its folders.
const SEED_GIT_TIMEOUT_MS = { local: 60_000, push: 300_000 }

/** Tests only: shorten the seeding watchdog. Returns a restore function. */
export function setSeedGitTimeoutsForTests(timeouts: { local: number; push: number }): () => void {
  const previous = { ...SEED_GIT_TIMEOUT_MS }
  Object.assign(SEED_GIT_TIMEOUT_MS, timeouts)
  return () => { Object.assign(SEED_GIT_TIMEOUT_MS, previous) }
}

// Helper: Seed default department folders into the company repo, so the
// filesystem (source of truth) matches the DB rows created by
// initializeDefaultDepartments. Without this, GET /departments returns an
// empty list (it only returns DB rows whose folder exists on disk).
//
// Asynchronous, in the working clone, under the company lock like every
// other working-clone mutation (departments.ts): this request shares the
// process with every member's git-http traffic, and the synchronous version
// blocked all of it while the push's pre-receive checker ran — with no limit.
function seedDepartmentFolders(companyId: string, bareRepoPath: string): Promise<void> {
  return withCompanyLock(companyId, async () => {
    const sanitizedId = companyId.replace(/[^a-zA-Z0-9_-]/g, '')
    const workDir = join(WORKDIR_DIR, sanitizedId)
    const local = { timeoutMs: SEED_GIT_TIMEOUT_MS.local }

    await mkdir(WORKDIR_DIR, { recursive: true })
    if (!existsSync(workDir)) {
      await gitAsync(['clone', bareRepoPath, workDir], local)
    }
    // The bare repo is empty here; pin the unborn branch to main regardless of
    // the host git's init.defaultBranch
    await gitAsync(['-C', workDir, 'checkout', '-B', 'main'], local)

    // Normalize line endings to LF on every platform: scripts inside shared
    // skills break under Git Bash on Windows when checked out as CRLF.
    // (text=auto only applies to files git detects as text — binaries are safe.)
    await writeFile(
      join(workDir, '.gitattributes'),
      '# AI Company Builder: テキストファイルの改行コードを全OSでLFに統一\n* text=auto eol=lf\n'
    )

    // Same folder layout as the create-department endpoint in departments.ts
    for (const dept of DEFAULT_DEPARTMENTS) {
      const folderPath = join(workDir, dept.folder)
      await mkdir(folderPath, { recursive: true })
      await writeFile(join(folderPath, '.gitkeep'), '')

      const personalDir = join(folderPath, '.personal')
      await mkdir(personalDir, { recursive: true })
      await writeFile(join(personalDir, '.gitignore'), '# Personal workspace — not synced\n*\n!.gitignore\n')
    }

    await gitAsync(['-C', workDir, 'add', '-A'], local)
    // Explicit identity: seeding must not depend on host-level git config
    await gitAsync([
      '-C', workDir,
      '-c', 'user.name=AI Company Builder',
      '-c', 'user.email=system@ai-company-builder.local',
      'commit', '-m', 'Initialize default department folders',
    ], local)
    // The server's own push: marked so the hook skips the write-permission check
    await gitAsync(['-C', workDir, 'push', 'origin', 'main'], {
      env: internalGitEnv(),
      timeoutMs: SEED_GIT_TIMEOUT_MS.push,
    })
  })
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
    repoPath = await createCompanyRepo(id)
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

  // Permission scopes: company-wide `everyone: read + write` (today's fully
  // open behaviour) and one inheriting scope per department
  try {
    ensureCompanyScope(db, id, user.id)
    syncCompanyScopes(db, id)
  } catch (e) {
    console.error('Failed to initialize permission scopes:', e)
    // Continue - startup seeding creates them on the next restart
  }

  // Seed the matching folders into the repo (filesystem = source of truth)
  if (repoPath) {
    try {
      await seedDepartmentFolders(id, repoPath)
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

// Which desktop-app build each member last used and when they last synced
// (owner/admin only). See lib/client-activity.ts for what is recorded when.
companiesRoute.get('/:id/client-activity', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')
  const userMembership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined

  if (!userMembership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }
  if (!['owner', 'admin'].includes(userMembership.role)) {
    return c.json({ error: 'Only owners and admins can view client activity' }, 403)
  }

  const members = db.prepare(`
    SELECT user_id, role FROM memberships WHERE company_id = ? ORDER BY created_at ASC
  `).all(companyId) as Array<{ user_id: string; role: string }>
  const activity = getClientActivityForCompany(companyId)
  const usersMap = getUsersByIds(members.map(m => m.user_id))

  return c.json({
    success: true,
    data: members.map(m => {
      const row = activity.get(m.user_id)
      const parsed = parseClientVersion(row?.client_version)
      const userInfo = usersMap.get(m.user_id)
      return {
        userId: m.user_id,
        role: m.role,
        email: userInfo?.email ?? null,
        name: userInfo?.name ?? null,
        clientVersion: row?.client_version ?? null,
        build: parsed
          ? { semver: `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join('.')}` : ''}`, sha: parsed.sha, commitDate: parsed.commitDate, dev: parsed.dev }
          : null,
        clientPlatform: row?.client_platform ?? null,
        lastSeenAt: row?.last_seen_at ?? null,
        lastFetchAt: row?.last_fetch_at ?? null,
        lastPushAt: row?.last_push_at ?? null,
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

  const body = await c.req.json().catch(() => null) as { userId?: unknown; role?: unknown } | null
  const userId = body?.userId
  const role = body?.role ?? 'member'

  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 200) {
    return c.json({ error: 'userId is required' }, 400)
  }

  if (typeof role !== 'string' || !['owner', 'admin', 'member'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400)
  }

  // Only owners may hand out owner/admin (as with PUT …/role): an admin who
  // could add an owner could add a second account of their own as owner and
  // take the company over.
  if (role !== 'member' && userMembership.role !== 'owner') {
    return c.json({ error: 'Only owners can add owners or admins' }, 403)
  }

  // The account must exist (a membership for an unknown id would be claimed
  // by whoever later signs up with that id).
  if (!getUsersByIds([userId]).has(userId)) {
    return c.json({ error: 'User not found' }, 404)
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

export const MAX_COMPANY_NAME_LENGTH = 100

// Rename a company (owner/admin). Only the display name changes: the slug,
// repository and folders stay as they are.
companiesRoute.patch('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')
  const membership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }
  if (!['owner', 'admin'].includes(membership.role)) {
    return c.json({ error: 'Only owners and admins can rename the company' }, 403)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const raw = (body as { name?: unknown } | null)?.name
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim() : ''
  if (!name) {
    return c.json({ error: 'Company name is required' }, 400)
  }
  if (name.length > MAX_COMPANY_NAME_LENGTH) {
    return c.json({ error: `Company name must be at most ${MAX_COMPANY_NAME_LENGTH} characters` }, 400)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return c.json({ error: 'Company name contains invalid characters' }, 400)
  }

  db.prepare('UPDATE companies SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), companyId)
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as Record<string, unknown>
  return c.json({ success: true, data: { ...toCamelCase(company), role: membership.role } })
})

// Change a member's role. Owners only: they alone may grant or revoke admin
// (and ownership). The last owner can never be demoted — not by another
// owner (there is none) and not by themselves — so a company always keeps
// someone who can manage it.
companiesRoute.put('/:id/members/:userId/role', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const companyId = c.req.param('id')
  const targetUserId = c.req.param('userId')
  const membership = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(user.id, companyId) as { role: string } | undefined
  if (!membership) {
    return c.json({ error: 'Company not found or access denied' }, 404)
  }
  if (membership.role !== 'owner') {
    return c.json({ error: 'Only owners can change member roles' }, 403)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const role = (body as { role?: unknown } | null)?.role
  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    return c.json({ error: 'Invalid role' }, 400)
  }

  const target = db.prepare(`
    SELECT role FROM memberships WHERE user_id = ? AND company_id = ?
  `).get(targetUserId, companyId) as { role: string } | undefined
  if (!target) {
    return c.json({ error: 'Member not found' }, 404)
  }

  if (target.role !== role) {
    const changed = db.transaction(() => {
      if (target.role === 'owner') {
        const owners = (db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'owner'`)
          .get(companyId) as { n: number }).n
        if (owners <= 1) return false
      }
      db.prepare('UPDATE memberships SET role = ?, updated_at = ? WHERE user_id = ? AND company_id = ?')
        .run(role, now(), targetUserId, companyId)
      // Owner/admin read and write everything; rules naming them are moot
      // and must not come back unnoticed if they are demoted later.
      if (role === 'owner' || role === 'admin') deleteUserRules(db, companyId, targetUserId)
      return true
    })()
    if (!changed) {
      return c.json({ error: 'The last owner cannot be demoted. Make another member an owner first.' }, 400)
    }
  }

  return c.json({ success: true, data: { userId: targetUserId, companyId, role } })
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

  // Membership, management rights and every rule naming them (private
  // folders included) go together: re-adding the account later starts from
  // nothing instead of silently restoring their old access.
  db.transaction(() => {
    db.prepare(`
      DELETE FROM memberships WHERE user_id = ? AND company_id = ?
    `).run(targetUserId, companyId)
    removeManagerFromCompany(db, companyId, targetUserId)
    deleteUserRules(db, companyId, targetUserId)
  })()

  return c.json({
    success: true,
    message: 'Member removed',
  })
})

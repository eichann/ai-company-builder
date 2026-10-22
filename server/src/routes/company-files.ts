/**
 * Read-only company files for the chat AI (permission plan §11). Mounted at
 * /api/companies/:companyId/files. Shapes: shared/types/company-files.ts;
 * logic and the no-leak rules: lib/company-files.ts.
 *
 *   GET /tree?path=&depth=                          entries of a folder (depth 1–10)
 *   GET /content?path=&offset=&limit=&maxBytes=     text of a file, by lines
 *   GET /search?q=&path=&regex=&caseSensitive=&limit=&includePrivate=   git grep of main
 *       (the private folders below `path` only with includePrivate=true)
 *
 * Any member of the company. Everything is filtered by READ permission
 * (resolveAccess); a private folder the member cannot read answers exactly
 * like a path that does not exist. Non-members get the usual 404.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '../db'
import { getUserFromRequest } from '../lib/auth'
import { getMemberRole } from '../lib/permission-store'
import {
  buildView,
  CompanyFilesError,
  listTree,
  parseRequestPath,
  readContent,
  searchFiles,
  withSearchSlot,
  type CompanyFilesView,
} from '../lib/company-files'
import { COMPANY_FILES_LIMITS as LIMITS } from '../../shared/types/company-files'

export const companyFilesRoute = new Hono()

type Member = { companyId: string; userId: string; role: string }

async function authAndAuthorize(c: Context): Promise<Member | Response> {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  const role = getMemberRole(db, companyId, user.id)
  if (!role) return c.json({ error: 'Company not found or access denied' }, 404)
  return { companyId, userId: user.id, role }
}

/** Integer query parameter within [min, max]; `fallback` when absent; null when invalid. */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,9}$/.test(raw)) return null
  const n = Number(raw)
  return n < min ? null : Math.min(n, max)
}

function boolParam(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false
  if (raw === 'true' || raw === '1') return true
  return null
}

const invalid = (c: Context, code: 'INVALID_PATH' | 'INVALID_QUERY', message: string) => c.json({ error: message, code }, 400)

async function respond(c: Context, m: Member, run: (view: CompanyFilesView) => Promise<unknown> | unknown) {
  try {
    const view = await buildView(db, m.companyId, m.userId, m.role)
    return c.json({ success: true, data: await run(view) })
  } catch (error) {
    if (error instanceof CompanyFilesError) return c.json({ error: error.message, code: error.code }, error.status)
    console.error('company-files error:', error)
    return c.json({ error: 'Failed to read company files' }, 500)
  }
}

companyFilesRoute.get('/tree', async (c) => {
  const m = await authAndAuthorize(c)
  if (m instanceof Response) return m
  const segments = parseRequestPath(c.req.query('path'))
  if (!segments) return invalid(c, 'INVALID_PATH', 'Invalid path')
  const depth = intParam(c.req.query('depth'), 1, 1, LIMITS.treeMaxDepth)
  if (depth === null) return invalid(c, 'INVALID_QUERY', 'Invalid depth')
  return respond(c, m, view => listTree(view, segments, depth))
})

companyFilesRoute.get('/content', async (c) => {
  const m = await authAndAuthorize(c)
  if (m instanceof Response) return m
  const segments = parseRequestPath(c.req.query('path'))
  if (!segments) return invalid(c, 'INVALID_PATH', 'Invalid path')
  const offset = intParam(c.req.query('offset'), 1, 1, Number.MAX_SAFE_INTEGER)
  const limit = intParam(c.req.query('limit'), LIMITS.contentDefaultLines, 1, LIMITS.contentMaxLines)
  const maxBytes = intParam(c.req.query('maxBytes'), LIMITS.contentMaxBytes, 1, LIMITS.contentMaxBytes)
  if (offset === null || limit === null || maxBytes === null) return invalid(c, 'INVALID_QUERY', 'Invalid offset, limit or maxBytes')
  return respond(c, m, view => readContent(view, segments, { offset, limit, maxBytes }))
})

companyFilesRoute.get('/search', async (c) => {
  const m = await authAndAuthorize(c)
  if (m instanceof Response) return m
  const segments = parseRequestPath(c.req.query('path'))
  if (!segments) return invalid(c, 'INVALID_PATH', 'Invalid path')
  const query = (c.req.query('q') ?? '').normalize('NFC')
  if (query.trim().length === 0 || query.length > LIMITS.searchMaxQueryLength || /[\0\n\r]/.test(query)) {
    return invalid(c, 'INVALID_QUERY', `q must be 1–${LIMITS.searchMaxQueryLength} characters on one line`)
  }
  const regex = boolParam(c.req.query('regex'))
  const caseSensitive = boolParam(c.req.query('caseSensitive'))
  const includePrivate = boolParam(c.req.query('includePrivate'))
  const limit = intParam(c.req.query('limit'), LIMITS.searchDefaultMatches, 1, LIMITS.searchMaxMatches)
  if (regex === null || caseSensitive === null || includePrivate === null || limit === null) return invalid(c, 'INVALID_QUERY', 'Invalid regex, caseSensitive, includePrivate or limit')
  try {
    return await withSearchSlot(m.companyId, () =>
      respond(c, m, view => searchFiles(view, segments, { query, regex, caseSensitive, limit, includePrivate })))
  } catch (error) {
    if (error instanceof CompanyFilesError) return c.json({ error: error.message, code: error.code }, error.status)
    throw error
  }
})

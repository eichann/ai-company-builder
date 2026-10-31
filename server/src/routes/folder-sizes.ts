/**
 * GET /api/companies/:companyId/folder-sizes?path=<folder>&measure=<folder>…
 *
 * Any member: the size of a folder of the shared branch and of its immediate
 * sub-folders, plus the total size of each `measure` folder — for the
 * desktop app's "ダウンロードするフォルダ" settings. See lib/folder-sizes.ts
 * for why this is answered by the server. Folder names reveal nothing a
 * member's clone does not already have (every member has every tree).
 */
import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'
import { services } from '../composition'
import { folderSizes } from '../lib/folder-sizes'
import { logError } from '../lib/error-log'

export const folderSizesRoute = new Hono()

const MAX_PATH = 1024
const MAX_MEASURE = 200

function validFolder(p: string): boolean {
  if (p.length > MAX_PATH || p.includes('\0') || p.includes('\\')) return false
  return !p.split('/').some(seg => seg === '.' || seg === '..')
}

folderSizesRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = c.req.param('companyId')
  if (!companyId) return c.json({ error: 'Company ID is required' }, 400)
  if (!services.access.memberOf(companyId, user.id)) return c.json({ error: 'Company not found or access denied' }, 404)

  const folder = c.req.query('path') ?? ''
  const measure = c.req.queries('measure') ?? []
  if (!validFolder(folder) || measure.length > MAX_MEASURE || !measure.every(validFolder)) {
    return c.json({ error: 'Invalid path' }, 400)
  }
  try {
    const result = await folderSizes(companyId, folder, measure)
    if (!result) return c.json({ error: 'Folder not found' }, 404)
    return c.json({ success: true, data: result })
  } catch (error) {
    logError('folder-sizes', 'failed to read folder sizes', error)
    return c.json({ error: 'Failed to read folder sizes' }, 500)
  }
})

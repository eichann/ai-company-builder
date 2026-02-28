import { Hono } from 'hono'

export const syncRoute = new Hono()

// Request sync - returns list of files user has permission to access
syncRoute.post('/', async (c) => {
  const body = await c.req.json()
  const { companyId, lastSyncAt } = body

  // TODO: Implement with permission filtering
  // 1. Get user's permissions for the company
  // 2. Filter files based on permissions
  // 3. Return only files user has access to

  return c.json({
    success: true,
    data: {
      files: [],
      deletedPaths: [],
      syncedAt: new Date(),
    },
  })
})

// Upload file
syncRoute.post('/upload', async (c) => {
  // TODO: Implement file upload with permission check
  return c.json({
    success: true,
    data: { message: 'Upload endpoint - not implemented yet' },
  })
})

// Download file
syncRoute.get('/download/:path', async (c) => {
  const path = c.req.param('path')

  // TODO: Implement file download with permission check
  return c.json({
    success: true,
    data: { path, message: 'Download endpoint - not implemented yet' },
  })
})

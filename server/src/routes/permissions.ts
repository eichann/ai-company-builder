import { Hono } from 'hono'

export const permissionsRoute = new Hono()

// Get permissions for a user in a company
permissionsRoute.get('/:userId', (c) => {
  const userId = c.req.param('userId')
  const companyId = c.req.query('companyId')

  // TODO: Implement with DB
  return c.json({
    success: true,
    data: [
      {
        id: '1',
        userId,
        companyId,
        path: '/*',
        canRead: true,
        canWrite: true,
      },
    ],
  })
})

// Set permissions (admin only)
permissionsRoute.post('/', async (c) => {
  const body = await c.req.json()

  // TODO: Implement with auth check
  return c.json({
    success: true,
    data: {
      id: Date.now().toString(),
      ...body,
    },
  })
})

// Delete permission
permissionsRoute.delete('/:id', (c) => {
  const id = c.req.param('id')

  // TODO: Implement
  return c.json({
    success: true,
    data: { id },
  })
})

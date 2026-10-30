import { Hono } from 'hono'
import { getUserFromRequest } from '../lib/auth'

export const meRoute = new Hono()

// Get current user info
meRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return c.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
    },
  })
})

// No PATCH: changing one's name or image is not offered, and a route that
// answers success must have saved something.

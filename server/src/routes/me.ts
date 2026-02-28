import { Hono } from 'hono'
import { auth, getUserFromRequest } from '../lib/auth'

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

// Update current user info
meRoute.patch('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json()
  const { name, image } = body

  // Update user via Better Auth API
  // For now, just return the updated user concept
  // TODO: Implement actual update when Better Auth supports it

  return c.json({
    id: user.id,
    email: user.email,
    name: name ?? user.name,
    image: image ?? user.image,
    emailVerified: user.emailVerified,
  })
})

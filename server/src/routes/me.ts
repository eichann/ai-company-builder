import { Hono } from 'hono'
import { services } from '../composition'
import { signedIn } from './guards'

export const meRoute = new Hono()

// Get current user info
meRoute.get('/', signedIn, (c) => {
  const { user } = c.var

  return c.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      emailVerified: user.emailVerified,
      // Whether 「会社を作成」 is offered: the same check POST /api/companies
      // makes (services/companies.ts mayCreate). Only this account's own answer.
      canCreateCompany: services.companies.mayCreate(user.id).ok,
    },
  })
})

// No PATCH: changing one's name or image is not offered, and a route that
// answers success must have saved something.

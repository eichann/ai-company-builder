'use client'

import { useEffect, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { FullPageLoading } from './states'

/** Renders children only for a signed-in user; otherwise sends them to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname)}`)
    }
  }, [loading, user, router, pathname])

  if (loading || !user) return <FullPageLoading />
  return <>{children}</>
}

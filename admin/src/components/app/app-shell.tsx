'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import {
  Buildings,
  CaretUpDown,
  Check,
  Desktop,
  Gear,
  Key,
  List,
  LockKey,
  LockSimple,
  Moon,
  Plus,
  Robot,
  Barricade,
  ShieldCheck,
  SignOut,
  SquaresFour,
  Sun,
  TreeStructure,
  Users,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth-context'
import { useCompany } from '@/lib/company-context'
import { roleLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

interface NavItem {
  /** Path below /companies/[id]; '' is the overview. */
  segment: string
  label: string
  icon: Icon
  /** Who sees the item; everyone when omitted. */
  visible?: (c: NavContext) => boolean
}

export interface NavContext {
  isAdmin: boolean
  isManager: boolean
  /** The log's viewer setting lets this user read it (see CompanyContextValue). */
  canViewAgentEvents: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { segment: '', label: '概要', icon: SquaresFour },
  { segment: 'members', label: 'メンバー', icon: Users },
  { segment: 'departments', label: '部署', icon: TreeStructure },
  { segment: 'permissions', label: '権限', icon: ShieldCheck, visible: (c) => c.isAdmin || c.isManager },
  { segment: 'private-folders', label: '非公開フォルダ', icon: LockSimple, visible: (c) => c.isAdmin || c.isManager },
  { segment: 'security', label: 'セキュリティ', icon: LockKey, visible: (c) => c.isAdmin },
  { segment: 'agent-events', label: 'AI の操作の記録', icon: Robot, visible: (c) => c.isAdmin || c.canViewAgentEvents },
  { segment: 'agent-sandbox', label: 'AI の囲い', icon: Barricade, visible: (c) => c.isAdmin },
  { segment: 'api-keys', label: 'API キー', icon: Key, visible: (c) => c.isAdmin },
  { segment: 'settings', label: '会社の設定', icon: Gear, visible: (c) => c.isAdmin },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { company } = useCompany()

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <SidebarContent />
      </aside>

      {/* Tablet / phone: top bar + drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent>
          <SheetTitle>メニュー</SheetTitle>
          <SheetDescription>会社の切り替えとページ移動</SheetDescription>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileOpen(true)} aria-label="メニューを開く">
            <List size={18} />
          </Button>
          <span className="truncate text-sm font-medium">{company.data?.name ?? ''}</span>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { companyId, isAdmin, managedDepartmentIds, canViewAgentEvents } = useCompany()
  const navContext: NavContext = { isAdmin, isManager: managedDepartmentIds.length > 0, canViewAgentEvents }
  const base = `/companies/${companyId}`

  return (
    <div className="flex h-full flex-col">
      <div className={cn('p-3', onNavigate && 'pr-11')}>
        <CompanySwitcher onNavigate={onNavigate} />
      </div>
      <nav aria-label="メインメニュー" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {NAV_ITEMS.filter((item) => !item.visible || item.visible(navContext)).map((item) => {
          const href = item.segment ? `${base}/${item.segment}` : base
          const active = item.segment ? pathname.startsWith(href) : pathname === base
          const IconComponent = item.icon
          return (
            <Link
              key={item.segment}
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                active && 'bg-sidebar-accent font-medium text-sidebar-foreground'
              )}
            >
              <IconComponent size={18} weight={active ? 'fill' : 'regular'} />
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="border-t border-sidebar-border p-3">
        <UserMenu />
      </div>
    </div>
  )
}

function CompanySwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const { companyId, company, companies, role } = useCompany()

  if (!company.data) {
    return (
      <div className="flex items-center gap-2.5 px-1.5 py-1.5">
        <Skeleton className="size-8 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    )
  }

  const current = company.data
  // Keep the user on the same section when switching companies.
  const section = pathname.split('/')[3] ?? ''
  const go = (id: string) => {
    onNavigate?.()
    router.push(section ? `/companies/${id}/${section}` : `/companies/${id}`)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
          aria-label="会社を切り替える"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Buildings size={16} weight="fill" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold">{current.name}</span>
            <span className="block text-xs text-muted-foreground">{role ? roleLabel(role) : ''}</span>
          </span>
          <CaretUpDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>会社</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(companies.data ?? [current]).map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => c.id !== companyId && go(c.id)}>
              <Buildings />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.id === companyId && <Check className="!text-foreground" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            onNavigate?.()
            router.push('/companies/new')
          }}
        >
          <Plus />
          新しい会社を作成
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu() {
  const router = useRouter()
  const { user, signOut } = useAuth()
  const { theme, setTheme } = useTheme()
  if (!user) return null
  const display = user.name || user.email

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
          aria-label="アカウントメニュー"
        >
          <Avatar name={display} seed={user.id} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium">{display}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
          <CaretUpDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel>表示テーマ</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="system">
            <Desktop />
            システムに合わせる
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun />
            ライト
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon />
            ダーク
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await signOut()
            router.replace('/login')
          }}
        >
          <SignOut />
          ログアウト
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

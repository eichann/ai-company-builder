// The administrator guide's fictional company (manual-admin/README.md): 検証A社, whose owner is
// 高橋さん, with 佐藤さん (管理者, 総務部), 田中さん (the FDE, 管理者), 山田さん (営業部) and 小林さん (営業課長,
// 営業部's 部署の管理役). Every
// /api/* call the admin console makes during a shot is answered from a table built here
// (shoot.spec.ts); a call the table does not answer fails the shot, so a page never shows an
// error or an empty state the guide does not mean.
//
// The answers follow the API's contract (admin/src/lib/api.ts types, checked by `tsc`; the
// console's own schemas check them again at run time). Everything is made up: no real person,
// company, address or private folder.
import type {
  AdminHome,
  Capabilities,
  ClientActivity,
  Company,
  Department,
  Invitation,
  Member,
  SetupStepId,
  User,
} from '@/lib/api'

/** What the route table answers: a status (200 by default) and a JSON body. */
export interface Reply {
  status?: number
  body: unknown
}
/** "METHOD /api/path?query" (decoded) → the answer. */
export type Routes = Record<string, Reply>

export const COMPANY_ID = 'co_kensho'
export const API = `/api/companies/${COMPANY_ID}`
/** A page of the console for 検証A社. */
export const at = (path = '') => `/companies/${COMPANY_ID}${path}`

export const ok = <T>(data: T): Reply => ({ body: { success: true, data } })

const CREATED = '2026-10-01 01:00:00'

export const company: Company = {
  id: COMPANY_ID,
  name: '検証A社',
  slug: 'kensho-a',
  ownerId: 'u_takahashi',
  repoPath: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  role: 'owner',
  folderKind: 'git',
}

interface Person {
  userId: string
  name: string
  email: string
  role: Member['role']
}

export const people = {
  takahashi: { userId: 'u_takahashi', name: '高橋 健一', email: 'takahashi@kensho-a.example', role: 'owner' },
  sato: { userId: 'u_sato', name: '佐藤 美咲', email: 'sato@kensho-a.example', role: 'admin' },
  tanaka: { userId: 'u_tanaka', name: '田中 誠', email: 'tanaka@kensho-a.example', role: 'admin' },
  yamada: { userId: 'u_yamada', name: '山田 太郎', email: 'yamada@kensho-a.example', role: 'member' },
  kobayashi: { userId: 'u_kobayashi', name: '小林 直樹', email: 'kobayashi@kensho-a.example', role: 'member' },
  nakamura: { userId: 'u_nakamura', name: '中村 愛', email: 'nakamura@kensho-a.example', role: 'member' },
  ito: { userId: 'u_ito', name: '伊藤 さくら', email: 'ito@kensho-a.example', role: 'member' },
} satisfies Record<string, Person>

const everyone: Person[] = Object.values(people)

export const members: Member[] = everyone.map((p, i) => ({
  id: `m_${p.userId}`,
  userId: p.userId,
  companyId: COMPANY_ID,
  role: p.role,
  email: p.email,
  name: p.name,
  createdAt: `2026-10-0${1 + Math.min(i, 8)} 01:00:00`,
}))

function dept(id: string, name: string, icon: string, color: string, sortOrder: number): Department {
  return {
    id, companyId: COMPANY_ID, parentId: null, name, nameEn: null, folder: name, icon, color,
    description: null, sortOrder, isActive: true, createdAt: CREATED, updatedAt: CREATED, createdBy: people.takahashi.userId,
  }
}

export const departments: Department[] = [
  dept('d_sales', '営業部', 'Storefront', '#3b82f6', 0),
  dept('d_soumu', '総務部', 'Briefcase', '#10b981', 1),
  dept('d_shared', '全社共有', 'Buildings', '#8b5cf6', 2),
]

/** Who belongs to each department (所属) and its 部署の管理役. */
export const belongs: Record<string, Person[]> = {
  d_sales: [people.yamada, people.kobayashi],
  d_soumu: [people.sato, people.nakamura, people.ito],
  d_shared: [people.takahashi],
}
export const managers: Record<string, Person[]> = {
  d_sales: [people.kobayashi],
  d_soumu: [people.sato],
  d_shared: [],
}

const NEW_BUILD = { semver: '0.0.1', sha: 'a1b2c3d', commitDate: '20261119031200', dev: false }
const OLD_BUILD = { semver: '0.0.1', sha: '0f0f0f0', commitDate: '20261001000000', dev: false }

function activity(p: Person, build: ClientActivity['build'], seen = '2026-11-20T00:50:00.000Z'): ClientActivity {
  return {
    userId: p.userId, role: p.role, email: p.email, name: p.name,
    clientVersion: build ? `${build.semver}+${build.sha}.${build.commitDate}` : null,
    build, clientPlatform: 'darwin-arm64', lastSeenAt: seen,
    lastFetchAt: build ? '2026-11-20T00:45:00.000Z' : null,
    lastPushAt: build ? '2026-11-19T08:10:00.000Z' : null,
    supportsAgentEvents: build === NEW_BUILD,
  }
}

export const clientActivity: ClientActivity[] = [
  activity(people.takahashi, NEW_BUILD),
  activity(people.sato, NEW_BUILD),
  activity(people.tanaka, NEW_BUILD),
  activity(people.yamada, NEW_BUILD),
  activity(people.kobayashi, OLD_BUILD, '2026-11-18T06:00:00.000Z'),
  activity(people.nakamura, NEW_BUILD),
  activity(people.ito, NEW_BUILD),
]

export const invitations: Invitation[] = [{
  id: 'inv_1', companyId: COMPANY_ID, companyName: company.name, token: 'tok_manual_1', role: 'member',
  createdBy: people.tanaka.userId, createdByName: people.tanaka.name, createdByEmail: people.tanaka.email,
  usedBy: null, usedByName: null, usedByEmail: null, usedAt: null,
  expiresAt: '2026-11-27T01:00:00.000Z', createdAt: '2026-11-20T01:00:00.000Z',
  isExpired: false, isUsed: false, departmentIds: ['d_sales'],
}]

export const ownerCaps: Capabilities = { role: 'owner', managedDepartmentIds: [], canViewAgentEvents: true, skillEditing: { everywhere: true, folders: [] } }

/** The steps the server answers today (`minutes-folder` no longer: meetings need no folder since 2026-11-04). */
const STEPS = ['departments', 'members', 'department-members', 'google', 'holidays'] as const

/** 「最初にやること」 with only `done` done (in the server's order). */
export function setupWith(done: SetupStepId[]): NonNullable<AdminHome['setup']> {
  const steps = STEPS.map((id) => ({
    id, done: done.includes(id), ...(id === 'google' ? { byOperator: true } : {}),
  }))
  return { steps, done: done.length, total: steps.length }
}

/** The home once everything of 「最初にやること」 is done and nothing needs attention. */
export function home(over: Partial<AdminHome> = {}): AdminHome {
  return {
    view: 'admin',
    setup: {
      steps: STEPS.map((id) => ({
        id, done: true, ...(id === 'google' ? { byOperator: true } : {}),
      })),
      done: STEPS.length,
      total: STEPS.length,
    },
    departments: [],
    attention: {
      outdatedClients: [], unknownClients: [], notSyncedRecently: [], recentRejections: [],
      orphanedScopes: [], meetingDuplicates: 0, stoppedPlugins: [], securityAlerts: [],
    },
    counts: { members: members.length, departments: departments.length },
    ...over,
  }
}

export const signedIn: User = { id: people.takahashi.userId, email: people.takahashi.email, name: people.takahashi.name, canCreateCompany: false }

const config = ok({ name: 'AI Company Builder', version: '0.0.1', setupComplete: true, appDownloadUrl: null })

/** What every company page loads, signed in as 高橋さん (the owner). */
export function world(): Routes {
  const perDepartment = Object.fromEntries(departments.flatMap((d) => [
    [`GET ${API}/departments/${d.id}/managers`, ok({ managers: managers[d.id].map(({ userId, name, email }) => ({ userId, name, email })) })],
    [`GET ${API}/departments/${d.id}/members`, ok({ members: belongs[d.id].map(({ userId, name, email }) => ({ userId, name, email })), canEdit: true })],
  ]))
  return {
    'GET /api/me': ok(signedIn),
    'GET /api/config': config,
    'GET /api/companies': ok([company]),
    [`GET ${API}`]: ok(company),
    [`GET ${API}/me/capabilities`]: ok(ownerCaps),
    [`GET ${API}/members`]: ok(members),
    [`GET ${API}/departments?flat=true`]: ok(departments),
    [`GET ${API}/client-activity`]: ok(clientActivity),
    [`GET ${API}/invitations`]: ok(invitations),
    [`GET ${API}/home`]: ok(home()),
    ...perDepartment,
  }
}

/** Signed out: the sign-in page. */
export const signedOut: Routes = {
  'GET /api/me': { status: 401, body: { error: 'Unauthorized' } },
  'GET /api/config': config,
}

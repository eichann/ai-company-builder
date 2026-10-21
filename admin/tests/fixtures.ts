// Realistic API payloads following the server contract (server/src/routes/*),
// used by the tests and handy for building screens without a server.
import type {
  Capabilities,
  ClientActivity,
  Company,
  Department,
  Invitation,
  Member,
  EffectiveAccess,
  InheritedRules,
  Overview,
  PermissionScope,
  PushRejectionPage,
} from '@/lib/api'

export const COMPANY_ID = 'co_123'

export const company: Company = {
  id: COMPANY_ID,
  name: '株式会社サンプル',
  slug: 'sample',
  ownerId: 'u_owner',
  repoPath: '/app/data/repos/co_123.git',
  createdAt: '2026-09-01 02:00:00',
  updatedAt: '2026-09-01 02:00:00',
  role: 'owner',
}

export const members: Member[] = [
  { id: 'm1', userId: 'u_owner', companyId: COMPANY_ID, role: 'owner', email: 'sato@example.com', name: '佐藤 花子', createdAt: '2026-09-01 02:00:00' },
  { id: 'm2', userId: 'u_admin', companyId: COMPANY_ID, role: 'admin', email: 'suzuki@example.com', name: '鈴木 一郎', createdAt: '2026-09-02 02:00:00' },
  { id: 'm3', userId: 'u_member', companyId: COMPANY_ID, role: 'member', email: 'tanaka@example.com', name: '田中 太郎', createdAt: '2026-09-03 02:00:00' },
]

export const departments: Department[] = [
  dept('d_sales', '営業部', '営業部', 'Storefront', '#3b82f6', 0),
  dept('d_dev', '開発部', 'development', 'Code', '#10b981', 1),
  dept('d_hr', '人事部', '人事部', 'Users', '#ec4899', 2),
]

function dept(id: string, name: string, folder: string, icon: string, color: string, sortOrder: number): Department {
  return {
    id,
    companyId: COMPANY_ID,
    parentId: null,
    name,
    nameEn: null,
    folder,
    icon,
    color,
    description: null,
    sortOrder,
    isActive: true,
    createdAt: '2026-09-01 02:00:00',
    updatedAt: '2026-09-01 02:00:00',
    createdBy: 'u_owner',
  }
}

export const managers: Record<string, Array<{ userId: string; name: string; email: string }>> = {
  d_sales: [{ userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com' }],
  d_dev: [],
  d_hr: [],
}

export const ownerCapabilities: Capabilities = { role: 'owner', managedDepartmentIds: [] }
export const managerCapabilities: Capabilities = { role: 'member', managedDepartmentIds: ['d_sales'] }

export const clientActivity: ClientActivity[] = [
  activity('u_owner', '0.0.1+95346af.20261021031200', { semver: '0.0.1', sha: '95346af', commitDate: '20261021031200', dev: false }),
  activity('u_admin', '0.0.1+1111111.20261001000000', { semver: '0.0.1', sha: '1111111', commitDate: '20261001000000', dev: false }),
  { ...activity('u_member', null, null), lastSeenAt: '2026-10-20T08:00:00.000Z' },
]

function activity(userId: string, clientVersion: string | null, build: ClientActivity['build']): ClientActivity {
  const m = members.find((x) => x.userId === userId)!
  return {
    userId,
    role: m.role,
    email: m.email,
    name: m.name,
    clientVersion,
    build,
    clientPlatform: 'darwin-arm64',
    lastSeenAt: '2026-10-21T08:00:00.000Z',
    lastFetchAt: '2026-10-21T07:55:00.000Z',
    lastPushAt: '2026-10-20T07:55:00.000Z',
  }
}

export const quietOverview: Overview = {
  memberCount: 3,
  departmentCount: 3,
  attention: { outdatedClients: [], unknownClients: [], notSyncedRecently: [], recentRejections: [] },
}

export const busyOverview: Overview = {
  memberCount: 3,
  departmentCount: 3,
  attention: {
    outdatedClients: [
      {
        userId: 'u_admin',
        name: '鈴木 一郎',
        email: 'suzuki@example.com',
        role: 'admin',
        clientVersion: '0.0.1+1111111.20261001000000',
        lastSeenAt: '2026-10-21T08:00:00.000Z',
        lastFetchAt: '2026-10-21T07:55:00.000Z',
        lastPushAt: null,
      },
    ],
    unknownClients: [
      {
        userId: 'u_member',
        name: '田中 太郎',
        email: 'tanaka@example.com',
        role: 'member',
        clientVersion: null,
        lastSeenAt: '2026-10-20T08:00:00.000Z',
        lastFetchAt: null,
        lastPushAt: null,
      },
    ],
    notSyncedRecently: [],
    recentRejections: [
      {
        id: 'r1',
        userId: 'u_member',
        name: '田中 太郎',
        marker: 'PROTECTED_CONFIG',
        paths: ['.claude/settings.json'],
        createdAt: '2026-10-21T06:00:00.000Z',
      },
      {
        id: 'r2',
        userId: 'u_member',
        name: '田中 太郎',
        marker: 'SOMETHING_NEW',
        paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt'],
        createdAt: '2026-10-21T05:00:00.000Z',
      },
    ],
  },
}

const ROOT_RULES: InheritedRules = { scopeId: 's_company', path: '', rules: [{ id: 'r_everyone', subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: true, canWrite: true }], summary: 'everyone-rw' }

export const permissionScopes: PermissionScope[] = [
  {
    id: 's_company',
    path: '',
    kind: 'company',
    departmentId: null,
    repoId: null,
    inherited: false,
    rules: [{ id: 'r_everyone', subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: true, canWrite: true }],
    effectiveSummary: 'everyone-rw',
    inheritedFrom: null,
  },
  { id: 's_sales', path: '営業部', kind: 'department', departmentId: 'd_sales', repoId: null, inherited: true, rules: [], effectiveSummary: 'everyone-rw', inheritedFrom: ROOT_RULES },
  {
    id: 's_sales_contracts',
    path: '営業部/契約書',
    kind: 'folder',
    departmentId: 'd_sales',
    repoId: null,
    inherited: false,
    rules: [
      { id: 'r_contracts_everyone', subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: true, canWrite: false },
      { id: 'r_contracts_tanaka', subjectType: 'user', subjectId: 'u_member', subjectLabel: '田中 太郎', canRead: true, canWrite: true },
    ],
    effectiveSummary: 'everyone-r',
    inheritedFrom: ROOT_RULES,
  },
  { id: 's_dev', path: 'development', kind: 'department', departmentId: 'd_dev', repoId: null, inherited: true, rules: [], effectiveSummary: 'everyone-rw', inheritedFrom: ROOT_RULES },
]

export const invitations: Invitation[] = [
  {
    id: 'inv1',
    companyId: COMPANY_ID,
    companyName: company.name,
    token: 'tok_pending',
    role: 'member',
    createdBy: 'u_owner',
    createdByName: '佐藤 花子',
    createdByEmail: 'sato@example.com',
    usedBy: null,
    usedByName: null,
    usedByEmail: null,
    usedAt: null,
    expiresAt: '2026-10-28T00:00:00.000Z',
    createdAt: '2026-10-21T00:00:00.000Z',
    isExpired: false,
    isUsed: false,
  },
]

export function effectiveAt(path: string, governing: string, writers: string[]): EffectiveAccess {
  return {
    path,
    governingScope: { id: `s_${governing || 'company'}`, path: governing, inherited: governing !== path },
    readRestrictionEnforced: false,
    members: members.map((m) => {
      const full = m.role !== 'member'
      return {
        userId: m.userId,
        name: m.name,
        email: m.email,
        role: m.role,
        read: true,
        write: full || writers.includes(m.userId),
        reason: full ? 'role' : 'rule',
        decidedBy: full ? null : { scopeId: 's', path: governing, subjectType: 'everyone', subjectLabel: '全員' },
      }
    }),
  }
}

export const rejectionPage: PushRejectionPage = {
  total: 3,
  markers: ['PROTECTED_CONFIG', 'SECRET_DETECTED', 'SOMETHING_NEW'],
  rejections: [
    { id: 'pr1', userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com', marker: 'SECRET_DETECTED', paths: ['営業部/顧客.env', 'a.txt', 'b.txt', 'c.txt'], createdAt: '2026-10-21T06:00:00.000Z' },
    { id: 'pr2', userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com', marker: 'PROTECTED_CONFIG', paths: ['.mcp.json'], createdAt: '2026-10-20T06:00:00.000Z' },
  ],
}

export const ok = <T,>(data: T) => ({ success: true, data })

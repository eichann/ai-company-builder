// Use relative path - Next.js rewrites will proxy to API server
const API_BASE = ''

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  headers?: Record<string, string>
}

export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, headers = {} } = options

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || error.message || 'Request failed')
  }

  return res.json()
}

// Auth API
export const authApi = {
  signIn: (email: string, password: string) =>
    apiClient('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email, password },
    }),

  signUp: (email: string, password: string, name: string, invitationToken?: string) =>
    apiClient('/api/auth/sign-up/email', {
      method: 'POST',
      body: { email, password, name },
      headers: invitationToken ? { 'X-Invitation-Token': invitationToken } : {},
    }),

  signOut: () =>
    apiClient('/api/auth/sign-out', { method: 'POST', body: {} }),

  getSession: () =>
    apiClient<{ user: User | null }>('/api/auth/get-session'),
}

// User types
export interface User {
  id: string
  email: string
  name: string | null
  createdAt: string
}

// Me API
export const meApi = {
  getMe: () => apiClient<{ success: boolean; data: User }>('/api/me'),
}

// Company types
export interface Company {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  createdAt: string
  updatedAt: string
  role?: string
}

export interface Member {
  id: string
  userId: string
  companyId: string
  role: string
  email: string | null
  name: string | null
  createdAt: string
}

// Companies API
export const companiesApi = {
  list: () =>
    apiClient<{ success: boolean; data: Company[] }>('/api/companies'),

  create: (name: string, slug: string) =>
    apiClient<{ success: boolean; data: Company }>('/api/companies', {
      method: 'POST',
      body: { name, slug },
    }),

  get: (id: string) =>
    apiClient<{ success: boolean; data: Company }>(`/api/companies/${id}`),

  getMembers: (id: string) =>
    apiClient<{ success: boolean; data: Member[] }>(`/api/companies/${id}/members`),

  inviteMember: (id: string, email: string, role: string = 'member') =>
    apiClient<{ success: boolean; data: Member }>(`/api/companies/${id}/members`, {
      method: 'POST',
      body: { email, role },
    }),

  removeMember: (companyId: string, userId: string) =>
    apiClient(`/api/companies/${companyId}/members/${userId}`, {
      method: 'DELETE',
    }),
}

// SSH Keys API
export interface SSHKey {
  id: string
  fingerprint: string
  deviceName: string | null
  isActive: boolean
  lastUsedAt: string | null
  createdAt: string
}

export const sshKeysApi = {
  list: () =>
    apiClient<{ success: boolean; data: SSHKey[] }>('/api/users/me/ssh-keys'),

  register: (publicKey: string, deviceName?: string) =>
    apiClient<{ success: boolean; data: SSHKey }>('/api/users/me/ssh-keys', {
      method: 'POST',
      body: { publicKey, deviceName },
    }),

  delete: (id: string) =>
    apiClient(`/api/users/me/ssh-keys/${id}`, { method: 'DELETE' }),
}

// Invitation types
export interface Invitation {
  id: string
  companyId: string
  companyName: string
  token: string
  role: string
  createdBy: string
  createdByName: string | null
  createdByEmail: string | null
  usedBy: string | null
  usedByName: string | null
  usedByEmail: string | null
  usedAt: string | null
  expiresAt: string
  createdAt: string
  isExpired: boolean
  isUsed: boolean
}

// Invitations API
export const invitationsApi = {
  list: (companyId: string) =>
    apiClient<{ success: boolean; data: Invitation[] }>(`/api/companies/${companyId}/invitations`),

  create: (companyId: string, role: string = 'member', expiresInDays: number = 7) =>
    apiClient<{ success: boolean; data: Invitation }>(`/api/companies/${companyId}/invitations`, {
      method: 'POST',
      body: { role, expiresInDays },
    }),

  delete: (companyId: string, invitationId: string) =>
    apiClient(`/api/companies/${companyId}/invitations/${invitationId}`, {
      method: 'DELETE',
    }),

  validate: (token: string) =>
    apiClient<{ success: boolean; data: { companyName: string; role: string; expiresAt: string } }>(`/api/invitations/${token}`),

  accept: (token: string) =>
    apiClient<{ success: boolean; data: { companyId: string; companyName: string; role: string } }>(`/api/invitations/${token}/accept`, {
      method: 'POST',
    }),
}

// Department types
export interface Department {
  id: string
  companyId: string
  parentId: string | null
  name: string
  nameEn: string | null
  folder: string
  icon: string
  color: string
  description: string | null
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface DepartmentWithChildren extends Department {
  children: DepartmentWithChildren[]
  depth: number
  path: string
}

export interface CreateDepartmentInput {
  parentId?: string | null
  name: string
  nameEn?: string
  folder: string
  icon?: string
  color?: string
  description?: string
}

export interface UpdateDepartmentInput {
  name?: string
  nameEn?: string | null
  folder?: string
  icon?: string
  color?: string
  description?: string | null
  isActive?: boolean
}

export interface ReorderDepartmentItem {
  id: string
  sortOrder: number
}

// Departments API
export const departmentsApi = {
  list: (companyId: string, flat: boolean = false) =>
    apiClient<{ success: boolean; data: Department[] | DepartmentWithChildren[] }>(
      `/api/companies/${companyId}/departments${flat ? '?flat=true' : ''}`
    ),

  get: (companyId: string, departmentId: string) =>
    apiClient<{ success: boolean; data: Department }>(`/api/companies/${companyId}/departments/${departmentId}`),

  create: (companyId: string, data: CreateDepartmentInput) =>
    apiClient<{ success: boolean; data: Department }>(`/api/companies/${companyId}/departments`, {
      method: 'POST',
      body: data,
    }),

  update: (companyId: string, departmentId: string, data: UpdateDepartmentInput) =>
    apiClient<{ success: boolean; data: Department }>(`/api/companies/${companyId}/departments/${departmentId}`, {
      method: 'PUT',
      body: data,
    }),

  delete: (companyId: string, departmentId: string) =>
    apiClient<{ success: boolean; deletedFiles?: number; deletedFolders?: number }>(`/api/companies/${companyId}/departments/${departmentId}`, {
      method: 'DELETE',
    }),

  reorder: (companyId: string, items: ReorderDepartmentItem[]) =>
    apiClient<{ success: boolean }>(`/api/companies/${companyId}/departments/reorder`, {
      method: 'POST',
      body: { items },
    }),

  stats: (companyId: string, departmentId: string) =>
    apiClient<{ success: boolean; data: { files: number; folders: number; exists: boolean } }>(
      `/api/companies/${companyId}/departments/${departmentId}/stats`
    ),

  sync: (companyId: string) =>
    apiClient<{ success: boolean; added: number; removed: number }>(`/api/companies/${companyId}/departments/sync`, {
      method: 'POST',
    }),
}

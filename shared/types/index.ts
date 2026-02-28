// User and Auth Types
export interface User {
  id: string
  email: string
  name: string
  createdAt: Date
  updatedAt: Date
}

export interface Session {
  id: string
  userId: string
  expiresAt: Date
}

// Company Types
export interface Company {
  id: string
  name: string
  ownerId: string
  createdAt: Date
  updatedAt: Date
}

export interface CompanyMember {
  id: string
  companyId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  joinedAt: Date
}

// Permission Types
export interface Permission {
  id: string
  userId: string
  companyId: string
  path: string
  canRead: boolean
  canWrite: boolean
}

// File Types
export interface FileMetadata {
  path: string
  name: string
  isDirectory: boolean
  size?: number
  modifiedAt?: Date
  hash?: string
}

export interface SyncRequest {
  companyId: string
  lastSyncAt?: Date
}

export interface SyncResponse {
  files: FileMetadata[]
  deletedPaths: string[]
  syncedAt: Date
}

// Agent Types
export interface AgentConfig {
  name: string
  description: string
  skills: string[]
  version?: string
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
}

// Department Types
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
  path: string // Full folder path like "sales/domestic/tokyo"
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
  nameEn?: string
  folder?: string
  icon?: string
  color?: string
  description?: string
  sortOrder?: number
  isActive?: boolean
}

export interface ReorderDepartmentItem {
  id: string
  parentId: string | null
  sortOrder: number
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

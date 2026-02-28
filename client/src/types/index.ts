export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
  expanded?: boolean
}

export interface Company {
  id: string
  name: string
  rootPath: string
  departments: Department[]
  createdAt: Date
}

export interface Department {
  id: string
  name: string
  path: string
  hasAgent: boolean
}

export interface DepartmentTemplate {
  id: string
  name: string
  displayName: string
  description: string
  defaultFolders: string[]
  agentConfig?: AgentConfig
}

export interface AgentConfig {
  name: string
  description: string
  skills: string[]
}

// New SKILL-centric types
export interface DepartmentConfig {
  id: string
  name: string
  folder: string
  icon: string
  color: string
  description: string
}

// Tool (Web app) in a SKILL
export interface SkillTool {
  name: string           // Folder name (e.g., "movie-studio")
  displayName: string    // From package.json name or folder name
  path: string           // Absolute path to tool directory
  hasPackageJson: boolean
  startCommand?: string  // "dev" or "start"
  port?: number          // If running, the port number
}

export interface Skill {
  id: string
  name: string
  description: string
  icon?: string
  departmentId: string
  isPrivate?: boolean     // true = .gitignore に含まれ同期されない（不可逆: 公開したら戻せない）
  isNurturing?: boolean   // true = 育て中（SKILL.md frontmatter status: nurturing）
  skillPath?: string      // Absolute path to skill directory
  // File paths relative to department folder
  files: {
    skillMd?: string      // SKILL.md
    rules?: string[]      // Rule files
    references?: string[] // Reference files
    scripts?: string[]    // Script files
    tools?: SkillTool[]   // Web app tools
  }
}

export interface SkillExecution {
  skillId: string
  status: 'idle' | 'running' | 'completed' | 'error'
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: Date
  }>
}

export const DEPARTMENT_TEMPLATES: DepartmentTemplate[] = [
  {
    id: 'common',
    name: 'shared',
    displayName: '全社共通',
    description: '会社理念、ビジョン、共通ルール',
    defaultFolders: ['rules', 'templates', 'guidelines'],
    agentConfig: {
      name: 'Company Agent',
      description: '会社全体の共通ルールやガイドラインを管理するエージェント',
      skills: ['ルール確認', 'テンプレート提供', 'ガイドライン説明']
    }
  },
  {
    id: 'hr',
    name: 'hr',
    displayName: 'HR (Human Resources)',
    description: 'Recruitment, Training, Evaluation',
    defaultFolders: ['recruiting', 'training', 'evaluations', 'payroll'],
    agentConfig: {
      name: 'HR Agent',
      description: 'AI agent supporting HR operations',
      skills: ['Interview scheduling', 'Training material creation', 'Evaluation sheet creation']
    }
  },
  {
    id: 'sales',
    name: 'sales',
    displayName: 'Sales',
    description: 'Customer relations, Proposals, Contracts',
    defaultFolders: ['customer-list', 'proposals', 'contracts', 'daily-reports'],
    agentConfig: {
      name: 'Sales Agent',
      description: 'AI agent supporting sales activities',
      skills: ['Proposal creation', 'Daily report writing', 'Customer analysis']
    }
  },
  {
    id: 'dev',
    name: 'development',
    displayName: 'Development',
    description: 'Product development, Technical management',
    defaultFolders: ['specifications', 'documents', 'sprints', 'reviews'],
    agentConfig: {
      name: 'Dev Agent',
      description: 'AI agent supporting development operations',
      skills: ['Specification review', 'Code review', 'Technical research']
    }
  },
  {
    id: 'finance',
    name: 'accounting',
    displayName: 'Accounting',
    description: 'Finance, Accounting, Budget management',
    defaultFolders: ['invoices', 'expenses', 'budget', 'reports'],
    agentConfig: {
      name: 'Finance Agent',
      description: 'AI agent supporting accounting operations',
      skills: ['Expense processing', 'Budget report creation', 'Invoice processing']
    }
  },
  {
    id: 'general',
    name: 'general',
    displayName: 'General Affairs',
    description: 'Internal management, Facilities',
    defaultFolders: ['approvals', 'supplies', 'facility-booking', 'announcements'],
    agentConfig: {
      name: 'General Agent',
      description: 'AI agent supporting general affairs',
      skills: ['Approval document creation', 'Room booking', 'Internal announcements']
    }
  },
]

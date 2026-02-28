import { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import type { Company, Department } from '../../types'
import { DEPARTMENT_TEMPLATES } from '../../types'
import {
  Buildings,
  Plus,
  ArrowRight,
  SpinnerGap,
  SignOut,
  FolderOpen,
  CloudArrowDown,
  Check,
  GitBranch,
  CheckCircle,
} from '@phosphor-icons/react'

interface ServerCompany {
  id: string
  name: string
  slug: string
  ownerId: string
  repoPath: string | null
  role: string
  createdAt: string
  updatedAt: string
}

type ViewMode = 'list' | 'create' | 'clone' | 'openExisting' | 'setup'
type SetupStep = 'folder' | 'git' | 'done'

export function CompanySelector() {
  const { addCompany } = useAppStore()
  const { user, signOut } = useAuthStore()
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [companies, setCompanies] = useState<ServerCompany[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // For creating new company
  const [newCompanyName, setNewCompanyName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // For cloning
  const [selectedCompany, setSelectedCompany] = useState<ServerCompany | null>(null)
  const [localPath, setLocalPath] = useState('')
  const [isCloning, _setIsCloning] = useState(false)

  // For setup progress
  const [setupStep, setSetupStep] = useState<SetupStep>('folder')
  const [setupError, setSetupError] = useState<string | null>(null)

  useEffect(() => {
    loadCompanies()
  }, [])

  async function loadCompanies() {
    setIsLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.getCompanies()
      if (result.success && result.data) {
        setCompanies(result.data)
      } else {
        setError(result.error || 'Failed to load companies')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleCreateCompany() {
    if (!newCompanyName.trim()) return

    setIsCreating(true)
    setError(null)
    try {
      const result = await window.electronAPI.createCompany(newCompanyName.trim())
      if (result.success && result.data) {
        // Add to list and select it
        setCompanies([result.data, ...companies])
        setSelectedCompany(result.data)
        setViewMode('clone')
        setNewCompanyName('')
      } else {
        setError(result.error || 'Failed to create company')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setIsCreating(false)
    }
  }

  async function handleSelectDirectory() {
    const path = await window.electronAPI.selectDirectory()
    if (path) {
      setLocalPath(path)
    }
  }

  async function handleOpenExistingFolder() {
    if (!selectedCompany) return

    const path = await window.electronAPI.selectDirectory()
    if (!path) return

    setLocalPath(path)
    setViewMode('setup')
    setSetupStep('folder')
    setSetupError(null)

    try {
      // Read existing departments from the folder
      const entries = await window.electronAPI.readDirectory(path)
      const departments: Department[] = []

      for (const entry of entries) {
        if (entry.isDirectory && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          const hasAgentMd = await window.electronAPI.exists(`${entry.path}/AGENT.md`)
          const template = DEPARTMENT_TEMPLATES.find((t) => t.name === entry.name)

          departments.push({
            id: template?.id || entry.name.toLowerCase(),
            name: entry.name,
            path: entry.path,
            hasAgent: hasAgentMd,
          })
        }
      }

      // Setup git remote (optional)
      setSetupStep('git')
      const gitResult = await window.electronAPI.gitSetupCompanyRemote(path, selectedCompany.id)
      if (!gitResult.success) {
        console.warn('Failed to setup git remote:', gitResult.error)
      }

      // Done!
      setSetupStep('done')
      await new Promise(resolve => setTimeout(resolve, 500))

      // Create company object
      const company: Company = {
        id: selectedCompany.id,
        name: selectedCompany.name,
        rootPath: path,
        departments,
        createdAt: new Date(selectedCompany.createdAt),
      }

      addCompany(company)
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : 'Unknown error')
    }
  }

  async function handleSetupCompany() {
    if (!selectedCompany || !localPath) return

    setViewMode('setup')
    setSetupStep('folder')
    setSetupError(null)

    try {
      // Step 1: Create folder
      const companyPath = `${localPath}/${selectedCompany.name}`

      // Create directory if it doesn't exist
      await window.electronAPI.createDirectory(companyPath)

      // Step 3: Setup git remote — this will clone if remote has content
      setSetupStep('git')
      const gitResult = await window.electronAPI.gitSetupCompanyRemote(companyPath, selectedCompany.id)
      if (!gitResult.success) {
        console.warn('Failed to setup git remote:', gitResult.error)
        // Continue anyway - git setup is optional
      }

      // Step 4: Read departments from folder (may be cloned from server or empty)
      setSetupStep('folder')
      const entries = await window.electronAPI.readDirectory(companyPath)
      const departments: Department[] = []

      for (const entry of entries) {
        if (entry.isDirectory && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          const hasAgentMd = await window.electronAPI.exists(`${entry.path}/AGENT.md`)
          const template = DEPARTMENT_TEMPLATES.find((t) => t.name === entry.name)

          departments.push({
            id: template?.id || entry.name.toLowerCase(),
            name: entry.name,
            path: entry.path,
            hasAgent: hasAgentMd,
          })
        }
      }

      // If no departments (empty remote / owner's first setup), create defaults
      if (departments.length === 0) {
        const defaultDepts = ['sales', 'hr', 'general']
        for (const deptId of defaultDepts) {
          const template = DEPARTMENT_TEMPLATES.find((t) => t.id === deptId)
          if (!template) continue

          const deptPath = `${companyPath}/${template.name}`
          await window.electronAPI.createDirectory(deptPath)

          // Create subdirectories
          for (const folder of template.defaultFolders) {
            await window.electronAPI.createDirectory(`${deptPath}/${folder}`)
          }

          // Create AGENT.md
          if (template.agentConfig) {
            const agentMd = `# ${template.agentConfig.name}\n\n${template.agentConfig.description}\n\n## Skills\n\n${template.agentConfig.skills.map(s => `- ${s}`).join('\n')}\n`
            await window.electronAPI.writeFile(`${deptPath}/AGENT.md`, agentMd)
          }

          departments.push({
            id: deptId,
            name: template.name,
            path: deptPath,
            hasAgent: !!template.agentConfig,
          })
        }
      }

      // Done!
      setSetupStep('done')

      // Short delay to show completion
      await new Promise(resolve => setTimeout(resolve, 500))

      // Create company object
      const company: Company = {
        id: selectedCompany.id,
        name: selectedCompany.name,
        rootPath: companyPath,
        departments,
        createdAt: new Date(selectedCompany.createdAt),
      }

      addCompany(company)
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : 'Unknown error')
    }
  }

  async function handleSignOut() {
    await signOut()
  }

  if (isLoading) {
    return (
      <div className="h-full bg-editor-bg flex items-center justify-center">
        <SpinnerGap size={48} className="animate-spin text-accent" />
      </div>
    )
  }

  return (
    <div className="h-full bg-editor-bg flex items-center justify-center">
      <div className="w-full max-w-xl p-8">
        {/* Header with user info */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
              <span className="text-accent font-medium">
                {user?.name?.[0] || user?.email?.[0] || '?'}
              </span>
            </div>
            <div>
              <div className="text-text-primary font-medium">
                {user?.name || user?.email}
              </div>
              {user?.name && (
                <div className="text-sm text-text-secondary">{user.email}</div>
              )}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-sidebar-bg transition-colors"
          >
            <SignOut size={18} />
            <span className="text-sm">ログアウト</span>
          </button>
        </div>

        {viewMode === 'list' && (
          <div className="space-y-6">
            <div className="text-center">
              <Buildings size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                会社を選択
              </h1>
              <p className="text-text-secondary">
                作業する会社を選択するか、新しく作成してください
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-3">
              {companies.map((company) => (
                <button
                  key={company.id}
                  onClick={() => {
                    setSelectedCompany(company)
                    setViewMode('clone')
                  }}
                  className="w-full flex items-center justify-between p-4 rounded-lg border border-border hover:border-accent/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                      <Buildings size={20} className="text-accent" weight="duotone" />
                    </div>
                    <div>
                      <div className="font-medium text-text-primary">{company.name}</div>
                      <div className="text-sm text-text-secondary">
                        {company.role === 'owner' ? 'オーナー' : 'メンバー'}
                      </div>
                    </div>
                  </div>
                  <ArrowRight size={20} className="text-text-secondary" />
                </button>
              ))}

              {companies.length === 0 && (
                <div className="text-center py-8 text-text-secondary">
                  まだ会社がありません。新しく作成してください。
                </div>
              )}

              <button
                onClick={() => setViewMode('create')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-dashed border-border hover:border-accent/50 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                  <Plus size={20} className="text-accent" />
                </div>
                <div>
                  <div className="font-medium text-text-primary">新しい会社を作成</div>
                  <div className="text-sm text-text-secondary">
                    AIエージェントと一緒に働く会社を作りましょう
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}

        {viewMode === 'create' && (
          <div className="space-y-6">
            <div className="text-center">
              <Plus size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                新しい会社を作成
              </h1>
              <p className="text-text-secondary">
                会社名を入力してください
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm text-text-secondary mb-2">
                会社名
              </label>
              <input
                type="text"
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                placeholder="例: 株式会社サンプル"
                className="w-full bg-sidebar-bg border border-border rounded-lg px-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
                autoFocus
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setViewMode('list')
                  setError(null)
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
              >
                戻る
              </button>
              <button
                onClick={handleCreateCompany}
                disabled={!newCompanyName.trim() || isCreating}
                className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors"
              >
                {isCreating ? (
                  <SpinnerGap size={20} className="animate-spin" />
                ) : (
                  <>
                    作成
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {viewMode === 'clone' && selectedCompany && (
          <div className="space-y-6">
            <div className="text-center">
              <FolderOpen size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                {selectedCompany.name}
              </h1>
              <p className="text-text-secondary">
                作業フォルダを選択してください
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-3">
              {/* Open existing folder option */}
              <button
                onClick={handleOpenExistingFolder}
                className="w-full flex items-center justify-between p-4 rounded-lg border border-border hover:border-accent/50 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                    <FolderOpen size={20} className="text-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-text-primary">既存のフォルダを開く</div>
                    <div className="text-sm text-text-secondary">
                      すでにある作業フォルダを選択
                    </div>
                  </div>
                </div>
                <ArrowRight size={20} className="text-text-secondary" />
              </button>

              {/* Create new folder option */}
              <button
                onClick={() => setViewMode('openExisting')}
                className="w-full flex items-center justify-between p-4 rounded-lg border border-dashed border-border hover:border-accent/50 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                    <CloudArrowDown size={20} className="text-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-text-primary">新しく作成</div>
                    <div className="text-sm text-text-secondary">
                      新しいフォルダを作成してセットアップ
                    </div>
                  </div>
                </div>
                <ArrowRight size={20} className="text-text-secondary" />
              </button>
            </div>

            <button
              onClick={() => {
                setViewMode('list')
                setSelectedCompany(null)
                setLocalPath('')
                setError(null)
              }}
              className="w-full flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
            >
              戻る
            </button>
          </div>
        )}

        {viewMode === 'openExisting' && selectedCompany && (
          <div className="space-y-6">
            <div className="text-center">
              <CloudArrowDown size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                作業フォルダを設定
              </h1>
              <p className="text-text-secondary">
                「{selectedCompany.name}」のローカル作業フォルダを選択してください
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <button
                onClick={handleSelectDirectory}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  localPath
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <FolderOpen size={24} className="text-accent" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-text-primary">
                      {localPath ? 'フォルダを選択済み' : 'フォルダを選択'}
                    </div>
                    <div className="text-sm text-text-secondary truncate">
                      {localPath || '作業フォルダの親ディレクトリを選択...'}
                    </div>
                  </div>
                  {localPath && <Check size={20} className="text-accent" />}
                </div>
              </button>

              {localPath && (
                <div className="p-3 rounded-lg bg-sidebar-bg text-sm">
                  <div className="text-text-secondary mb-1">作成されるフォルダ:</div>
                  <div className="text-text-primary font-mono">
                    {localPath}/{selectedCompany.name}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setViewMode('clone')
                  setLocalPath('')
                  setError(null)
                }}
                className="flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
              >
                戻る
              </button>
              <button
                onClick={handleSetupCompany}
                disabled={!localPath || isCloning}
                className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors"
              >
                {isCloning ? (
                  <SpinnerGap size={20} className="animate-spin" />
                ) : (
                  <>
                    開始
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {viewMode === 'setup' && (
          <div className="space-y-8">
            <div className="text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-accent/10 flex items-center justify-center">
                {setupStep === 'done' ? (
                  <CheckCircle size={40} className="text-green-400" weight="fill" />
                ) : (
                  <SpinnerGap size={40} className="animate-spin text-accent" />
                )}
              </div>
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                {setupStep === 'done' ? 'セットアップ完了' : 'セットアップ中...'}
              </h1>
              <p className="text-text-secondary">
                {setupStep === 'done' ? '準備が整いました' : '初回のみ・すぐに完了します'}
              </p>
            </div>

            {setupError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {setupError}
                <button
                  onClick={() => {
                    setViewMode('clone')
                    setSetupError(null)
                  }}
                  className="block mt-2 text-accent hover:underline"
                >
                  戻る
                </button>
              </div>
            )}

            <div className="space-y-3">
              {/* Folder Step */}
              <div className={`flex items-center gap-3 p-3 rounded-lg ${
                setupStep === 'folder' ? 'bg-accent/10 border border-accent/30' : 'bg-sidebar-bg'
              }`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  setupStep === 'folder' ? 'bg-accent' :
                  ['git', 'done'].includes(setupStep) ? 'bg-green-500' : 'bg-zinc-700'
                }`}>
                  {setupStep === 'folder' ? (
                    <SpinnerGap size={16} className="animate-spin text-white" />
                  ) : ['git', 'done'].includes(setupStep) ? (
                    <Check size={16} className="text-white" weight="bold" />
                  ) : (
                    <FolderOpen size={16} className="text-zinc-400" />
                  )}
                </div>
                <div>
                  <div className="text-text-primary font-medium">フォルダ構造を作成</div>
                  <div className="text-sm text-text-secondary">部署フォルダの初期化</div>
                </div>
              </div>

              {/* Git Step */}
              <div className={`flex items-center gap-3 p-3 rounded-lg ${
                setupStep === 'git' ? 'bg-accent/10 border border-accent/30' : 'bg-sidebar-bg'
              }`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  setupStep === 'git' ? 'bg-accent' :
                  setupStep === 'done' ? 'bg-green-500' : 'bg-zinc-700'
                }`}>
                  {setupStep === 'git' ? (
                    <SpinnerGap size={16} className="animate-spin text-white" />
                  ) : setupStep === 'done' ? (
                    <Check size={16} className="text-white" weight="bold" />
                  ) : (
                    <GitBranch size={16} className="text-zinc-400" />
                  )}
                </div>
                <div>
                  <div className="text-text-primary font-medium">同期設定</div>
                  <div className="text-sm text-text-secondary">サーバーとの接続を確立</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

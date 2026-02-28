import { useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { DEPARTMENT_TEMPLATES, type DepartmentTemplate, type Company, type Department } from '../../types'
import {
  Buildings,
  FolderSimple,
  FolderOpen,
  Check,
  ArrowRight,
  ArrowLeft,
  Sparkle,
  Robot,
  Users,
  CurrencyCircleDollar,
  Code,
  Gear,
} from '@phosphor-icons/react'

type WizardStep = 'start' | 'name' | 'location' | 'departments' | 'creating'

const DEPARTMENT_ICONS: Record<string, React.ReactNode> = {
  hr: <Users size={24} />,
  sales: <CurrencyCircleDollar size={24} />,
  dev: <Code size={24} />,
  finance: <CurrencyCircleDollar size={24} />,
  general: <Gear size={24} />,
}

export function CompanyWizard() {
  const { addCompany } = useAppStore()
  const [step, setStep] = useState<WizardStep>('start')
  const [companyName, setCompanyName] = useState('')
  const [location, setLocation] = useState('')
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([
    'hr',
    'sales',
    'general',
  ])
  const [isOpening, setIsOpening] = useState(false)

  async function handleOpenExisting() {
    const path = await window.electronAPI.selectDirectory()
    if (!path) return

    setIsOpening(true)

    try {
      // Read directory to find departments
      const entries = await window.electronAPI.readDirectory(path)
      const departments: Department[] = []

      // Extract company name from path
      const pathParts = path.split('/')
      const folderName = pathParts[pathParts.length - 1]

      for (const entry of entries) {
        if (entry.isDirectory && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          // Check if this is a department folder (has AGENT.md or is a known department)
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

      const company: Company = {
        id: Date.now().toString(),
        name: folderName,
        rootPath: path,
        departments,
        createdAt: new Date(),
      }

      addCompany(company)
    } catch (error) {
      console.error('Failed to open existing company:', error)
    } finally {
      setIsOpening(false)
    }
  }

  async function handleSelectLocation() {
    const path = await window.electronAPI.selectDirectory()
    if (path) {
      setLocation(path)
    }
  }

  async function handleUseDefault() {
    const documentsPath = await window.electronAPI.getDocumentsPath()
    setLocation(`${documentsPath}/AI Company Builder`)
  }

  function toggleDepartment(id: string) {
    setSelectedDepartments((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    )
  }

  async function createCompany() {
    setStep('creating')

    const rootPath = `${location}/${companyName}`

    // Create root directory
    await window.electronAPI.createDirectory(rootPath)

    // Create departments
    const departments: Department[] = []

    for (const deptId of selectedDepartments) {
      const template = DEPARTMENT_TEMPLATES.find((t) => t.id === deptId)
      if (!template) continue

      const deptPath = `${rootPath}/${template.name}`
      await window.electronAPI.createDirectory(deptPath)

      // Create subdirectories
      for (const folder of template.defaultFolders) {
        await window.electronAPI.createDirectory(`${deptPath}/${folder}`)
      }

      // Create AGENT.md
      if (template.agentConfig) {
        const agentMd = generateAgentMd(template)
        await window.electronAPI.writeFile(`${deptPath}/AGENT.md`, agentMd)

        // Create .agent directory
        const agentDir = `${deptPath}/.agent`
        await window.electronAPI.createDirectory(agentDir)
        await window.electronAPI.writeFile(
          `${agentDir}/config.json`,
          JSON.stringify(template.agentConfig, null, 2)
        )
      }

      departments.push({
        id: deptId,
        name: template.name,
        path: deptPath,
        hasAgent: !!template.agentConfig,
      })
    }

    // Create personal directory
    const personalPath = `${rootPath}/_personal`
    await window.electronAPI.createDirectory(personalPath)
    await window.electronAPI.writeFile(
      `${personalPath}/README.md`,
      '# Personal Folder\n\nThis folder is not synced to the server. Use it for personal notes and temporary files.'
    )

    // Create company README
    await window.electronAPI.writeFile(
      `${rootPath}/README.md`,
      generateCompanyReadme(companyName, departments)
    )

    const company: Company = {
      id: Date.now().toString(),
      name: companyName,
      rootPath,
      departments,
      createdAt: new Date(),
    }

    addCompany(company)
  }

  function generateAgentMd(template: DepartmentTemplate): string {
    return `# ${template.agentConfig?.name}

${template.agentConfig?.description}

## Skills

${template.agentConfig?.skills.map((s) => `- ${s}`).join('\n')}

## Usage

You can interact with this agent to get support for the following tasks:

${template.agentConfig?.skills.map((s) => `1. **${s}**: Provide detailed instructions`).join('\n')}

## Configuration

See \`.agent/config.json\` for detailed agent configuration.
`
  }

  function generateCompanyReadme(name: string, depts: Department[]): string {
    return `# ${name}

Company folder managed by AI Company Builder.

## Departments

${depts.map((d) => `- **${d.name}** ${d.hasAgent ? '(with AI Agent)' : ''}`).join('\n')}

## Usage

1. Open each department folder to manage work files
2. Open AGENT.md to see the AI agent description for that department
3. Chat with AI agents using the chat panel on the right

## Personal Folder

The \`_personal\` folder is a private folder that is not synced to the server.
Use it for private notes and temporary files.
`
  }

  return (
    <div className="h-full bg-editor-bg flex items-center justify-center">
      <div className="w-full max-w-xl p-8">
        {step === 'start' && (
          <div className="space-y-6">
            <div className="text-center">
              <Buildings size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                AI Company Builder
              </h1>
              <p className="text-text-secondary">
                AIエージェントと一緒に働く会社を作成または開きましょう
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setStep('name')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-border hover:border-accent/50 transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center">
                  <Sparkle size={24} className="text-accent" weight="fill" />
                </div>
                <div>
                  <div className="font-medium text-text-primary">新規作成</div>
                  <div className="text-sm text-text-secondary">
                    新しい会社フォルダを作成
                  </div>
                </div>
              </button>

              <button
                onClick={handleOpenExisting}
                disabled={isOpening}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-border hover:border-accent/50 transition-colors text-left disabled:opacity-50"
              >
                <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center">
                  <FolderOpen size={24} className="text-accent" weight="fill" />
                </div>
                <div>
                  <div className="font-medium text-text-primary">
                    {isOpening ? '読み込み中...' : '既存を開く'}
                  </div>
                  <div className="text-sm text-text-secondary">
                    既存の会社フォルダを選択
                  </div>
                </div>
              </button>
            </div>
          </div>
        )}

        {step === 'name' && (
          <div className="space-y-6">
            <div className="text-center">
              <Buildings size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                会社フォルダを作成
              </h1>
              <p className="text-text-secondary">
                AIエージェントと一緒に働く会社を作りましょう
              </p>
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-2">
                会社名
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="例: 株式会社サンプル"
                className="w-full bg-sidebar-bg border border-border rounded-lg px-4 py-3 text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
                autoFocus
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('start')}
                className="flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
              >
                <ArrowLeft size={18} />
                戻る
              </button>
              <button
                onClick={() => setStep('location')}
                disabled={!companyName.trim()}
                className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors"
              >
                次へ
                <ArrowRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 'location' && (
          <div className="space-y-6">
            <div className="text-center">
              <FolderSimple size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                保存場所を選択
              </h1>
              <p className="text-text-secondary">
                会社フォルダを保存する場所を選んでください
              </p>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleUseDefault}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  location.includes('AI Company Builder')
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="font-medium text-text-primary">デフォルト</div>
                <div className="text-sm text-text-secondary">
                  ~/Documents/AI Company Builder
                </div>
              </button>

              <button
                onClick={handleSelectLocation}
                className={`w-full text-left p-4 rounded-lg border transition-colors ${
                  location && !location.includes('AI Company Builder')
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="font-medium text-text-primary">カスタム場所</div>
                <div className="text-sm text-text-secondary">
                  {location && !location.includes('AI Company Builder')
                    ? location
                    : '別の場所を選択...'}
                </div>
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('name')}
                className="flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
              >
                <ArrowLeft size={18} />
                戻る
              </button>
              <button
                onClick={() => setStep('departments')}
                disabled={!location}
                className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors"
              >
                次へ
                <ArrowRight size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 'departments' && (
          <div className="space-y-6">
            <div className="text-center">
              <Robot size={64} className="mx-auto mb-4 text-accent" weight="duotone" />
              <h1 className="text-2xl font-bold text-text-primary mb-2">
                部署を選択
              </h1>
              <p className="text-text-secondary">
                作成する部署を選んでください（AIエージェント付き）
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {DEPARTMENT_TEMPLATES.map((dept) => {
                const isSelected = selectedDepartments.includes(dept.id)
                return (
                  <button
                    key={dept.id}
                    onClick={() => toggleDepartment(dept.id)}
                    className={`text-left p-4 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-accent/50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-accent">
                        {DEPARTMENT_ICONS[dept.id]}
                      </div>
                      {isSelected && (
                        <Check size={18} className="text-accent" weight="bold" />
                      )}
                    </div>
                    <div className="font-medium text-text-primary">
                      {dept.displayName}
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      {dept.description}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('location')}
                className="flex-1 flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-activitybar-bg text-text-primary rounded-lg px-4 py-3 transition-colors"
              >
                <ArrowLeft size={18} />
                戻る
              </button>
              <button
                onClick={createCompany}
                disabled={selectedDepartments.length === 0}
                className="flex-1 flex items-center justify-center gap-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-3 transition-colors"
              >
                <Sparkle size={18} weight="fill" />
                作成
              </button>
            </div>
          </div>
        )}

        {step === 'creating' && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 mx-auto border-4 border-accent border-t-transparent rounded-full animate-spin" />
            <div>
              <h2 className="text-xl font-bold text-text-primary mb-2">
                会社フォルダを作成中...
              </h2>
              <p className="text-text-secondary">
                AIエージェントの準備をしています
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

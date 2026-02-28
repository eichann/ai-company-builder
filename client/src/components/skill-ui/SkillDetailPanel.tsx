import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Lightning,
  FileText,
  BookOpen,
  Code,
  PencilSimple,
  X,
  CaretRight,
  Wrench,
  Play,
  Stop,
  ArrowSquareOut,
  CircleNotch,
  Eye,
  EyeSlash,
  CloudArrowUp,
  Warning,
  Flask
} from '@phosphor-icons/react'
import type { Skill, SkillTool } from '../../types'

type TabId = 'overview' | 'rules' | 'references' | 'scripts' | 'tools'

interface SkillDetailPanelProps {
  skill: Skill
  color: string
  onClose: () => void
  onExecute: () => void
  onEditFile: (filePath: string) => void
  onOpenTool?: (tool: SkillTool, port: number) => void
  onPublish?: (skill: Skill) => void
  onToggleNurturing?: (skill: Skill) => void
}

export function SkillDetailPanel({
  skill,
  color,
  onClose,
  onExecute,
  onEditFile,
  onOpenTool,
  onPublish,
  onToggleNurturing,
}: SkillDetailPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  const hasTools = skill.files.tools && skill.files.tools.length > 0

  const tabs: { id: TabId; label: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { id: 'overview', label: t('skillDetail.overview'), icon: <FileText size={14} /> },
    { id: 'rules', label: t('skillDetail.rules'), icon: <BookOpen size={14} /> },
    { id: 'references', label: t('skillDetail.references'), icon: <FileText size={14} /> },
    { id: 'scripts', label: t('skillDetail.scripts'), icon: <Code size={14} /> },
    { id: 'tools', label: t('skillDetail.tools', 'Tools'), icon: <Wrench size={14} />, hidden: !hasTools },
  ]

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-zinc-900/50 border-l border-gray-200 dark:border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: `${color}20` }}
          >
            <FileText size={16} weight="fill" style={{ color }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">{skill.name}</h3>
            <p className="text-xs text-gray-500 dark:text-zinc-500">{t('skillDetail.title')}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Execute Button */}
      <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
        <button
          onClick={onExecute}
          className="
            w-full flex items-center justify-center gap-2
            py-3 rounded-xl
            font-medium text-sm text-white
            transition-all duration-200
            hover:brightness-110 active:scale-[0.98]
          "
          style={{ backgroundColor: color }}
        >
          <Lightning size={16} weight="fill" />
          {t('skillDetail.executeButton')}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-5 py-2 border-b border-gray-200 dark:border-zinc-800">
        {tabs.filter(tab => !tab.hidden).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-lg
              text-xs font-medium transition-colors
              ${activeTab === tab.id
                ? 'bg-gray-200 dark:bg-white/[0.08] text-gray-800 dark:text-zinc-200'
                : 'text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-white/[0.04]'
              }
            `}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-5">
        {activeTab === 'overview' && (
          <OverviewTab skill={skill} onEditFile={onEditFile} onPublish={onPublish} onToggleNurturing={onToggleNurturing} />
        )}
        {activeTab === 'rules' && (
          <FileListTab
            files={skill.files.rules || []}
            emptyMessage={t('skillDetail.noRules')}
            onEditFile={onEditFile}
          />
        )}
        {activeTab === 'references' && (
          <FileListTab
            files={skill.files.references || []}
            emptyMessage={t('skillDetail.noReferences')}
            onEditFile={onEditFile}
          />
        )}
        {activeTab === 'scripts' && (
          <FileListTab
            files={skill.files.scripts || []}
            emptyMessage={t('skillDetail.noScripts')}
            onEditFile={onEditFile}
          />
        )}
        {activeTab === 'tools' && (
          <ToolsTab
            tools={skill.files.tools || []}
            color={color}
            onOpenTool={onOpenTool}
          />
        )}
      </div>
    </div>
  )
}

function OverviewTab({
  skill,
  onEditFile,
  onPublish,
  onToggleNurturing,
}: {
  skill: Skill
  onEditFile: (path: string) => void
  onPublish?: (skill: Skill) => void
  onToggleNurturing?: (skill: Skill) => void
}) {
  const { t } = useTranslation()
  const [showPublishConfirm, setShowPublishConfirm] = useState(false)

  return (
    <div className="space-y-6">
      {/* Sharing Status */}
      <div>
        <h4 className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider mb-2">
          共有
        </h4>
        {skill.isPrivate ? (
          <div className="p-3 rounded-xl bg-gray-100 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50">
            <div className="flex items-center gap-2 mb-2">
              <EyeSlash size={16} className="text-gray-500 dark:text-zinc-400" />
              <span className="text-sm font-medium text-gray-700 dark:text-zinc-300">非公開</span>
              <span className="text-xs text-gray-500 dark:text-zinc-500">— 自分だけ</span>
            </div>
            {!showPublishConfirm ? (
              <button
                onClick={() => setShowPublishConfirm(true)}
                className="
                  w-full flex items-center justify-center gap-2
                  py-2 rounded-lg
                  text-sm font-medium
                  bg-blue-600 hover:bg-blue-700 text-white
                  transition-colors
                "
              >
                <CloudArrowUp size={14} />
                公開する
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-start gap-2 p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-700 dark:text-blue-400">
                  <Warning size={14} className="flex-shrink-0 mt-0.5" />
                  <span>公開すると次回の同期で全員に共有されます。公開後は非公開に戻せません。</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      onPublish?.(skill)
                      setShowPublishConfirm(false)
                    }}
                    className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    公開する
                  </button>
                  <button
                    onClick={() => setShowPublishConfirm(false)}
                    className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-gray-200 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-300 dark:hover:bg-zinc-700 transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 rounded-xl bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800/30">
            <div className="flex items-center gap-2">
              <Eye size={16} className="text-green-600 dark:text-green-400" />
              <span className="text-sm font-medium text-green-700 dark:text-green-400">公開中</span>
              <span className="text-xs text-green-600/70 dark:text-green-500/70">— 全員と共有</span>
            </div>
          </div>
        )}
      </div>

      {/* Nurturing Status */}
      <div>
        <h4 className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider mb-2">
          ステータス
        </h4>
        <button
          onClick={() => onToggleNurturing?.(skill)}
          className={`
            w-full p-3 rounded-xl border text-left transition-colors
            ${skill.isNurturing
              ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/30'
              : 'bg-gray-50 dark:bg-zinc-800/30 border-gray-200 dark:border-zinc-700/50 hover:bg-gray-100 dark:hover:bg-zinc-800/50'
            }
          `}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {skill.isNurturing ? (
                <>
                  <Flask size={16} className="text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-medium text-amber-700 dark:text-amber-400">育て中</span>
                </>
              ) : (
                <>
                  <Lightning size={16} className="text-gray-600 dark:text-zinc-400" />
                  <span className="text-sm font-medium text-gray-700 dark:text-zinc-300">通常</span>
                </>
              )}
            </div>
            <span className="text-xs text-gray-400 dark:text-zinc-600">
              クリックで切り替え
            </span>
          </div>
        </button>
      </div>

      {/* Description */}
      <div>
        <h4 className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider mb-2">
          {t('skillDetail.description')}
        </h4>
        <p className="text-sm text-gray-700 dark:text-zinc-300 leading-relaxed">
          {skill.description}
        </p>
      </div>

      {/* SKILL.md */}
      {skill.files.skillMd && (
        <div>
          <h4 className="text-xs font-medium text-gray-500 dark:text-zinc-500 uppercase tracking-wider mb-2">
            {t('skillDetail.definitionFile')}
          </h4>
          <button
            onClick={() => onEditFile(skill.files.skillMd!)}
            className="
              w-full flex items-center justify-between
              p-3 rounded-xl bg-gray-100 dark:bg-white/[0.03] hover:bg-gray-200 dark:hover:bg-white/[0.06]
              transition-colors group
            "
          >
            <div className="flex items-center gap-3">
              <FileText size={18} className="text-gray-500 dark:text-zinc-500" />
              <span className="text-sm text-gray-700 dark:text-zinc-300">SKILL.md</span>
            </div>
            <div className="flex items-center gap-2 text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300">
              <PencilSimple size={14} />
              <CaretRight size={14} />
            </div>
          </button>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-xl bg-gray-100 dark:bg-white/[0.03] text-center">
          <div className="text-lg font-semibold text-gray-800 dark:text-zinc-200">
            {skill.files.rules?.length || 0}
          </div>
          <div className="text-xs text-gray-500 dark:text-zinc-500">{t('skillDetail.rules')}</div>
        </div>
        <div className="p-3 rounded-xl bg-gray-100 dark:bg-white/[0.03] text-center">
          <div className="text-lg font-semibold text-gray-800 dark:text-zinc-200">
            {skill.files.references?.length || 0}
          </div>
          <div className="text-xs text-gray-500 dark:text-zinc-500">{t('skillDetail.references')}</div>
        </div>
        <div className="p-3 rounded-xl bg-gray-100 dark:bg-white/[0.03] text-center">
          <div className="text-lg font-semibold text-gray-800 dark:text-zinc-200">
            {skill.files.scripts?.length || 0}
          </div>
          <div className="text-xs text-gray-500 dark:text-zinc-500">{t('skillDetail.scripts')}</div>
        </div>
      </div>
    </div>
  )
}

function FileListTab({
  files,
  emptyMessage,
  onEditFile,
}: {
  files: string[]
  emptyMessage: string
  onEditFile: (path: string) => void
}) {
  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-zinc-600">
        <FileText size={24} className="mb-2" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <button
          key={file}
          onClick={() => onEditFile(file)}
          className="
            w-full flex items-center justify-between
            p-3 rounded-xl bg-gray-100 dark:bg-white/[0.03] hover:bg-gray-200 dark:hover:bg-white/[0.06]
            transition-colors group
          "
        >
          <div className="flex items-center gap-3">
            <FileText size={16} className="text-gray-500 dark:text-zinc-500" />
            <span className="text-sm text-gray-700 dark:text-zinc-300">{file.split('/').pop()}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-400 dark:text-zinc-500 group-hover:text-gray-600 dark:group-hover:text-zinc-300">
            <PencilSimple size={14} />
            <CaretRight size={14} />
          </div>
        </button>
      ))}
    </div>
  )
}

function ToolsTab({
  tools,
  color,
  onOpenTool,
}: {
  tools: SkillTool[]
  color: string
  onOpenTool?: (tool: SkillTool, port: number) => void
}) {
  const { t } = useTranslation()
  const [runningTools, setRunningTools] = useState<Map<string, number>>(new Map())
  const [loadingTools, setLoadingTools] = useState<Set<string>>(new Set())

  const handleStartTool = async (tool: SkillTool) => {
    if (!tool.hasPackageJson || !tool.startCommand) return

    setLoadingTools(prev => new Set(prev).add(tool.path))

    try {
      const result = await window.electronAPI.startTool(tool.path, tool.startCommand)
      if (result.success && result.port) {
        setRunningTools(prev => new Map(prev).set(tool.path, result.port!))
      } else {
        console.error('Failed to start tool:', result.error)
      }
    } catch (error) {
      console.error('Error starting tool:', error)
    } finally {
      setLoadingTools(prev => {
        const next = new Set(prev)
        next.delete(tool.path)
        return next
      })
    }
  }

  const handleStopTool = async (tool: SkillTool) => {
    setLoadingTools(prev => new Set(prev).add(tool.path))

    try {
      const result = await window.electronAPI.stopTool(tool.path)
      if (result.success) {
        setRunningTools(prev => {
          const next = new Map(prev)
          next.delete(tool.path)
          return next
        })
      }
    } catch (error) {
      console.error('Error stopping tool:', error)
    } finally {
      setLoadingTools(prev => {
        const next = new Set(prev)
        next.delete(tool.path)
        return next
      })
    }
  }

  const handleOpenTool = (tool: SkillTool) => {
    const port = runningTools.get(tool.path)
    if (port && onOpenTool) {
      onOpenTool(tool, port)
    }
  }

  if (tools.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-zinc-600">
        <Wrench size={24} className="mb-2" />
        <p className="text-sm">{t('skillDetail.noTools', 'No tools available')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {tools.map((tool) => {
        const isRunning = runningTools.has(tool.path)
        const isLoading = loadingTools.has(tool.path)
        const port = runningTools.get(tool.path)

        return (
          <div
            key={tool.path}
            className="p-4 rounded-xl bg-gray-100 dark:bg-white/[0.03] border border-gray-200 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ backgroundColor: `${color}20` }}
                >
                  <Wrench size={16} weight="fill" style={{ color }} />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-gray-800 dark:text-zinc-200">
                    {tool.displayName}
                  </h4>
                  <p className="text-xs text-gray-500 dark:text-zinc-500">
                    {tool.name}
                  </p>
                </div>
              </div>

              {isRunning && (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-xs text-green-700 dark:text-green-400">
                    localhost:{port}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              {!isRunning ? (
                <button
                  onClick={() => handleStartTool(tool)}
                  disabled={isLoading || !tool.hasPackageJson}
                  className="
                    flex-1 flex items-center justify-center gap-2
                    py-2 rounded-lg
                    text-sm font-medium
                    bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1]
                    text-gray-700 dark:text-zinc-300
                    disabled:opacity-50 disabled:cursor-not-allowed
                    transition-colors
                  "
                >
                  {isLoading ? (
                    <CircleNotch size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} weight="fill" />
                  )}
                  {t('skillDetail.startTool', 'Start')}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => handleOpenTool(tool)}
                    className="
                      flex-1 flex items-center justify-center gap-2
                      py-2 rounded-lg
                      text-sm font-medium text-white
                      transition-colors hover:brightness-110
                    "
                    style={{ backgroundColor: color }}
                  >
                    <ArrowSquareOut size={14} />
                    {t('skillDetail.openTool', 'Open')}
                  </button>
                  <button
                    onClick={() => handleStopTool(tool)}
                    disabled={isLoading}
                    className="
                      flex items-center justify-center gap-2
                      px-4 py-2 rounded-lg
                      text-sm font-medium
                      bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50
                      text-red-700 dark:text-red-400
                      disabled:opacity-50 disabled:cursor-not-allowed
                      transition-colors
                    "
                  >
                    {isLoading ? (
                      <CircleNotch size={14} className="animate-spin" />
                    ) : (
                      <Stop size={14} weight="fill" />
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

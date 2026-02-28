import { useTranslation } from 'react-i18next'
import {
  X,
  ArrowSquareOut,
  Wrench,
} from '@phosphor-icons/react'
import type { SkillTool } from '../../types'

interface ToolViewerProps {
  tool: SkillTool
  port: number
  color: string
  onClose: () => void
}

export function ToolViewer({ tool, port, color, onClose }: ToolViewerProps) {
  const { t } = useTranslation()
  const url = `http://localhost:${port}`

  const handleOpenExternal = async () => {
    await window.electronAPI.openExternal(url)
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/80">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: `${color}20` }}
          >
            <Wrench size={16} weight="fill" style={{ color }} />
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-800 dark:text-zinc-200">
              {tool.displayName}
            </h3>
            <p className="text-xs text-gray-500 dark:text-zinc-500">
              {url}
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 transition-colors"
          title={t('toolViewer.close', 'Close')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6"
          style={{ backgroundColor: `${color}15` }}
        >
          <Wrench size={40} weight="fill" style={{ color }} />
        </div>

        <h2 className="text-xl font-semibold text-gray-800 dark:text-zinc-200 mb-2">
          {tool.displayName}
        </h2>

        <p className="text-sm text-gray-500 dark:text-zinc-400 mb-2">
          {t('toolViewer.running', 'Running at')} {url}
        </p>

        <div className="flex items-center gap-2 mb-8">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-green-600 dark:text-green-400">
            {t('toolViewer.active', 'Active')}
          </span>
        </div>

        <button
          onClick={handleOpenExternal}
          className="
            flex items-center gap-3 px-6 py-3 rounded-xl
            text-white font-medium
            transition-all hover:brightness-110 active:scale-[0.98]
          "
          style={{ backgroundColor: color }}
        >
          <ArrowSquareOut size={20} />
          {t('toolViewer.openInBrowser', 'Open in Browser')}
        </button>

        <p className="mt-6 text-xs text-gray-400 dark:text-zinc-600 text-center max-w-xs">
          {t('toolViewer.hint', 'The tool will open in your default browser. You can work with it alongside this app.')}
        </p>
      </div>
    </div>
  )
}

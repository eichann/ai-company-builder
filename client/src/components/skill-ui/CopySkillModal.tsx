import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  X,
  Copy,
  CaretDown,
  Lightning,
  SpinnerGap,
  Check,
} from '@phosphor-icons/react'
import type { DepartmentConfig, Skill } from '../../types'
import { COMPANY_TAB_ID } from './DepartmentTabs'

interface CopySkillModalProps {
  rootPath: string
  currentDepartmentId: string
  departments: DepartmentConfig[]
  color: string
  onClose: () => void
  onCopy: (sourceSkillPath: string, name: string, folderName: string) => void
}

// Generate folder name from display name
function generateFolderName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)
    || 'copied-skill'
}

function isValidFolderName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

export function CopySkillModal({
  rootPath,
  currentDepartmentId,
  departments,
  color,
  onClose,
  onCopy,
}: CopySkillModalProps) {
  useTranslation() // keep hook for future i18n

  // Available sources: other departments + company-wide
  const sources = [
    { id: COMPANY_TAB_ID, name: '全社', folder: '' },
    ...departments
      .filter(d => d.id !== currentDepartmentId)
      .map(d => ({ id: d.id, name: d.name, folder: d.folder })),
  ]

  const [selectedSourceId, setSelectedSourceId] = useState(sources[0]?.id || '')
  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoadingSkills, setIsLoadingSkills] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  // Copy form
  const [name, setName] = useState('')
  const [folderName, setFolderName] = useState('')
  const [folderNameEdited, setFolderNameEdited] = useState(false)
  const [isCopying, setIsCopying] = useState(false)

  const selectedSkill = skills.find(s => s.id === selectedSkillId)

  // Load skills for selected source
  const loadSkills = useCallback(async () => {
    if (!selectedSourceId || !rootPath) return

    setIsLoadingSkills(true)
    setSelectedSkillId(null)
    setPreviewContent(null)

    try {
      const source = sources.find(s => s.id === selectedSourceId)
      if (!source) return

      const result = await window.electronAPI.listSkills(
        rootPath,
        source.folder,
        source.id,
        source.name,
      )

      if (result.success) {
        // Filter to only public skills (private ones shouldn't be copyable)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mappedSkills: Skill[] = (result.skills as any[])
          .filter(s => !s.isPrivate)
          .map(skill => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            departmentId: skill.departmentId,
            group: skill.group || '',
            isPrivate: skill.isPrivate,
            isNurturing: skill.isNurturing,
            skillPath: skill.skillPath,
            files: skill.files,
          }))
        setSkills(mappedSkills)
      }
    } catch (err) {
      console.error('Failed to load skills:', err)
    } finally {
      setIsLoadingSkills(false)
    }
  }, [selectedSourceId, rootPath])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Load preview when skill is selected
  useEffect(() => {
    if (!selectedSkill?.files?.skillMd) {
      setPreviewContent(null)
      return
    }

    setIsLoadingPreview(true)
    window.electronAPI.readFile(selectedSkill.files.skillMd)
      .then((content: string | null) => {
        setPreviewContent(content)
      })
      .catch(() => setPreviewContent(null))
      .finally(() => setIsLoadingPreview(false))
  }, [selectedSkill?.files?.skillMd])

  // Pre-fill name and folder name when skill is selected
  useEffect(() => {
    if (selectedSkill) {
      setName(selectedSkill.name)
      if (!folderNameEdited) {
        // Use the source skill's folder name as default
        const sourceFolderName = selectedSkill.skillPath?.split('/').pop() || ''
        setFolderName(sourceFolderName || generateFolderName(selectedSkill.name))
      }
    }
  }, [selectedSkill?.id])

  const handleNameChange = (newName: string) => {
    setName(newName)
    if (!folderNameEdited) {
      setFolderName(generateFolderName(newName))
    }
  }

  const handleFolderNameChange = (newFolderName: string) => {
    const sanitized = newFolderName.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    setFolderName(sanitized)
    setFolderNameEdited(true)
  }

  const folderNameValid = isValidFolderName(folderName)

  const handleCopy = async () => {
    if (!selectedSkill?.skillPath || !name.trim() || !folderNameValid) return
    setIsCopying(true)
    try {
      onCopy(selectedSkill.skillPath, name.trim(), folderName)
    } finally {
      setIsCopying(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-3xl bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${color}20` }}
            >
              <Copy size={16} weight="fill" style={{ color }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
                他の部署からスキルをコピー
              </h2>
              <p className="text-xs text-gray-500 dark:text-zinc-500">
                公開スキルを選択してコピーできます
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.05] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left: Source selector + skill list */}
          <div className="w-1/2 border-r border-gray-200 dark:border-zinc-800 flex flex-col">
            {/* Source dropdown */}
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800/50 flex-shrink-0">
              <label className="block text-xs font-medium text-gray-500 dark:text-zinc-500 mb-1.5">
                コピー元
              </label>
              <div className="relative">
                <select
                  value={selectedSourceId}
                  onChange={(e) => {
                    setSelectedSourceId(e.target.value)
                    setFolderNameEdited(false)
                  }}
                  className="w-full appearance-none px-3 py-2 pr-8 rounded-lg bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-sm text-gray-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {sources.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <CaretDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-zinc-500 pointer-events-none" />
              </div>
            </div>

            {/* Skill list */}
            <div className="flex-1 overflow-y-auto">
              {isLoadingSkills ? (
                <div className="flex items-center justify-center py-8">
                  <SpinnerGap size={20} className="animate-spin text-gray-400 dark:text-zinc-500" />
                </div>
              ) : skills.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-gray-400 dark:text-zinc-500">
                  <Lightning size={24} className="mb-2" />
                  <p className="text-sm">公開スキルがありません</p>
                </div>
              ) : (
                <div className="p-2 space-y-0.5">
                  {skills.map(skill => (
                    <button
                      key={skill.id}
                      onClick={() => setSelectedSkillId(skill.id)}
                      className={`
                        w-full text-left px-3 py-2.5 rounded-lg transition-colors
                        ${selectedSkillId === skill.id
                          ? 'bg-accent/10 text-gray-900 dark:text-zinc-100'
                          : 'text-gray-600 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-white/[0.03]'
                        }
                      `}
                    >
                      <div className="flex items-center gap-2">
                        <Lightning size={14} weight={selectedSkillId === skill.id ? 'fill' : 'regular'} style={{ color: selectedSkillId === skill.id ? color : undefined }} />
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                      </div>
                      {skill.description && (
                        <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5 ml-[22px] line-clamp-1">
                          {skill.description}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Preview + copy form */}
          <div className="w-1/2 flex flex-col">
            {selectedSkill ? (
              <>
                {/* Preview */}
                <div className="flex-1 overflow-y-auto p-4 min-h-0">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-zinc-100 mb-1">
                    {selectedSkill.name}
                  </h3>
                  {selectedSkill.description && (
                    <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">
                      {selectedSkill.description}
                    </p>
                  )}
                  <div className="border-t border-gray-100 dark:border-zinc-800 pt-3">
                    <p className="text-xs font-medium text-gray-500 dark:text-zinc-500 mb-2">SKILL.md</p>
                    {isLoadingPreview ? (
                      <SpinnerGap size={16} className="animate-spin text-gray-400 dark:text-zinc-500" />
                    ) : previewContent ? (
                      <pre className="text-xs text-gray-600 dark:text-zinc-400 whitespace-pre-wrap font-mono bg-gray-50 dark:bg-zinc-800/50 rounded-lg p-3 max-h-[200px] overflow-y-auto">
                        {previewContent}
                      </pre>
                    ) : (
                      <p className="text-xs text-gray-400 dark:text-zinc-600 italic">プレビューを読み込めません</p>
                    )}
                  </div>
                </div>

                {/* Copy form */}
                <div className="flex-shrink-0 p-4 border-t border-gray-200 dark:border-zinc-800 space-y-3 bg-gray-50 dark:bg-zinc-900/50">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">
                      スキル名
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => handleNameChange(e.target.value)}
                      placeholder="コピー後のスキル名"
                      className="w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-sm text-gray-900 dark:text-zinc-100 placeholder:text-gray-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-zinc-400 mb-1">
                      フォルダ名
                    </label>
                    <input
                      type="text"
                      value={folderName}
                      onChange={(e) => handleFolderNameChange(e.target.value)}
                      placeholder="skill-folder-name"
                      className={`w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-800 border text-sm text-gray-900 dark:text-zinc-100 placeholder:text-gray-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent font-mono ${
                        folderName && !folderNameValid ? 'border-red-500' : 'border-gray-200 dark:border-zinc-700'
                      }`}
                    />
                    {folderName && !folderNameValid && (
                      <p className="text-xs text-red-400 mt-1">英小文字で始まり、英数字・ハイフン・アンダースコアのみ</p>
                    )}
                  </div>
                  <button
                    onClick={handleCopy}
                    disabled={!name.trim() || !folderNameValid || isCopying}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: color }}
                  >
                    {isCopying ? (
                      <SpinnerGap size={14} className="animate-spin" />
                    ) : (
                      <Check size={14} weight="bold" />
                    )}
                    コピーして作成
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-zinc-600">
                <div className="text-center">
                  <Lightning size={32} className="mx-auto mb-2" />
                  <p className="text-sm">スキルを選択してください</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

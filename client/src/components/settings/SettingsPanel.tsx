import { useState, useEffect, useCallback } from 'react'
import { X, Eye, EyeSlash, Plus, Trash, Code, Key, FloppyDisk, Check, FileText } from '@phosphor-icons/react'
import { useAppStore } from '../../stores/appStore'

// Common API key definitions
const COMMON_API_KEYS = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'GOOGLE_API_KEY', label: 'Google AI', placeholder: 'AIza...' },
  { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI', placeholder: '' },
]

interface SettingsPanelProps {
  onClose: () => void
}

type TabType = 'apikeys' | 'gitignore' | 'advanced'

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { currentCompany } = useAppStore()
  const [activeTab, setActiveTab] = useState<TabType>('apikeys')
  const [envVars, setEnvVars] = useState<Record<string, string>>({})
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  const [customKeys, setCustomKeys] = useState<Array<{ key: string; value: string }>>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [rawEnvContent, setRawEnvContent] = useState('')
  const [gitignoreContent, setGitignoreContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load .env and .gitignore files on mount
  useEffect(() => {
    if (!currentCompany?.rootPath) return

    const loadFiles = async () => {
      setLoading(true)
      setError(null)
      try {
        // Load .env
        const result = await window.electronAPI.readEnv(currentCompany.rootPath)
        if (result.success && result.vars) {
          setEnvVars(result.vars)
          // Separate common keys from custom keys
          const commonKeySet = new Set(COMMON_API_KEYS.map(k => k.key))
          const customEntries = Object.entries(result.vars)
            .filter(([key]) => !commonKeySet.has(key))
            .map(([key, value]) => ({ key, value }))
          setCustomKeys(customEntries)
          // Build raw content
          setRawEnvContent(
            Object.entries(result.vars)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')
          )
        } else if (result.error) {
          setError(result.error)
        }

        // Load .gitignore
        const gitignorePath = `${currentCompany.rootPath}/.gitignore`
        const gitignoreResult = await window.electronAPI.readFile(gitignorePath)
        if (gitignoreResult) {
          setGitignoreContent(gitignoreResult)
        } else {
          setGitignoreContent('')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '読み込みに失敗しました')
      } finally {
        setLoading(false)
      }
    }

    loadFiles()
  }, [currentCompany?.rootPath])

  // Toggle visibility of a key
  const toggleVisibility = useCallback((key: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // Update a common API key value
  const updateCommonKey = useCallback((key: string, value: string) => {
    setEnvVars(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }, [])

  // Update a custom key
  const updateCustomKey = useCallback((index: number, field: 'key' | 'value', value: string) => {
    setCustomKeys(prev => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
    setSaved(false)
  }, [])

  // Add a new custom key
  const addCustomKey = useCallback(() => {
    if (!newKeyName.trim()) return
    const keyName = newKeyName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    if (COMMON_API_KEYS.some(k => k.key === keyName) || customKeys.some(k => k.key === keyName)) {
      setError('このキー名は既に存在します')
      return
    }
    setCustomKeys(prev => [...prev, { key: keyName, value: '' }])
    setNewKeyName('')
    setSaved(false)
  }, [newKeyName, customKeys])

  // Remove a custom key
  const removeCustomKey = useCallback((index: number) => {
    setCustomKeys(prev => prev.filter((_, i) => i !== index))
    setSaved(false)
  }, [])

  // Save all changes
  const saveChanges = useCallback(async () => {
    if (!currentCompany?.rootPath) return

    setSaving(true)
    setError(null)
    try {
      if (activeTab === 'gitignore') {
        // Save .gitignore
        const gitignorePath = `${currentCompany.rootPath}/.gitignore`
        const result = await window.electronAPI.writeFile(gitignorePath, gitignoreContent)
        if (result) {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        } else {
          setError('保存に失敗しました')
        }
      } else {
        // Save .env
        let varsToSave: Record<string, string>

        if (activeTab === 'advanced') {
          // Parse raw content
          varsToSave = {}
          const lines = rawEnvContent.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eqIndex = trimmed.indexOf('=')
            if (eqIndex > 0) {
              const key = trimmed.slice(0, eqIndex).trim()
              let value = trimmed.slice(eqIndex + 1).trim()
              // Remove quotes
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
              }
              varsToSave[key] = value
            }
          }
        } else {
          // Build from common keys + custom keys
          varsToSave = {}
          for (const { key } of COMMON_API_KEYS) {
            if (envVars[key]) {
              varsToSave[key] = envVars[key]
            }
          }
          for (const { key, value } of customKeys) {
            if (key && value) {
              varsToSave[key] = value
            }
          }
        }

        const result = await window.electronAPI.writeEnv(currentCompany.rootPath, varsToSave)
        if (result.success) {
          setSaved(true)
          // Update state to reflect saved values
          setEnvVars(varsToSave)
          setTimeout(() => setSaved(false), 2000)
        } else {
          setError(result.error || '保存に失敗しました')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }, [currentCompany?.rootPath, activeTab, envVars, customKeys, rawEnvContent, gitignoreContent])

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  if (!currentCompany) {
    return null
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-100">設定</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/[0.05] text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-zinc-800">
          <button
            onClick={() => setActiveTab('apikeys')}
            className={`
              flex items-center gap-2 px-6 py-3 text-sm font-medium
              border-b-2 transition-colors
              ${activeTab === 'apikeys'
                ? 'border-amber-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }
            `}
          >
            <Key size={16} />
            APIキー
          </button>
          <button
            onClick={() => setActiveTab('gitignore')}
            className={`
              flex items-center gap-2 px-6 py-3 text-sm font-medium
              border-b-2 transition-colors
              ${activeTab === 'gitignore'
                ? 'border-amber-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }
            `}
          >
            <FileText size={16} />
            同期除外
          </button>
          <button
            onClick={() => setActiveTab('advanced')}
            className={`
              flex items-center gap-2 px-6 py-3 text-sm font-medium
              border-b-2 transition-colors
              ${activeTab === 'advanced'
                ? 'border-amber-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }
            `}
          >
            <Code size={16} />
            詳細設定
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-zinc-500">読み込み中...</div>
            </div>
          ) : activeTab === 'apikeys' ? (
            <div className="space-y-6">
              {/* Common API Keys */}
              <div>
                <h3 className="text-sm font-medium text-zinc-400 mb-4">よく使うAPIキー</h3>
                <div className="space-y-3">
                  {COMMON_API_KEYS.map(({ key, label, placeholder }) => (
                    <div key={key} className="flex items-center gap-3">
                      <label className="w-32 text-sm text-zinc-300 shrink-0">{label}</label>
                      <div className="flex-1 relative">
                        <input
                          type={visibleKeys.has(key) ? 'text' : 'password'}
                          value={envVars[key] || ''}
                          onChange={(e) => updateCommonKey(key, e.target.value)}
                          placeholder={placeholder}
                          className="w-full px-3 py-2 pr-10 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                        />
                        <button
                          onClick={() => toggleVisibility(key)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                        >
                          {visibleKeys.has(key) ? <EyeSlash size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Custom Keys */}
              <div>
                <h3 className="text-sm font-medium text-zinc-400 mb-4">カスタム環境変数</h3>
                <div className="space-y-3">
                  {customKeys.map((item, index) => (
                    <div key={index} className="flex items-center gap-3">
                      <input
                        type="text"
                        value={item.key}
                        onChange={(e) => updateCustomKey(index, 'key', e.target.value.toUpperCase())}
                        placeholder="KEY_NAME"
                        className="w-32 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
                      />
                      <div className="flex-1 relative">
                        <input
                          type={visibleKeys.has(`custom-${index}`) ? 'text' : 'password'}
                          value={item.value}
                          onChange={(e) => updateCustomKey(index, 'value', e.target.value)}
                          placeholder="value"
                          className="w-full px-3 py-2 pr-10 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                        />
                        <button
                          onClick={() => toggleVisibility(`custom-${index}`)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                        >
                          {visibleKeys.has(`custom-${index}`) ? <EyeSlash size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <button
                        onClick={() => removeCustomKey(index)}
                        className="p-2 text-zinc-500 hover:text-red-400 transition-colors"
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  ))}

                  {/* Add new key */}
                  <div className="flex items-center gap-3 pt-2">
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value.toUpperCase())}
                      placeholder="新しいキー名"
                      onKeyDown={(e) => e.key === 'Enter' && addCustomKey()}
                      className="w-32 px-3 py-2 bg-zinc-800/50 border border-zinc-700/50 border-dashed rounded-lg text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
                    />
                    <button
                      onClick={addCustomKey}
                      disabled={!newKeyName.trim()}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus size={16} />
                      追加
                    </button>
                  </div>
                </div>
              </div>

              {/* Info */}
              <div className="text-xs text-zinc-500 bg-zinc-800/50 rounded-lg p-3">
                <p>APIキーは <code className="px-1 py-0.5 bg-zinc-700 rounded">.env</code> ファイルに保存されます。</p>
                <p className="mt-1">スクリプトから <code className="px-1 py-0.5 bg-zinc-700 rounded">process.env.OPENAI_API_KEY</code> などで参照できます。</p>
              </div>
            </div>
          ) : activeTab === 'gitignore' ? (
            /* Gitignore Tab */
            <div className="space-y-4">
              <div className="text-sm text-zinc-400 mb-2">
                同期対象外ファイル (.gitignore)
              </div>
              <textarea
                value={gitignoreContent}
                onChange={(e) => {
                  setGitignoreContent(e.target.value)
                  setSaved(false)
                }}
                placeholder="# 同期対象外にするファイル/フォルダ&#10;.DS_Store&#10;node_modules/&#10;*.log"
                className="w-full h-80 px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
                spellCheck={false}
              />
              <div className="text-xs text-zinc-500 bg-zinc-800/50 rounded-lg p-3 space-y-2">
                <p><strong>自動追加されるエントリ:</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li><code className="px-1 py-0.5 bg-zinc-700 rounded">.backups/</code> - バックアップフォルダ</li>
                  <li><code className="px-1 py-0.5 bg-zinc-700 rounded">100MB以上のファイル</code> - 大容量ファイル</li>
                </ul>
                <p className="mt-2"><strong>書き方:</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li><code className="px-1 py-0.5 bg-zinc-700 rounded">*.log</code> - すべての.logファイル</li>
                  <li><code className="px-1 py-0.5 bg-zinc-700 rounded">folder/</code> - フォルダ全体</li>
                  <li><code className="px-1 py-0.5 bg-zinc-700 rounded"># comment</code> - コメント</li>
                </ul>
              </div>
            </div>
          ) : (
            /* Advanced Tab - Raw .env Editor */
            <div className="space-y-4">
              <div className="text-sm text-zinc-400 mb-2">
                .envファイルを直接編集
              </div>
              <textarea
                value={rawEnvContent}
                onChange={(e) => {
                  setRawEnvContent(e.target.value)
                  setSaved(false)
                }}
                placeholder="OPENAI_API_KEY=sk-...&#10;ANTHROPIC_API_KEY=sk-ant-..."
                className="w-full h-80 px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
                spellCheck={false}
              />
              <div className="text-xs text-zinc-500">
                <p>形式: <code className="px-1 py-0.5 bg-zinc-700 rounded">KEY=value</code> (1行に1つ)</p>
                <p className="mt-1">コメント行は <code className="px-1 py-0.5 bg-zinc-700 rounded">#</code> で始めてください。</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
          {error ? (
            <div className="text-sm text-red-400">{error}</div>
          ) : (
            <div className="text-sm text-zinc-500">
              保存先: <code className="px-1 py-0.5 bg-zinc-800 rounded">
                {currentCompany.rootPath}/{activeTab === 'gitignore' ? '.gitignore' : '.env'}
              </code>
            </div>
          )}
          <button
            onClick={saveChanges}
            disabled={saving}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
              transition-all
              ${saved
                ? 'bg-emerald-600 text-white'
                : 'bg-amber-600 hover:bg-amber-500 text-white'
              }
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            {saving ? (
              <>保存中...</>
            ) : saved ? (
              <>
                <Check size={16} />
                保存完了
              </>
            ) : (
              <>
                <FloppyDisk size={16} />
                保存
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

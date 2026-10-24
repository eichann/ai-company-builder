import { VoiceShortcutSettings } from './VoiceShortcutSettings'
import { VoicePromptSettings } from './VoicePromptSettings'
import { PromptSuggestionSettings } from './PromptSuggestionSettings'
import { AgentEnvSettings } from './AgentEnvSettings'
import { DownloadFoldersSection } from './DownloadFoldersSection'
import { Button, Callout, Card, SectionHeader, SubHeading } from './ui'
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { X, Eye, EyeSlash, Plus, Trash, Code, Key, Check, FileX, CloudArrowDown, Microphone, SpinnerGap, Lightbulb, ShieldCheck } from '@phosphor-icons/react'
import { useAppStore } from '../../stores/appStore'
import { useDepartments } from '../../hooks/useDepartments'

// Common API key definitions
const COMMON_API_KEYS = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'GOOGLE_API_KEY', label: 'Google AI', placeholder: 'AIza...' },
  { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI', placeholder: '' },
]

interface SettingsPanelProps {
  onClose: () => void
  /** Section to open first (default: ダウンロードするフォルダ). */
  initialTab?: TabType
}

export type TabType = 'sync' | 'gitignore' | 'apikeys' | 'advanced' | 'aienv' | 'voice' | 'suggestions'

const NAV: Array<{ group: string; items: Array<{ id: TabType; label: string; icon: ReactNode }> }> = [
  {
    group: '同期',
    items: [
      { id: 'sync', label: 'ダウンロードするフォルダ', icon: <CloudArrowDown size={16} /> },
      { id: 'gitignore', label: '同期しないファイル', icon: <FileX size={16} /> },
    ],
  },
  {
    group: 'AI と連携',
    items: [
      { id: 'apikeys', label: 'APIキー', icon: <Key size={16} /> },
      { id: 'advanced', label: '環境変数（.env）', icon: <Code size={16} /> },
      { id: 'aienv', label: 'AIに渡す環境変数', icon: <ShieldCheck size={16} /> },
    ],
  },
  {
    group: '入力',
    items: [
      { id: 'voice', label: '音声入力', icon: <Microphone size={16} /> },
      { id: 'suggestions', label: '入力候補', icon: <Lightbulb size={16} /> },
    ],
  },
]

const INPUT = 'h-9 rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-indigo-400/60'
const TEXTAREA = 'h-80 w-full resize-none rounded-lg border border-zinc-200 bg-white px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-500'
const CODE = 'rounded bg-zinc-100 px-1 py-px font-mono text-[12px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200'

export function SettingsPanel({ onClose, initialTab = 'sync' }: SettingsPanelProps) {
  const { currentCompany } = useAppStore()
  const { departments } = useDepartments(currentCompany?.id)
  const [gitBinaryStatus, setGitBinaryStatus] = useState<{ bundled: boolean; binary: string } | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>(initialTab)
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
  const dialogRef = useRef<HTMLDivElement>(null)

  // Check which git binary is in use (warn when on the system git fallback)
  useEffect(() => {
    window.electronAPI.gitBinaryStatus().then(setGitBinaryStatus).catch(() => {})
  }, [])

  // Escape closes; focus starts inside the dialog.
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  const hasSaveFooter = activeTab === 'apikeys' || activeTab === 'gitignore' || activeTab === 'advanced'

  const loadingState = (
    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-zinc-500 dark:text-zinc-400">
      <SpinnerGap size={16} className="animate-spin" />読み込み中…
    </div>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-6 backdrop-blur-[2px] dark:bg-black/60"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        tabIndex={-1}
        className="flex h-[min(760px,92vh)] w-[min(1040px,96vw)] overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl outline-none dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {/* Section nav */}
        <nav aria-label="設定の項目" className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 px-3 py-5 dark:border-white/[0.06] dark:bg-zinc-950/40">
          <div className="px-2.5 pb-4">
            <p className="text-[15px] font-semibold tracking-tight">設定</p>
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400" title={currentCompany.rootPath}>{currentCompany.name}</p>
          </div>
          <div className="space-y-5 overflow-y-auto">
            {NAV.map(group => (
              <div key={group.group}>
                <p className="px-2.5 pb-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">{group.group}</p>
                <ul className="space-y-0.5">
                  {group.items.map(item => {
                    const active = activeTab === item.id
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          onClick={() => { setActiveTab(item.id); setSaved(false); setError(null) }}
                          className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 ${active
                            ? 'bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-zinc-200 dark:bg-white/[0.08] dark:text-zinc-50 dark:shadow-none dark:ring-white/[0.06]'
                            : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100'}`}
                        >
                          <span className={active ? 'text-indigo-600 dark:text-indigo-300' : 'text-zinc-400 dark:text-zinc-500'}>{item.icon}</span>
                          {item.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {/* Section content */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
          >
            <X size={18} />
          </button>

          <div className="flex-1 overflow-y-auto">
            {activeTab === 'sync' ? (
              <>
                {gitBinaryStatus && !gitBinaryStatus.bundled && (
                  <div className="px-8 pt-7">
                    <Callout tone="warning" title={`同梱のGitが使用できないため、システムのGitで動作しています（${gitBinaryStatus.binary}）`}>
                      古いGitでは大きなファイルの同期に失敗することがあるため、保護設定（http.postBuffer）を自動適用しています。
                    </Callout>
                  </div>
                )}
                <DownloadFoldersSection rootPath={currentCompany.rootPath} companyId={currentCompany.id} departments={departments} />
              </>
            ) : activeTab === 'voice' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="音声入力" description="相談画面で使う音声入力の設定です。" />
                <Card className="p-5"><VoiceShortcutSettings /></Card>
                <Card className="p-5"><VoicePromptSettings /></Card>
              </div>
            ) : activeTab === 'aienv' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="AIに渡す環境変数" description="このPCの環境変数のうち、AIと、AIが実行するコマンドから見えるものの設定です。" />
                <Card className="p-5"><AgentEnvSettings /></Card>
              </div>
            ) : activeTab === 'suggestions' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="入力候補" description="相談画面の入力欄に表示する候補の設定です。" />
                <Card className="p-5"><PromptSuggestionSettings /></Card>
              </div>
            ) : loading ? loadingState : activeTab === 'apikeys' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="APIキー" description="スキルやスクリプトが使う外部サービスのキーです。このPCの .env にだけ保存され、同期されません。" />
                <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                  <div className="p-5">
                    <SubHeading>よく使うAPIキー</SubHeading>
                    <div className="mt-4 space-y-3">
                      {COMMON_API_KEYS.map(({ key, label, placeholder }) => (
                        <div key={key} className="flex items-center gap-4">
                          <label htmlFor={`env-${key}`} className="w-32 shrink-0 text-[13px] text-zinc-600 dark:text-zinc-300">{label}</label>
                          <div className="relative flex-1">
                            <input
                              id={`env-${key}`}
                              type={visibleKeys.has(key) ? 'text' : 'password'}
                              value={envVars[key] || ''}
                              onChange={(e) => updateCommonKey(key, e.target.value)}
                              placeholder={placeholder}
                              className={`${INPUT} w-full pr-10 font-mono`}
                            />
                            <button
                              type="button"
                              onClick={() => toggleVisibility(key)}
                              aria-label={visibleKeys.has(key) ? '隠す' : '表示する'}
                              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                            >
                              {visibleKeys.has(key) ? <EyeSlash size={16} /> : <Eye size={16} />}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="p-5">
                    <SubHeading>カスタム環境変数</SubHeading>
                    <div className="mt-4 space-y-3">
                      {customKeys.map((item, index) => (
                        <div key={index} className="flex items-center gap-3">
                          <input
                            type="text"
                            value={item.key}
                            onChange={(e) => updateCustomKey(index, 'key', e.target.value.toUpperCase())}
                            placeholder="KEY_NAME"
                            aria-label="キー名"
                            className={`${INPUT} w-44 shrink-0 font-mono`}
                          />
                          <div className="relative flex-1">
                            <input
                              type={visibleKeys.has(`custom-${index}`) ? 'text' : 'password'}
                              value={item.value}
                              onChange={(e) => updateCustomKey(index, 'value', e.target.value)}
                              placeholder="value"
                              aria-label={`${item.key || 'キー'} の値`}
                              className={`${INPUT} w-full pr-10 font-mono`}
                            />
                            <button
                              type="button"
                              onClick={() => toggleVisibility(`custom-${index}`)}
                              aria-label={visibleKeys.has(`custom-${index}`) ? '隠す' : '表示する'}
                              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                            >
                              {visibleKeys.has(`custom-${index}`) ? <EyeSlash size={16} /> : <Eye size={16} />}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeCustomKey(index)}
                            aria-label={`${item.key || 'キー'} を削除`}
                            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-400/10 dark:hover:text-red-300"
                          >
                            <Trash size={16} />
                          </button>
                        </div>
                      ))}

                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value.toUpperCase())}
                          placeholder="新しいキー名"
                          aria-label="新しいキー名"
                          onKeyDown={(e) => e.key === 'Enter' && addCustomKey()}
                          className={`${INPUT} w-44 shrink-0 border-dashed font-mono`}
                        />
                        <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={addCustomKey} disabled={!newKeyName.trim()}>
                          <Plus size={14} />追加
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>

                <Callout tone="info">
                  <p>APIキーは <code className={CODE}>.env</code> ファイルに保存されます。スクリプトから <code className={CODE}>process.env.OPENAI_API_KEY</code> などで参照できます。</p>
                  <p className="mt-1">入力したキーを含む <code className={CODE}>.env</code> は同期されません（このPCにのみ保存されます）。</p>
                </Callout>
              </div>
            ) : activeTab === 'gitignore' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="同期しないファイル" description={<>ここに書いたファイルやフォルダは、チームと共有されません（<code className={CODE}>.gitignore</code>）。</>} />
                <textarea
                  value={gitignoreContent}
                  onChange={(e) => {
                    setGitignoreContent(e.target.value)
                    setSaved(false)
                  }}
                  aria-label=".gitignore の内容"
                  placeholder="# 同期対象外にするファイル/フォルダ&#10;.DS_Store&#10;node_modules/&#10;*.log"
                  className={TEXTAREA}
                  spellCheck={false}
                />
                <div className="grid grid-cols-2 gap-4">
                  <Card className="p-4 text-[13px] text-zinc-600 dark:text-zinc-300">
                    <SubHeading>自動で追加される項目</SubHeading>
                    <ul className="mt-2 space-y-1.5">
                      <li><code className={CODE}>.backups/</code> バックアップフォルダ</li>
                      <li><code className={CODE}>.env</code> / <code className={CODE}>.env.*</code> APIキーなどの秘密情報</li>
                      <li><code className={CODE}>100MB以上のファイル</code> 大容量ファイル</li>
                    </ul>
                  </Card>
                  <Card className="p-4 text-[13px] text-zinc-600 dark:text-zinc-300">
                    <SubHeading>書き方</SubHeading>
                    <ul className="mt-2 space-y-1.5">
                      <li><code className={CODE}>*.log</code> すべての .log ファイル</li>
                      <li><code className={CODE}>folder/</code> フォルダ全体</li>
                      <li><code className={CODE}># comment</code> コメント</li>
                    </ul>
                  </Card>
                </div>
              </div>
            ) : (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="環境変数（.env）" description={<>このPCの <code className={CODE}>.env</code> を直接編集します。1行に1つ、<code className={CODE}>KEY=value</code> の形式で書きます。</>} />
                <textarea
                  value={rawEnvContent}
                  onChange={(e) => {
                    setRawEnvContent(e.target.value)
                    setSaved(false)
                  }}
                  aria-label=".env の内容"
                  placeholder="OPENAI_API_KEY=sk-...&#10;ANTHROPIC_API_KEY=sk-ant-..."
                  className={TEXTAREA}
                  spellCheck={false}
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">コメント行は <code className={CODE}>#</code> で始めてください。</p>
              </div>
            )}
          </div>

          {hasSaveFooter && (
            <div className="flex items-center justify-between gap-4 border-t border-zinc-200 bg-white px-8 py-3 dark:border-white/[0.08] dark:bg-zinc-900">
              {error ? (
                <p role="alert" className="text-[13px] text-red-600 dark:text-red-300">{error}</p>
              ) : (
                <p className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
                  保存先: <code className={CODE}>{currentCompany.rootPath}/{activeTab === 'gitignore' ? '.gitignore' : '.env'}</code>
                </p>
              )}
              <Button variant="primary" onClick={saveChanges} disabled={saving} className="shrink-0">
                {saving ? <><SpinnerGap size={14} className="animate-spin" />保存中…</> : saved ? <><Check size={14} />保存しました</> : '保存'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

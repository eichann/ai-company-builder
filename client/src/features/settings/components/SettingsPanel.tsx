import { VoiceShortcutSettings } from '../../voice/components/VoiceShortcutSettings'
import { VoicePromptSettings } from '../../voice/components/VoicePromptSettings'
import { PromptSuggestionSettings } from './PromptSuggestionSettings'
import { AgentEnvSettings } from './AgentEnvSettings'
import { DownloadFoldersSection } from './DownloadFoldersSection'
import { AutoSyncSettings } from './AutoSyncSettings'
import { OwnKeysSection } from './OwnKeysSection'
import { LegacyKeysNote, MoveEnvKeysCard } from './MoveEnvKeysCard'
import { Button, Callout, Card, SectionHeader, SubHeading } from '../../../shared/ui/primitives'
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { X, Eye, EyeSlash, Plus, Trash, ArrowCounterClockwise, Code, Key, Check, FileX, CloudArrowDown, ArrowsClockwise, Microphone, SpinnerGap, Lightbulb, ShieldCheck, Info, LockKey } from '@phosphor-icons/react'
import { useAppStore } from '../../../stores/appStore'
import { useDepartments } from '../../../shared/hooks/useDepartments'
import { AGENT_LOG_NOTICE_TEXT, SANDBOX_NOTICE_TEXT } from '../../../shared/lib/agentLogNotice'
import { getGitBinaryStatus, readCompanyEnvStatus, readGitignore, updateCompanyEnv, writeGitignore } from '../api'
import { envChangesToSave, envDraftsFromText, envStatusLabel, normalizeEnvName } from '../model'
import type { EnvVarStatus } from '../../../../shared/env-file'

// Common API key definitions
const COMMON_API_KEYS = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'GOOGLE_API_KEY', label: 'Google AI', placeholder: 'AIza...' },
  { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI', placeholder: '' },
]
const commonKeySet = new Set(COMMON_API_KEYS.map(k => k.key))

interface SettingsPanelProps {
  onClose: () => void
  /** Section to open first (default: ダウンロードするフォルダ). */
  initialTab?: TabType
  /** 「自分の鍵」: the service to show first (from the chat's "no key" card). */
  focusService?: string
}

export type TabType = 'sync' | 'autosync' | 'gitignore' | 'ownkeys' | 'apikeys' | 'advanced' | 'aienv' | 'voice' | 'suggestions'

const NAV: Array<{ group: string; items: Array<{ id: TabType; label: string; icon: ReactNode }> }> = [
  {
    group: '同期',
    items: [
      { id: 'sync', label: 'ダウンロードするフォルダ', icon: <CloudArrowDown size={16} /> },
      { id: 'autosync', label: '自動同期', icon: <ArrowsClockwise size={16} /> },
      { id: 'gitignore', label: '同期しないファイル', icon: <FileX size={16} /> },
    ],
  },
  {
    group: 'AI と連携',
    items: [
      { id: 'ownkeys', label: '自分の鍵', icon: <LockKey size={16} /> },
      { id: 'apikeys', label: 'APIキー（このPC）', icon: <Key size={16} /> },
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

export function SettingsPanel({ onClose, initialTab = 'sync', focusService }: SettingsPanelProps) {
  const { currentCompany } = useAppStore()
  const { departments } = useDepartments(currentCompany?.id)
  const [gitBinaryStatus, setGitBinaryStatus] = useState<{ bundled: boolean; binary: string } | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>(initialTab)
  // Saved .env values never reach the renderer: only their status, plus what is typed here.
  const [envStatus, setEnvStatus] = useState<Record<string, EnvVarStatus>>({})
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({})
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set())
  const [addedKeys, setAddedKeys] = useState<string[]>([])
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())
  const [newKeyName, setNewKeyName] = useState('')
  const [pastedEnv, setPastedEnv] = useState('')
  const [gitignoreContent, setGitignoreContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Check which git binary is in use (warn when on the system git fallback)
  useEffect(() => {
    getGitBinaryStatus().then(setGitBinaryStatus).catch(() => {})
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
        const result = await readCompanyEnvStatus(currentCompany.rootPath)
        if (result.success && result.vars) {
          setEnvStatus(result.vars)
        } else if (result.error) {
          setError(result.error)
        }

        // Load .gitignore
        const gitignoreResult = await readGitignore(currentCompany.rootPath)
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

  // After a key moved to the server: the .env changed in main, read its state again.
  const reloadEnvStatus = useCallback(() => {
    if (!currentCompany?.rootPath) return
    void readCompanyEnvStatus(currentCompany.rootPath).then(r => { if (r.success && r.vars) setEnvStatus(r.vars) })
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

  const customKeys = [...Object.keys(envStatus).filter(k => !commonKeySet.has(k)), ...addedKeys.filter(k => !(k in envStatus))]

  const updateDraft = useCallback((key: string, value: string) => {
    setEnvDrafts(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }, [])

  // Marks a saved name for removal on save, or undoes that.
  const toggleRemoved = useCallback((key: string) => {
    setRemovedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setSaved(false)
  }, [])

  const addCustomKey = useCallback(() => {
    if (!newKeyName.trim()) return
    const normalized = normalizeEnvName(newKeyName)
    if ('error' in normalized) {
      setError(normalized.error)
      return
    }
    const keyName = normalized.name
    if (commonKeySet.has(keyName) || keyName in envStatus || addedKeys.includes(keyName)) {
      setError('このキー名は既に存在します')
      return
    }
    setError(null)
    setAddedKeys(prev => [...prev, keyName])
    setNewKeyName('')
    setSaved(false)
  }, [newKeyName, envStatus, addedKeys])

  const removeAddedKey = useCallback((key: string) => {
    setAddedKeys(prev => prev.filter(k => k !== key))
    setEnvDrafts(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // Save all changes
  const saveChanges = useCallback(async () => {
    if (!currentCompany?.rootPath) return

    setSaving(true)
    setError(null)
    try {
      if (activeTab === 'gitignore') {
        // Save .gitignore
        const result = await writeGitignore(currentCompany.rootPath, gitignoreContent)
        if (result) {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        } else {
          setError('保存に失敗しました')
        }
      } else {
        // .env: only typed values and removals are sent; main merges them into the file.
        const drafts = { ...envDrafts, ...envDraftsFromText(pastedEnv) }
        const changes = envChangesToSave(drafts, removedKeys)
        const result = await updateCompanyEnv(currentCompany.rootPath, changes)
        if (result.success) {
          const status = await readCompanyEnvStatus(currentCompany.rootPath)
          if (status.success && status.vars) setEnvStatus(status.vars)
          setEnvDrafts({})
          setRemovedKeys(new Set())
          setAddedKeys([])
          setPastedEnv('')
          setSaved(true)
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
  }, [currentCompany?.rootPath, activeTab, envDrafts, removedKeys, pastedEnv, gitignoreContent])

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
          <div className="min-h-0 space-y-5 overflow-y-auto">
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
          {/* Always shown, whatever section is open (owner decision: members are told). */}
          <p className="mt-auto flex shrink-0 gap-1.5 border-t border-zinc-200 px-2.5 pt-3 text-[11px] leading-relaxed text-zinc-500 dark:border-white/[0.06] dark:text-zinc-400">
            <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span><span className="block">{AGENT_LOG_NOTICE_TEXT}</span><span className="mt-1 block">{SANDBOX_NOTICE_TEXT}</span></span>
          </p>
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
            ) : activeTab === 'ownkeys' ? (
              <OwnKeysSection companyId={currentCompany.id} focusService={focusService} />
            ) : activeTab === 'aienv' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="AIに渡す環境変数" description="このPCの環境変数のうち、AIと、AIが実行するコマンドから見えるものの設定です。" />
                <Card className="p-5"><AgentEnvSettings /></Card>
              </div>
            ) : activeTab === 'autosync' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="自動同期" description="アプリを開いている間、決まったタイミングでサーバーと同期します。" />
                <AutoSyncSettings />
              </div>
            ) : activeTab === 'suggestions' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="入力候補" description="相談画面の入力欄に表示する候補の設定です。" />
                <Card className="p-5"><PromptSuggestionSettings /></Card>
              </div>
            ) : loading ? loadingState : activeTab === 'apikeys' ? (
              <div className="space-y-5 px-8 pb-8 pt-7">
                <SectionHeader title="APIキー（このPC）" description="スキルやスクリプトが使う外部サービスのキーです。このPCの .env にだけ保存され、同期されません。" />
                <LegacyKeysNote onOpenOwnKeys={() => setActiveTab('ownkeys')} />
                <MoveEnvKeysCard companyId={currentCompany.id} rootPath={currentCompany.rootPath} env={envStatus} onMoved={reloadEnvStatus} />
                <Card className="divide-y divide-zinc-100 dark:divide-white/[0.06]">
                  <div className="p-5">
                    <SubHeading>よく使うAPIキー</SubHeading>
                    <div className="mt-4 space-y-3">
                      {COMMON_API_KEYS.map(({ key, label, placeholder }) => (
                        <EnvKeyRow
                          key={key}
                          name={key}
                          label={<label htmlFor={`env-${key}`} className="w-32 shrink-0 text-[13px] text-zinc-600 dark:text-zinc-300">{label}</label>}
                          inputId={`env-${key}`}
                          status={envStatus[key]}
                          draft={envDrafts[key] ?? ''}
                          placeholder={placeholder}
                          visible={visibleKeys.has(key)}
                          removed={removedKeys.has(key)}
                          onDraft={value => updateDraft(key, value)}
                          onToggleVisible={() => toggleVisibility(key)}
                          onToggleRemoved={() => toggleRemoved(key)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="p-5">
                    <SubHeading>カスタム環境変数</SubHeading>
                    <div className="mt-4 space-y-3">
                      {customKeys.map(key => (
                        <EnvKeyRow
                          key={key}
                          name={key}
                          label={<code className={`${CODE} w-44 shrink-0 truncate py-1.5`} title={key}>{key}</code>}
                          status={envStatus[key]}
                          draft={envDrafts[key] ?? ''}
                          placeholder="値"
                          visible={visibleKeys.has(key)}
                          removed={removedKeys.has(key)}
                          onDraft={value => updateDraft(key, value)}
                          onToggleVisible={() => toggleVisibility(key)}
                          onToggleRemoved={() => (key in envStatus ? toggleRemoved(key) : removeAddedKey(key))}
                        />
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
                  <p className="mt-1">保存したキーは安全のため画面に表示しません（末尾4文字だけ表示します）。変えるときは新しいキーを入力して保存してください。</p>
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
                <SectionHeader title="環境変数（.env）" description={<>このPCの <code className={CODE}>.env</code> に、まとめて追加・上書きします。1行に1つ、<code className={CODE}>KEY=value</code> の形式で貼り付けてください。</>} />
                <LegacyKeysNote onOpenOwnKeys={() => setActiveTab('ownkeys')} />
                <MoveEnvKeysCard companyId={currentCompany.id} rootPath={currentCompany.rootPath} env={envStatus} onMoved={reloadEnvStatus} />
                <textarea
                  value={pastedEnv}
                  onChange={(e) => {
                    setPastedEnv(e.target.value)
                    setSaved(false)
                  }}
                  aria-label=".env に追加する内容"
                  placeholder="OPENAI_API_KEY=sk-...&#10;ANTHROPIC_API_KEY=sk-ant-..."
                  className={TEXTAREA}
                  spellCheck={false}
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">ここに書いた名前だけが変わり、ほかの項目はそのまま残ります。<code className={CODE}>#</code> で始まる行と、値が空の行は無視されます。</p>
                <Card className="p-5">
                  <SubHeading>保存されている項目</SubHeading>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">値は安全のため表示しません。</p>
                  {Object.keys(envStatus).length === 0 ? (
                    <p className="mt-3 text-[13px] text-zinc-500 dark:text-zinc-400">まだありません。</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {Object.keys(envStatus).map(key => (
                        <li key={key} className="flex items-center gap-3 text-[13px]">
                          <code className={`${CODE} truncate`} title={key}>{key}</code>
                          <span className={removedKeys.has(key) ? 'text-red-600 dark:text-red-300' : 'text-zinc-500 dark:text-zinc-400'}>
                            {removedKeys.has(key) ? '保存すると削除されます' : envStatusLabel(envStatus[key])}
                          </span>
                          <Button variant="ghost" className="ml-auto shrink-0" onClick={() => toggleRemoved(key)}>
                            {removedKeys.has(key) ? '元に戻す' : <><Trash size={14} />削除</>}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
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

/** One .env name: its saved status (never the value), a box for a new value, and removal. */
function EnvKeyRow({ name, label, inputId, status, draft, placeholder, visible, removed, onDraft, onToggleVisible, onToggleRemoved }: {
  name: string
  label: ReactNode
  inputId?: string
  status: EnvVarStatus | undefined
  draft: string
  placeholder: string
  visible: boolean
  removed: boolean
  onDraft: (value: string) => void
  onToggleVisible: () => void
  onToggleRemoved: () => void
}) {
  const saved = !!status?.set
  const statusText = removed ? '保存すると削除されます' : envStatusLabel(status)
  return (
    <div className="flex items-center gap-3">
      {label}
      <div className="relative flex-1">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          value={removed ? '' : draft}
          disabled={removed}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={removed ? statusText : saved ? `${statusText}。変更するときだけ入力` : placeholder}
          aria-label={inputId ? undefined : `${name} の値`}
          aria-describedby={`env-status-${name}`}
          className={`${INPUT} w-full pr-10 font-mono disabled:opacity-60`}
        />
        <span id={`env-status-${name}`} className="sr-only">{statusText}</span>
        <button
          type="button"
          onClick={onToggleVisible}
          aria-label={visible ? '隠す' : '表示する'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          {visible ? <EyeSlash size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {saved || !inputId ? (
        <button
          type="button"
          onClick={onToggleRemoved}
          aria-label={removed ? `${name} の削除を取り消す` : `${name} を削除`}
          className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-400/10 dark:hover:text-red-300"
        >
          {removed ? <ArrowCounterClockwise size={16} /> : <Trash size={16} />}
        </button>
      ) : (
        <span className="w-8 shrink-0" aria-hidden />
      )}
    </div>
  )
}

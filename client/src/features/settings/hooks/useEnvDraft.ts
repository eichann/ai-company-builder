// 「API キー・環境変数（この PC）」: the company .env's status (names, set or not, last 4 — never a value)
// and what the member typed until it is saved. Held by the settings' frame, so a draft survives moving
// to another section; nothing typed is written anywhere before 保存.
import { useCallback, useRef, useState } from 'react'
import type { UnsavedChanges } from '../../../shared/lib/unsavedChanges'
import type { EnvVarStatus } from '../../../../shared/env-file'
import { readCompanyEnvStatus, updateCompanyEnv } from '../api'
import { envChangesToSave, envDraftsFromText, normalizeEnvName } from '../model'

/** The keys offered by name (the rest are 「カスタム環境変数」). */
export const COMMON_API_KEYS = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'GOOGLE_API_KEY', label: 'Google AI', placeholder: 'AIza...' },
  { key: 'AZURE_OPENAI_API_KEY', label: 'Azure OpenAI', placeholder: '' },
]
const commonKeySet = new Set(COMMON_API_KEYS.map(k => k.key))

export function useEnvDraft(rootPath: string) {
  const [status, setStatus] = useState<Record<string, EnvVarStatus>>({})
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [added, setAdded] = useState<string[]>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const result = await readCompanyEnvStatus(rootPath)
      if (result.success && result.vars) setStatus(result.vars)
      else if (result.error) setError(result.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [rootPath])

  // Read when the section is first shown (a callback ref: the renderer's effect count is capped).
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || !rootPath || loadedFor.current === rootPath) return
    loadedFor.current = rootPath
    void reload()
  }, [rootPath, reload])

  const customKeys = [...Object.keys(status).filter(k => !commonKeySet.has(k)), ...added.filter(k => !(k in status))]
  // Only typed values and removals are sent; main merges them into the file.
  const changes = envChangesToSave({ ...drafts, ...envDraftsFromText(pasted) }, removed)
  const dirty = Object.keys(changes).length > 0
  // Also typed but not a value to save yet (a new name, a paste without values): asked about at closing.
  const typed = dirty || added.length > 0 || newKeyName.trim() !== '' || pasted.trim() !== ''

  const setDraft = (key: string, value: string) => setDrafts(prev => ({ ...prev, [key]: value }))
  const toggleRemoved = (key: string) => setRemoved(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const addCustomKey = () => {
    if (!newKeyName.trim()) return
    const normalized = normalizeEnvName(newKeyName)
    if ('error' in normalized) { setError(normalized.error); return }
    const name = normalized.name
    if (commonKeySet.has(name) || name in status || added.includes(name)) { setError('このキー名は既に存在します'); return }
    setError(null)
    setAdded(prev => [...prev, name])
    setNewKeyName('')
  }
  const removeAddedKey = (key: string) => {
    setAdded(prev => prev.filter(k => k !== key))
    setDrafts(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  /** null = saved (the typed values are dropped from memory at once); else why not. */
  const save = async (): Promise<string | null> => {
    if (!dirty) return null
    const result = await updateCompanyEnv(rootPath, changes)
    if (!result.success) return result.error || '保存に失敗しました'
    const after = await readCompanyEnvStatus(rootPath)
    if (after.success && after.vars) setStatus(after.vars)
    setDrafts({})
    setRemoved(new Set())
    setAdded([])
    setPasted('')
    return null
  }

  const unsaved: UnsavedChanges = { pending: () => (typed ? 'API キー・環境変数の入力' : null), save }

  return {
    loadRef, loading, status, drafts, removed, customKeys, newKeyName, pasted, error, dirty, unsaved, save,
    setDraft, toggleRemoved, addCustomKey, removeAddedKey, setNewKeyName, setPasted, setError,
    reload: () => { void reload() },
  }
}

export type EnvDraft = ReturnType<typeof useEnvDraft>

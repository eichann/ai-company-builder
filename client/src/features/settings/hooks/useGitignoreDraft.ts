// 「同期しないファイル」: the company's root .gitignore and the member's unsaved edit of it. Editable only
// once the server says this member is an owner or admin (canEditCompanyGitignore); read-only until then.
// Held by the settings' frame, so an edit survives moving to another section.
import { useCallback, useRef, useState } from 'react'
import type { UnsavedChanges } from '../../../shared/lib/unsavedChanges'
import { canEditCompanyGitignore, readGitignore, writeGitignore } from '../api'

export function useGitignoreDraft(companyId: string, rootPath: string) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [editable, setEditable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [read, setRead] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read when the section is first shown (a callback ref: the renderer's effect count is capped).
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || !rootPath || loadedFor.current === rootPath) return
    loadedFor.current = rootPath
    void canEditCompanyGitignore(companyId).then(setEditable)
    void readGitignore(rootPath)
      .then(text => { setContent(text || ''); setSaved(text || ''); setRead(true) })
      .catch(e => setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => setLoading(false))
  }, [companyId, rootPath])

  // Editable once the role and the file have both arrived: an edit typed before the file would be
  // overwritten by it, and a save after a failed read would replace the file with only that edit.
  const canEdit = editable && read
  const dirty = canEdit && content !== saved

  const save = async (): Promise<string | null> => {
    if (!dirty) return null
    if (!await writeGitignore(rootPath, content)) return '保存に失敗しました'
    setSaved(content)
    return null
  }

  const unsaved: UnsavedChanges = { pending: () => (dirty ? '同期しないファイル（.gitignore）の変更' : null), save }

  return {
    loadRef, loading, content, editable: canEdit, dirty, error, unsaved, save, setError,
    edit: (text: string) => { if (canEdit) setContent(text) },
  }
}

export type GitignoreDraft = ReturnType<typeof useGitignoreDraft>

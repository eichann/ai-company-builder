import { useCallback, useRef, useState } from 'react'
import type { DriveTrustedFolder } from '../../../../../shared/types/google-drive'
import { Button } from '../../../shared/ui/primitives'
import { getDriveTrustedFolders, untrustDriveFolder } from '../api'

/**
 * 「このフォルダはもう聞かない」 folders (google-drive.md "Asking before a put"): the member's own, each with the people
 * outside who could see it when it was trusted; ［聞くように戻す］ asks again before every put there. Shown only when
 * there is one.
 */
export function DriveTrustedFolders({ companyId }: { companyId: string }) {
  const [folders, setFolders] = useState<DriveTrustedFolder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await getDriveTrustedFolders(companyId)
    if (r.success) { setFolders(r.folders); setError(null) } else setError(r.error)
  }, [companyId])
  // Loaded when the element mounts (a callback ref: the renderer's effect count is capped, renderer-structure.md "Effects").
  const loadedFor = useRef<string | null>(null)
  const loadRef = useCallback((el: HTMLElement | null) => {
    if (!el || loadedFor.current === companyId) return
    loadedFor.current = companyId
    void reload()
  }, [companyId, reload])
  const untrust = async (folderId: string) => {
    setBusy(folderId)
    try {
      const r = await untrustDriveFolder(companyId, folderId)
      if (r.success) await reload()
      else setError(r.error)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div ref={loadRef} data-testid="drive-trusted-folders" className={folders.length === 0 && !error ? 'hidden' : 'space-y-1 pt-2'}>
      <p className="text-[12px] font-medium">「もう聞かない」にしたフォルダ</p>
      <p className="text-[12px] text-zinc-500">社外の人も見られるフォルダでも、AI が確かめずに置きます（見られる社外の人が変わったら、また聞きます）。</p>
      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
      <ul className="space-y-1">
        {folders.map(f => (
          <li key={f.folderId} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="min-w-0 truncate">{f.folderName || '（名前のないフォルダ）'}{f.outsideDomains.length > 0 ? `（${f.outsideDomains.filter(d => d !== '?').join('・') || '社外'} の人も見られます）` : ''}</span>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void untrust(f.folderId)}>聞くように戻す</Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the actions that replace or remove the member's work on
// their behalf, with the preload API faked in memory:
//   ?view=preview  the sync preview (real useSync + SyncPreviewDialog): 「元に戻す」 and the 作業メモ
//   ?view=backups  the backup history: 復元
//   ?view=skills   新しいスキル / コピー (real useSkillsTab + the two dialogs)
//
// window.__acbCalls  every write asked for, as [method, ...args]
// window.__acbFail   names of the calls that fail next (a spec adds them)
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { useSync } from '../src/features/sync/hooks/useSync'
import { useSkillsTab } from '../src/features/skills/hooks/useSkillsTab'
import { SyncPreviewDialog } from '../src/features/sync/components/SyncPreviewDialog'
import { BackupHistorySlideOver } from '../src/features/sync/components/BackupHistorySlideOver'
import { NewSkillWizard } from '../src/features/skills/components/NewSkillWizard'
import { CopySkillModal } from '../src/features/skills/components/CopySkillModal'
import { installElectronAPI } from './ui/fixtures/electron-api'

const ROOT = '/Users/demo/会社'
const calls: unknown[][] = []
const fail = new Set<string>()
Object.assign(window, { __acbCalls: calls, __acbFail: fail })
const failing = (name: string) => { if (!fail.has(name)) return false; fail.delete(name); return true }

const changes = { added: ['営業部/新規メモ.md'], modified: ['営業部/提案書.md'], deleted: [] as string[] }
// Skill folders already on this computer, and one only the server has.
const existing = new Set([`${ROOT}/営業部/.claude/skills/proposal`])
const DEPARTMENTS = [
  { id: 'd-sales', name: '営業部', folder: '営業部', color: '#6366f1', icon: 'Briefcase', description: '' },
  { id: 'd-hr', name: '人事部', folder: '人事部', color: '#10b981', icon: 'Users', description: '' },
]

installElectronAPI({
  gitPreview: async () => ({ success: true, hasChanges: true, changes, totalCount: 2 }),
  gitRevertFile: async (_root, file, status) => {
    calls.push(['gitRevertFile', file, status])
    if (failing('gitRevertFile')) return { success: false, error: 'fatal: unable to unlink' }
    changes.added = changes.added.filter(f => f !== file)
    changes.modified = changes.modified.filter(f => f !== file)
    return { success: true }
  },
  gitSync: async (_root, _company, message) => {
    calls.push(['gitSync', message])
    return failing('gitSync')
      ? { success: false, error: 'サーバーに接続できませんでした', errorType: 'network' }
      : { success: true, message: '同期しました' }
  },
  backupList: async () => ({
    success: true,
    backups: [{ id: '2026-10-30T09-00-00-000', timestamp: '2026-10-30T09:00:00.000Z', reason: 'conflict', files: ['営業部/提案書.md'], path: `${ROOT}/.backups/2026-10-30T09-00-00-000` }],
  }),
  backupRestore: async (_root, id, file) => {
    calls.push(['backupRestore', id, file])
    if (failing('backupRestore')) return { success: false, error: '今の内容を .backups に保存できなかったため、復元しませんでした。何も変更していません。' }
    return { success: true, message: `Restored: ${file}`, keptPath: `${ROOT}/.backups/2026-10-31T00-00-00-000_before_restore` }
  },
  exists: async p => existing.has(p),
  makeSkillPrivate: async (_root, rel) => {
    calls.push(['makeSkillPrivate', rel])
    return rel.includes('/shared-one/')
      ? { success: false, error: 'このスキルはすでに会社で共有されているため、非公開にはできません。', code: 'already_shared' as const }
      : { success: true }
  },
  createDirectory: async p => { calls.push(['createDirectory', p]); return true },
  createFile: async p => { calls.push(['createFile', p]); return { success: true } },
  copyItem: async (from, to) => { calls.push(['copyItem', from, to]); return { success: true } },
  readFile: async () => '---\nname: 提案書\ndescription: 提案書を作る\n---\n',
  writeFile: async p => { calls.push(['writeFile', p]); return true },
  listSkills: async (_root, folder) => ({
    success: true,
    skills: folder !== '営業部' ? [{
      id: 'd-hr-interview', name: '面接メモ', description: '面接のメモをまとめる', departmentId: 'd-hr',
      skillPath: `${ROOT}/人事部/.claude/skills/interview`, files: { skillMd: `${ROOT}/人事部/.claude/skills/interview/SKILL.md` },
    }] : [],
  }),
})

function PreviewView() {
  const sync = useSync({ rootPath: ROOT, companyId: 'demo', onSynced: async () => {} })
  return (
    <div className="p-6">
      <button onClick={() => { void sync.handlePreview() }} className="px-3 py-1.5 rounded bg-accent text-white text-sm">変更を確認</button>
      <output aria-label="同期の結果" className="block mt-2 text-xs">{sync.syncNotification?.message ?? ''}</output>
      {sync.previewData && (
        <SyncPreviewDialog
          isOpen={sync.showPreview}
          onClose={() => sync.setShowPreview(false)}
          changes={sync.previewData.changes}
          totalCount={sync.previewData.totalCount}
          rootPath={ROOT}
          onSync={message => { sync.setShowPreview(false); void sync.handleSync(message) }}
          isSyncing={sync.isSyncing}
          onRevertFile={sync.handleRevertFile}
          commitMessage={sync.commitMemo}
          onCommitMessageChange={sync.setCommitMemo}
        />
      )}
    </div>
  )
}

function SkillsView() {
  const [selected, setSelected] = useState('')
  const tab = useSkillsTab({ rootPath: ROOT, departments: DEPARTMENTS, departmentFolder: '営業部', departmentId: 'd-sales-営業部', skills: [], refreshSkills: () => {} })
  if (tab.selectedSkillId && tab.selectedSkillId !== selected) setSelected(tab.selectedSkillId)
  return (
    <div className="p-6 space-x-2">
      <button onClick={() => tab.setWizardOpen(true)} className="px-3 py-1.5 rounded bg-accent text-white text-sm">新しいスキル</button>
      <button onClick={() => tab.setCopyOpen(true)} className="px-3 py-1.5 rounded bg-accent text-white text-sm">スキルをコピー</button>
      <output aria-label="選んだスキル" className="block mt-2 text-xs">{selected}</output>
      {tab.wizardOpen && <NewSkillWizard departmentName="営業部" color="#6366f1" onClose={() => tab.setWizardOpen(false)} onComplete={tab.create} />}
      {tab.copyOpen && <CopySkillModal rootPath={ROOT} currentDepartmentId="d-sales" departments={DEPARTMENTS} color="#6366f1" onClose={() => tab.setCopyOpen(false)} onCopy={tab.copy} />}
    </div>
  )
}

function Preview() {
  const view = new URLSearchParams(location.search).get('view') ?? 'preview'
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-950 text-sm">
      <p className="p-6 pb-0 text-gray-500">表示確認用の人工データです。</p>
      {view === 'preview' && <PreviewView />}
      {view === 'backups' && <BackupHistorySlideOver isOpen onClose={() => {}} rootPath={ROOT} />}
      {view === 'skills' && <SkillsView />}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

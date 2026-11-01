import { FileTreePanel } from '../features/files/components/FileTreePanel'
import { TabbedEditorPanel } from '../features/editor/components/TabbedEditorPanel'
import { SplitView } from '../features/workspace/components/SplitView'
import { PANE_LIMITS, type SplitNode } from '../features/workspace/layoutTree'
import { LinkToTaskDialog } from '../features/tasks/components/LinkToTaskDialog'
import { useLinkToTask } from '../features/tasks/hooks/useLinkToTask'
import { isPathWithin, normalizePathSeparators } from '../shared/lib/path'
import { useAppStore } from '../stores/appStore'

interface Props {
  split: SplitNode
  paneClassName: (paneId: string) => string
  dividerLabel: (splitId: string) => string
  onResizeStart: (splitId: string, dividerIndex: number) => void
  onResize: (splitId: string, dividerIndex: number, offset: number) => void
  rootPath: string
  departmentFolder: string
  openFiles: string[]
  activeFilePath: string | null
  previewFilePath: string | null
  tabLabels: Record<string, string>
  onOpenFile: (filePath: string) => void
  onPinFile: (filePath: string) => void
  onSelectOpenFile: (filePath: string) => void
  onCloseFile: (filePath: string) => void
  onPrivateFolderCreated: () => void
}

/** The ファイル tab: the file tree (files) and the open files (editor), split by the layout tree. */
export function FilesPanel(props: Props) {
  const companyId = useAppStore(s => s.currentCompany?.id)
  const linkToTask = useLinkToTask(companyId)
  // The server takes a path relative to the company folder (the member's folder is the company's clone).
  const companyPathOf = (path: string) => {
    const p = normalizePathSeparators(path)
    const root = normalizePathSeparators(props.rootPath).replace(/\/+$/, '')
    return isPathWithin(p, root) && p !== root ? p.slice(root.length + 1) : null
  }
  return (
    <>
    <SplitView
      split={props.split}
      limits={PANE_LIMITS}
      className="h-full min-w-0"
      paneClassName={props.paneClassName}
      dividerLabel={props.dividerLabel}
      onResizeStart={props.onResizeStart}
      onResize={props.onResize}
      renderPane={(paneId) => paneId === 'fileTree' ? (
        <FileTreePanel
          rootPath={props.rootPath}
          departmentFolder={props.departmentFolder}
          selectedFilePath={props.activeFilePath}
          onSelectFile={props.onOpenFile}
          onDoubleClickFile={props.onPinFile}
          onPrivateFolderCreated={props.onPrivateFolderCreated}
          onLinkToTask={companyId ? path => { const rel = companyPathOf(path); if (rel) linkToTask.open(rel) } : undefined}
        />
      ) : (
        <TabbedEditorPanel
          openFiles={props.openFiles}
          activeFilePath={props.activeFilePath}
          previewFilePath={props.previewFilePath}
          tabLabels={props.tabLabels}
          onSelectFile={props.onSelectOpenFile}
          onCloseFile={props.onCloseFile}
          onPinFile={props.onPinFile}
        />
      )}
    />
    {linkToTask.state && (
      <LinkToTaskDialog
        key={linkToTask.state.companyPath}
        companyPath={linkToTask.state.companyPath}
        phase={linkToTask.state.phase}
        onChoose={linkToTask.choose}
        onClose={linkToTask.close}
      />
    )}
    </>
  )
}

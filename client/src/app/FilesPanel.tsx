import type { ReactNode } from 'react'
import { FileTreePanel } from '../features/files/components/FileTreePanel'
import { TabbedEditorPanel } from '../features/editor/components/TabbedEditorPanel'
import { SplitView } from '../features/workspace/components/SplitView'
import { PANE_LIMITS, type SplitNode } from '../features/workspace/layoutTree'

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
  /** ← → in front of the editor's tabs. */
  navigation?: ReactNode
  /** A record's card shown in the editor area instead of the active file. */
  overlay?: ReactNode
  /** Beside the active file. */
  aside?: ReactNode
  /** 「やることにつなぐ…」 in the tree's menu (absent where the company shows no task list). */
  onLinkToTask?: (path: string) => void
}

/** The ファイル tab: the file tree (files) and the open files (editor), split by the layout tree. */
export function FilesPanel(props: Props) {
  return (
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
          onLinkToTask={props.onLinkToTask}
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
          navigation={props.navigation}
          overlay={props.overlay}
          aside={props.aside}
        />
      )}
    />
  )
}

import { Cloud, DownloadSimple, SpinnerGap, WarningCircle, WifiSlash } from '@phosphor-icons/react'
import type { DownloadError } from '../hooks/useDepartmentDownload'

interface Props {
  departmentName: string | undefined
  color: string | undefined
  isDownloading: boolean
  error: DownloadError | null
  onDownload: () => void
}

/** Over the left panel while the selected department is not on this computer (the panel stays mounted). */
export function DepartmentDownloadPrompt({ departmentName, color, isDownloading, error, onDownload }: Props) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
      <div className="text-center max-w-md px-6">
        <div className="w-20 h-20 rounded-2xl bg-gray-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-6">
          <Cloud size={40} className="text-gray-400 dark:text-zinc-500" />
        </div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-zinc-200 mb-2">
          {departmentName}
        </h2>
        <p className="text-gray-500 dark:text-zinc-400 mb-8">
          この部署のファイルはまだダウンロードされていません。
          ダウンロードすると、ファイルの閲覧・編集・AIチャットが利用できます。
        </p>
        <button
          onClick={onDownload}
          disabled={isDownloading}
          className="
            inline-flex items-center gap-2.5 px-6 py-3 rounded-xl
            text-white font-medium text-sm
            transition-all hover:brightness-110 active:scale-[0.98]
            disabled:opacity-50 disabled:cursor-not-allowed
          "
          style={{ backgroundColor: color || '#6366f1' }}
        >
          {isDownloading ? (
            <SpinnerGap size={18} className="animate-spin" />
          ) : (
            <DownloadSimple size={18} weight="bold" />
          )}
          {isDownloading ? 'ダウンロード中...' : 'ダウンロードして同期を開始'}
        </button>
        {error && !isDownloading && (
          <p
            role="alert"
            className={`mt-4 inline-flex items-start gap-2 text-left text-sm ${error.offline ? 'text-zinc-700 dark:text-zinc-200' : 'text-red-600 dark:text-red-300'}`}
          >
            {error.offline
              ? <WifiSlash size={16} className="mt-0.5 shrink-0 text-zinc-500" />
              : <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0" />}
            <span className="break-words">
              {error.offline
                ? 'インターネットにつながっているときにダウンロードできます。何も変更していません。'
                : `ダウンロードできませんでした：${error.message}`}
            </span>
          </p>
        )}
      </div>
    </div>
  )
}

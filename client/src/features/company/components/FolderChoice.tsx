// Where the chosen company's folder goes: an existing folder, or a new one made
// inside a folder the member picks (<picked>/<company>).
import { ArrowRight, Check, CloudArrowDown, FolderOpen, SpinnerGap } from '@phosphor-icons/react'
import type { CompanyInfo } from '../../../../shared/ipc-contract'
import { BACK_BUTTON, ChoiceButton, ErrorNotice, PRIMARY_BUTTON, ScreenHeading } from './SelectorParts'

export function FolderChoice({ company, error, isPreparing, onOpenExisting, onCreateNew, onBack }: {
  company: CompanyInfo
  error: string | null
  isPreparing: boolean
  onOpenExisting: () => void
  onCreateNew: () => void
  onBack: () => void
}) {
  return (
    <div className="space-y-6">
      <ScreenHeading icon={FolderOpen} title={company.name}>
        作業フォルダを選択してください
      </ScreenHeading>

      <ErrorNotice error={error} />

      <div className="space-y-3">
        <ChoiceButton
          onClick={onOpenExisting}
          disabled={isPreparing}
          icon={<FolderOpen size={20} className="text-accent" />}
          title="既存のフォルダを開く"
          detail="すでにある作業フォルダを選択"
        />
        <ChoiceButton
          onClick={onCreateNew}
          dashed
          icon={<CloudArrowDown size={20} className="text-accent" />}
          title="新しく作成"
          detail="新しいフォルダを作成してセットアップ"
        />
      </div>

      <button onClick={onBack} className={`w-full ${BACK_BUTTON}`}>
        戻る
      </button>
    </div>
  )
}

export function NewFolderChoice({ company, error, parentFolder, isPreparing, onPickParent, onStart, onBack }: {
  company: CompanyInfo
  error: string | null
  /** The folder the company folder is made in; '' until picked. */
  parentFolder: string
  isPreparing: boolean
  onPickParent: () => void
  onStart: () => void
  onBack: () => void
}) {
  return (
    <div className="space-y-6">
      <ScreenHeading icon={CloudArrowDown} title="作業フォルダを設定">
        「{company.name}」のローカル作業フォルダを選択してください
      </ScreenHeading>

      <ErrorNotice error={error} />

      <div className="space-y-4">
        <button
          onClick={onPickParent}
          className={`w-full text-left p-4 rounded-lg border transition-colors ${
            parentFolder
              ? 'border-accent bg-accent/10'
              : 'border-border hover:border-accent/50'
          }`}
        >
          <div className="flex items-center gap-3">
            <FolderOpen size={24} className="text-accent" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-text-primary">
                {parentFolder ? 'フォルダを選択済み' : 'フォルダを選択'}
              </div>
              <div className="text-sm text-text-secondary truncate">
                {parentFolder || '作業フォルダの親ディレクトリを選択...'}
              </div>
            </div>
            {parentFolder && <Check size={20} className="text-accent" />}
          </div>
        </button>

        {parentFolder && (
          <div className="p-3 rounded-lg bg-sidebar-bg text-sm">
            <div className="text-text-secondary mb-1">作成されるフォルダ:</div>
            <div className="text-text-primary font-mono">
              {parentFolder}/{company.name}
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button onClick={onBack} className={BACK_BUTTON}>
          戻る
        </button>
        <button onClick={onStart} disabled={!parentFolder || isPreparing} className={PRIMARY_BUTTON}>
          {isPreparing ? (
            <SpinnerGap size={20} className="animate-spin" />
          ) : (
            <>
              開始
              <ArrowRight size={18} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}

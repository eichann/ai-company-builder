import type { ReactNode } from 'react'
import { Check, CheckCircle, FolderOpen, GitBranch, SpinnerGap } from '@phosphor-icons/react'
import { formatBytes } from '../../../shared/lib/download-selection'
import type { SetupKind, SetupStep } from '../model'

/** The setup screen: a first download says it can take a while and shows the bytes received. */
export function SetupProgress({ kind, step, error, receivedBytes, onBack }: {
  kind: SetupKind
  step: SetupStep
  error: string | null
  receivedBytes: number
  onBack: () => void
}) {
  const reopen = kind === 'reopen'
  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-accent/10 flex items-center justify-center">
          {step === 'done' ? (
            <CheckCircle size={40} className="text-green-400" weight="fill" />
          ) : (
            <SpinnerGap size={40} className="animate-spin text-accent" />
          )}
        </div>
        <h1 className="text-2xl font-bold text-text-primary mb-2">
          {step === 'done'
            ? (reopen ? '準備完了' : 'セットアップ完了')
            : (reopen ? 'フォルダを開いています...' : 'セットアップ中...')}
        </h1>
        <p className="text-text-secondary">
          {step === 'done'
            ? '準備が整いました'
            : kind === 'firstSetup'
              ? '初回のみ。会社のファイルが多いと、ダウンロードに数分かかることがあります'
              : 'サーバーの最新の内容を確認しています'}
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
          <button onClick={onBack} className="block mt-2 text-accent hover:underline">
            戻る
          </button>
        </div>
      )}

      <div className="space-y-3">
        <StepRow
          active={step === 'folder'}
          finished={step === 'git' || step === 'done'}
          idleIcon={<FolderOpen size={16} className="text-zinc-400" />}
          title="フォルダ構造を作成"
          detail="部署フォルダの初期化"
        />
        <StepRow
          active={step === 'git'}
          finished={step === 'done'}
          idleIcon={<GitBranch size={16} className="text-zinc-400" />}
          title="同期設定"
          detail={step === 'git' && receivedBytes > 0
            ? `ダウンロード中… ${formatBytes(receivedBytes)} 受信`
            : 'サーバーとの接続を確立'}
        />
      </div>
    </div>
  )
}

function StepRow({ active, finished, idleIcon, title, detail }: {
  active: boolean
  finished: boolean
  idleIcon: ReactNode
  title: string
  detail: string
}) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg ${
      active ? 'bg-accent/10 border border-accent/30' : 'bg-sidebar-bg'
    }`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
        active ? 'bg-accent' : finished ? 'bg-green-500' : 'bg-zinc-700'
      }`}>
        {active ? (
          <SpinnerGap size={16} className="animate-spin text-white" />
        ) : finished ? (
          <Check size={16} className="text-white" weight="bold" />
        ) : idleIcon}
      </div>
      <div>
        <div className="text-text-primary font-medium">{title}</div>
        <div className="text-sm text-text-secondary">{detail}</div>
      </div>
    </div>
  )
}

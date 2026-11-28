import type { ReactNode } from 'react'
import { Check, CheckCircle, CloudArrowDown, FolderOpen, SpinnerGap } from '@phosphor-icons/react'
import { formatBytes } from '../../../shared/lib/download-selection'
import type { SetupKind, SetupStep } from '../model'

/**
 * The setup screen: a first download says it can take a while and shows the bytes received.
 * In the members' words, not the builders' (UX review 20, owner decision 9): no 「セットアップ」,
 * 「フォルダ構造」 or 「同期設定」.
 */
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
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-selected-bg flex items-center justify-center">
          {step === 'done' ? (
            <CheckCircle size={40} className="text-success-text" weight="fill" />
          ) : (
            <SpinnerGap size={40} className="animate-spin text-primary" />
          )}
        </div>
        <h1 className="text-2xl font-bold text-text mb-2">
          {step === 'done'
            ? '準備ができました'
            : (reopen ? '会社のフォルダを開いています' : '準備しています')}
        </h1>
        <p className="text-text-muted">
          {step === 'done'
            ? 'まもなく始まります'
            : kind === 'firstSetup'
              ? '初めてのときだけです。会社のファイルが多いと、数分かかることがあります'
              : 'いちばん新しい内容を確かめています'}
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-control bg-danger-bg border border-danger-border text-danger-text text-sm">
          {error}
          <button onClick={onBack} className="block mt-2 text-link hover:underline">
            戻る
          </button>
        </div>
      )}

      <div className="space-y-3">
        <StepRow
          active={step === 'folder'}
          finished={step === 'git' || step === 'done'}
          idleIcon={<FolderOpen size={16} className="text-zinc-400" />}
          title={reopen ? '会社のフォルダを確かめています' : '会社のフォルダを用意しています'}
          detail={reopen ? 'この PC にあるフォルダを使います' : '部署のフォルダも用意します'}
        />
        <StepRow
          active={step === 'git'}
          finished={step === 'done'}
          idleIcon={<CloudArrowDown size={16} className="text-zinc-400" />}
          title={reopen ? 'いちばん新しい内容を受け取っています' : '会社のファイルを受け取っています'}
          detail={step === 'git' && receivedBytes > 0
            ? `${formatBytes(receivedBytes)} 受け取りました`
            : '会社のサーバーにつないでいます'}
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
    <div className={`flex items-center gap-3 p-3 rounded-control ${
      active ? 'bg-selected-bg border border-selected-border' : 'bg-bg'
    }`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
        active ? 'bg-primary' : finished ? 'bg-green-500' : 'bg-zinc-700'
      }`}>
        {active ? (
          <SpinnerGap size={16} className="animate-spin text-white" />
        ) : finished ? (
          <Check size={16} className="text-white" weight="bold" />
        ) : idleIcon}
      </div>
      <div>
        <div className="text-text font-medium">{title}</div>
        <div className="text-sm text-text-muted">{detail}</div>
      </div>
    </div>
  )
}

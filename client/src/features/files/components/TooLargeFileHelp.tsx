// 「大きすぎて共有されていません」: why a file over 100 MB stays on this computer
// (sync.md step 4) and what the member can do instead, in plain words.
import { useId } from 'react'
import { X } from '@phosphor-icons/react'
import { Button } from '../../../shared/ui/primitives'
import { Dialog, DialogTitle } from '../../../shared/ui/Dialog'

export const TOO_LARGE_TITLE = '大きすぎて共有されていません'

const NEXT_STEPS: Array<{ title: string; body: string }> = [
  { title: '小さくする', body: '動画や画像は、書き出すときの画質やサイズを下げます。PDF は「サイズを縮小」で保存し直します。小さくしたものは、別の名前で保存してください（同じ名前のままだと、共有されないままになります）。' },
  { title: '分ける', body: '章ごと・月ごとなどに分けて、1つずつが 100MB より小さいファイルにします。' },
  { title: '共有のリンクで渡す', body: 'Google ドライブなどに置いて、見てほしい人にリンクを伝えます。リンクを書いたメモをこのフォルダに置くと、ほかの人も見つけられます。' },
]

/** A modal panel over the tree; Escape / 閉じる / a click outside close it. */
export function TooLargeFileHelp({ name, onClose }: { name: string; onClose: () => void }) {
  const titleId = useId()

  return (
    <Dialog onClose={onClose} labelledBy={titleId} padded={false} className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <DialogTitle id={titleId}>{TOO_LARGE_TITLE}</DialogTitle>
            <p className="mt-1 break-all text-small text-text-muted">{name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-text-subtle hover:bg-surface-sunken hover:text-text"
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4 text-body leading-relaxed text-zinc-700 dark:text-zinc-300">
          <p>100MB をこえるファイルは、同期してもほかの人には届きません。このファイルはこのPCにだけあり、消えたわけではありません。</p>
          <div>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">ほかの人にも見てもらうには</p>
            <ol aria-label="ほかの人にも見てもらうには" className="mt-2 space-y-3">
              {NEXT_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-caption font-medium tabular-nums text-zinc-500 dark:bg-white/[0.08] dark:text-zinc-400">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{step.title}</p>
                    <p className="mt-0.5 text-small text-zinc-600 dark:text-zinc-400">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex justify-end border-t border-[color:var(--color-border)] px-5 py-3">
          <Button autoFocus onClick={onClose}>閉じる</Button>
        </div>
    </Dialog>
  )
}

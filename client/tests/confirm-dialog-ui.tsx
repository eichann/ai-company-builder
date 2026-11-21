/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Trash } from '@phosphor-icons/react'
import '../src/i18n'
import '../src/index.css'
import { ConfirmDialog } from '../src/shared/ui/ConfirmDialog'
import { ContextMenu } from '../src/shared/ui/ContextMenu'
import { MoreMenu } from '../src/shared/ui/MoreMenu'
import { Button } from '../src/shared/ui/primitives'

// Preview page for the confirm dialog and the danger actions (design-system.md P1): a danger
// confirm, an ordinary one, one that may open while the member is typing (confirmOnEnter off),
// a second dialog stacked on the first, the right-click menu and 「…」 with a danger item.
// `?theme=dark` for dark mode, `?open=danger|ordinary|menu|more` to start with one open.
// Answers are appended to #log (and window.__acbLog).

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

type Which = 'danger' | 'ordinary' | 'typing' | 'stacked'
const log: string[] = []
;(window as unknown as { __acbLog: string[] }).__acbLog = log
// A panel underneath that closes on Esc (a slide-over): the dialog's Esc must not reach it.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('[role=menu]')) log.push('page:escape') })

function Preview() {
  const start = params.get('open')
  const [open, setOpen] = useState<Which | null>(start === 'danger' || start === 'ordinary' ? start : null)
  const [stacked, setStacked] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(start === 'menu' ? { x: 260, y: 120 } : null)
  const [, setTick] = useState(0)
  const answer = (what: string) => { log.push(what); setTick(t => t + 1) }

  // Opens a dialog while the member is typing (a reply arriving, a sync finishing).
  ;(window as unknown as { __acbOpenLater: (w: Which) => void }).__acbOpenLater = w => setOpen(w)

  return (
    <main className="min-h-screen bg-white dark:bg-zinc-900 text-gray-900 dark:text-zinc-100 p-6 space-y-4">
      <p className="text-small text-text-muted">表示確認用の画面。本番のデータには接続しません。</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="h-control px-control-x rounded-control border border-border-control" onClick={() => setOpen('danger')}>フォルダを削除…</button>
        <button type="button" className="h-control px-control-x rounded-control border border-border-control" onClick={() => setOpen('ordinary')}>公開…</button>
        <button type="button" className="h-control px-control-x rounded-control border border-border-control" onClick={() => { setOpen('ordinary'); setStacked(true) }}>重ねて開く</button>
        <button type="button" className="h-control px-control-x rounded-control border border-border-control" onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }} onClick={e => setMenu({ x: e.clientX, y: e.clientY + 16 })}>右クリックのメニュー</button>
        <MoreMenu items={[
          { label: '名前を変える', onClick: () => answer('more:rename') },
          { label: '削除する', hint: '元に戻せません', danger: true, icon: <Trash size={13} />, onClick: () => answer('more:delete') },
        ]} />
        <Button variant="danger" onClick={() => answer('button:danger')}>参加者から外す</Button>
      </div>
      <label className="block text-small text-text-muted">
        相談の入力欄
        <textarea aria-label="相談の入力欄" className="mt-1 block w-full max-w-md rounded-control border border-border-control bg-surface-raised p-2" rows={2} />
      </label>
      <output id="log" aria-label="答え">{log.join(',')}</output>

      {menu && (
        <ContextMenu
          position={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: '名前を変える', onClick: () => answer('menu:rename') },
            { label: '', onClick: () => {}, divider: true },
            { label: '削除', danger: true, icon: <Trash size={16} />, onClick: () => answer('menu:delete') },
          ]}
        />
      )}

      <ConfirmDialog
        isOpen={open === 'danger'}
        title="「営業部の資料」を削除しますか？"
        message={'中のファイル 12 個も消えます。元に戻せません。'}
        confirmText="削除する"
        cancelText="やめる"
        danger
        onConfirm={() => { answer('danger:confirm'); setOpen(null) }}
        onCancel={() => { answer('danger:cancel'); setOpen(null) }}
      />
      <ConfirmDialog
        isOpen={open === 'ordinary'}
        title="この版を公開しますか？"
        message="会社の全員の Skill 一覧に出ます。あとで止められます。"
        confirmText="公開する"
        cancelText="やめる"
        onConfirm={() => { answer('ordinary:confirm'); setOpen(null) }}
        onCancel={() => { answer('ordinary:cancel'); setOpen(null) }}
      />
      <ConfirmDialog
        isOpen={open === 'typing'}
        title="つなぎますか？"
        message="この相談を案件につなぎます。"
        confirmText="つなぐ"
        cancelText="やめる"
        confirmOnEnter={false}
        onConfirm={() => { answer('typing:confirm'); setOpen(null) }}
        onCancel={() => { answer('typing:cancel'); setOpen(null) }}
      />
      <ConfirmDialog
        isOpen={open === 'ordinary' && stacked}
        title="ほかの画面に変更が残っています"
        message="保存していない変更があります。破棄しますか？"
        confirmText="破棄する"
        cancelText="戻る"
        danger
        onConfirm={() => { answer('stacked:confirm'); setStacked(false) }}
        onCancel={() => { answer('stacked:cancel'); setStacked(false) }}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

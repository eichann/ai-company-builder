/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { WatchCharacter } from '../src/features/watch/components/WatchCharacter'
import { WATCH_NAME } from '../shared/thing-words'
import { WATCH_PART_ORDER, WATCH_SIZES, watchPartNames, watchPartsFor, type WatchState } from '../shared/watch-character'

// Preview page for the watch character (.claude/rules/watch.md): 100 characters (member ids 1–100,
// the image board's seeds), one chosen in large with its six states and 「ほかの子にする」, the
// states beside their words, and the five sizes. `?theme=dark` for dark mode. Not on any screen yet.

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const STATES: ReadonlyArray<{ state: WatchState; name: string; words: string }> = [
  { state: 'idle', name: '何もない', words: 'いまは気になることはありません・14:30 に確かめました' },
  { state: 'noticed', name: '気づきあり', words: '気になることが 2 件あります' },
  { state: 'thinking', name: '考えている', words: '受け箱とやることを見直しています' },
  { state: 'working', name: '動いている', words: '下書きを作っています（右の相談）' },
  { state: 'done', name: '済んだ', words: '佐藤さんへの催促を送りました' },
  { state: 'stale', name: '確かめられていない', words: '14:05 から確かめられていません' },
]
const PART_LABELS = { hue: '色', body: '体', head: '頭', eyes: '目', pattern: '模様', item: '小物' } as const
const IDS = Array.from({ length: 100 }, (_, i) => String(i + 1))

function Preview() {
  const [chosen, setChosen] = useState('1')
  const [rerolls, setRerolls] = useState(0)
  const [state, setState] = useState<WatchState>('idle')
  const parts = watchPartsFor({ memberId: chosen, rerolls })
  const names = parts ? watchPartNames(parts) : null

  return (
    <main className="h-full overflow-auto bg-bg text-text p-6 space-y-8">
      <p className="text-small text-text-muted">表示確認用の画面。本番のデータには接続しません。{WATCH_NAME}のキャラクター（まだどの画面にも置いていません）。</p>

      <section aria-label="選んだ子" className="flex flex-wrap gap-6 items-start">
        <div data-testid="chosen">
          <WatchCharacter memberId={chosen} rerolls={rerolls} size={128} state={state} />
        </div>
        <div className="space-y-2">
          <h2 className="text-title">メンバー {chosen}{rerolls ? `（選び直し ${rerolls} 回目）` : ''}</h2>
          <p className="text-body" aria-live="polite">{STATES.find(s => s.state === state)?.words}</p>
          <div role="group" aria-label="状態" className="flex flex-wrap gap-1">
            {STATES.map(s => (
              <button key={s.state} type="button" aria-pressed={state === s.state} onClick={() => setState(s.state)}
                className="h-control-sm px-control-sm-x rounded-control border border-border-control text-small aria-pressed:bg-selected-bg aria-pressed:text-selected-text">
                {s.name}
              </button>
            ))}
          </div>
          {names && (
            <dl className="grid grid-cols-2 gap-x-3 text-small">
              {WATCH_PART_ORDER.map(k => [<dt key={`${k}t`} className="text-text-subtle">{PART_LABELS[k]}</dt>, <dd key={`${k}d`}>{names[k]}</dd>])}
            </dl>
          )}
          <div className="flex gap-2">
            <button type="button" className="h-control px-control-x rounded-control border border-border-control" onClick={() => setRerolls(r => r + 1)}>ほかの子にする</button>
            <button type="button" className="h-control px-control-x rounded-control border border-border-control" onClick={() => setRerolls(0)}>元の子に戻す</button>
          </div>
        </div>
      </section>

      <section aria-label="100体" className="flex flex-wrap gap-1">
        {IDS.map(id => (
          <button key={id} type="button" data-testid="kid" aria-pressed={id === chosen} aria-label={`メンバー ${id} の子`}
            onClick={() => { setChosen(id); setRerolls(0) }}
            className="grid justify-items-center p-1 rounded-control border border-border aria-pressed:border-primary aria-pressed:bg-selected-bg">
            <WatchCharacter memberId={id} size={64} state="idle" />
            <span className="text-caption text-text-subtle">{id}</span>
          </button>
        ))}
      </section>

      <section aria-label="状態" className="grid gap-3">
        {STATES.map(s => (
          <div key={s.state} data-testid={`state-${s.state}`} className="flex items-center gap-3">
            <WatchCharacter memberId="29" size={64} state={s.state} />
            <div className="flex items-center gap-2 rounded-control bg-surface-sunken px-control-x py-1">
              <WatchCharacter memberId="29" size={24} state={s.state} />
              <span className="text-small">{s.name}：{s.words}</span>
            </div>
          </div>
        ))}
      </section>

      <section aria-label="大きさ" className="grid gap-3">
        {['29', '7', '88', '23'].map(id => (
          <div key={id} className="flex items-end gap-5">
            {WATCH_SIZES.map(size => (
              <div key={size} data-testid={`size-${size}`} className="grid justify-items-center gap-1">
                <WatchCharacter memberId={id} size={size} state="idle" />
                <span className="text-caption text-text-subtle">{size}</span>
              </div>
            ))}
          </div>
        ))}
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

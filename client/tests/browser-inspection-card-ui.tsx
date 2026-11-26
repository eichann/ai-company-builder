/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for 「ブラウザ操作」's inspection card (client/src/features/browser-plans/components/BrowserInspectionCard.tsx):
// a reply holding a `data-browser-inspection` reference; the card reads main's in-memory card through the fake preload API.
// `?state=all_ok` (default) | `ng` (a ✗ with its fields) | `not_read` (a row 「読み取れませんでした」, a check unreadable) |
// `gone` (main has no card: the app was restarted) | `other-window` (a consultation's own window); `?theme=dark`.
// `?manual=1`: the user manual's story — a made-up 配信ツール and 検証A社's seminar routes (no real site or service is
// named; shoot it later from client/tests/manual/scenes.ts). Fictional data only.
// `?frame=1`: a write run's card (`bf_…`, step ⑤b): the plan with the key values read and ［任せる］／［やめる］; after
// ［任せる］ main's card moves on by itself (running, then the after-read card), read again by the card's polling.
import { createRoot } from 'react-dom/client'
import type { UIMessage } from 'ai'
import '../src/i18n'
import '../src/index.css'
import { AssistantMessageParts } from '../src/features/chat/components/MessageParts'
import { BROWSER_INSPECTION_CARD_WORDS, BROWSER_INSPECTION_PART_TYPE, type BrowserInspectionRef, type BrowserInspectionView } from '../shared/browser-inspection'
import type { BrowserWriteView } from '../shared/browser-line-writes'
import type { BrowserCard, BrowserCardValue } from '../../shared/core/browser-card'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const FRAME = params.get('frame') === '1'
const PLAN = FRAME ? `bf_${'4c'.repeat(16)}` : `bl_${'4c'.repeat(16)}`
const state = params.get('state') ?? 'all_ok'
const MANUAL = params.get('manual') === '1'
const read = (text: string): BrowserCardValue => ({ status: 'read', text })
const unreadable: BrowserCardValue = { status: 'unreadable' }

const NAME = MANUAL ? '12月 説明会の申し込み（12/3回）' : '見本セミナー 第2回の申し込み'
const SOURCE = MANUAL ? '11月 説明会の申し込み（11/26回）' : '見本セミナー 第1回の申し込み'
const rowUnread = state === 'not_read'

const card: BrowserCard = {
  title: '流入経路を点検する',
  state: state === 'ng' ? 'ng' : state === 'not_read' ? 'not_read' : 'all_ok',
  headline: state === 'ng' ? '確かめで違いが見つかりました（✗ の行を見てください）。'
    : state === 'not_read' ? '読み取れなかったものがあります。読み取れなかった行は、サイトで確かめてください。' : '点検した項目は、すべて確かめられました。',
  account: { label: 'LINE アカウント', value: read(MANUAL ? '検証A社 公式' : '9001001') },
  sections: [
    { heading: '点検する流入経路', rows: [{ label: '名前', value: read(NAME) }, { label: '受付の終わりの日', value: read('2026-12-03') }, { label: '受付の終わりの時刻', value: read('17:00') }] },
    { heading: '点検する流入経路（一覧の行）', rows: [
      { label: '友だち追加の URL', value: rowUnread ? unreadable : read('https://example.invalid/follow/preview-2') },
      { label: 'QR コードの URL', value: rowUnread ? unreadable : read('https://example.invalid/qr/preview-2') },
    ] },
    { heading: '点検する流入経路のアクション', rows: [{ label: 'つけるタグ', value: read('3002') }, { label: '送るテンプレート', value: read('4001') }, { label: '止めるリマインダ（番号_止め方）', value: read('なし') }] },
    { heading: '複製元の流入経路', rows: [{ label: '名前', value: read(SOURCE) }, { label: '受付の終わりの日', value: read('2026-11-26') }, { label: '受付の終わりの時刻', value: read('17:00') }] },
    { heading: '複製元のアクション', rows: [{ label: 'つけるタグ', value: read(state === 'ng' ? '3002' : '3001') }] },
  ],
  checks: [
    { label: 'すべて同じアカウントで読みました', mark: 'ok', fields: [] },
    { label: '「点検する流入経路」は「複製元の流入経路」と、名前・受付の終わりの日・受付の終わりの時刻・アクションのほかは同じ', mark: 'ok', fields: [] },
    { label: '「点検する流入経路」のアクションは、「複製元の流入経路」と違う', mark: 'ok', fields: [] },
    { label: '「点検する流入経路のアクション」のつけるタグは、「複製元のアクション」と違う', mark: state === 'ng' ? 'ng' : 'ok', fields: state === 'ng' ? ['つけるタグ'] : [] },
    { label: '「点検する流入経路のアクション」は「複製元のアクション」と、アクションの名前・つけるタグのほかは同じ', mark: state === 'not_read' ? 'unreadable' : 'ok', fields: [] },
  ],
  notes: ['アクションは、ほかの流入経路と共有されていることがあります。同じアクションを指す流入経路は、どれも同じ動きをします。'],
}
const view: BrowserInspectionView = { card, readAt: new Date().toISOString(), siteLabel: MANUAL ? '配信ツール' : 'Lステップ' }

// A write run's card: ready (the plan) → after ［任せる］ running → on the next read finished with the after-read card.
const HASH = `sha256:${'a'.repeat(64)}`
let frameStep: 'ready' | 'running' | 'finished' | 'cancelled' = 'ready'
const afterCard: BrowserCard = {
  title: 'AI がサイトで書いたこと', state: 'ng', headline: '済みました。読み直した結果を確かめてください。',
  sections: [
    { heading: '書いたこと', rows: [{ label: '1. POST /coupons', value: read('サイトが成功を返しました（機械で確かめた）') }] },
    { heading: '読み直し：/coupons/{created}', rows: [
      { label: 'title', before: read('なし（この作業で作ったもの）'), after: read('冬のクーポン'), compared: read('冬のクーポン'), by: 'machine', mark: 'ok' },
      { label: 'id', before: read('なし（この作業で作ったもの）'), after: read('4242'), by: 'none' },
    ] },
    { heading: 'ブラウザ操作の係の AI が確かめたこと（係の AI の判断です。機械で確かめた値ではありません）', rows: [
      { label: '名前', before: read('秋のクーポン'), after: read('冬のクーポン'), compared: read('秋のクーポン'), by: 'ai', mark: 'ng' },
    ] },
  ],
  checks: [{ label: '「前の回」と違う項目があります。意図した変更か確かめてください。', mark: 'ng', fields: ['名前'] }],
  notes: [],
}
const frameView = (): BrowserWriteView => ({
  title: 'ブラウザ操作：AI が書く作業', siteLabel: 'shop.example.test',
  phase: frameStep === 'ready' ? 'ready' : frameStep === 'running' ? 'running' : frameStep === 'cancelled' ? 'failed' : 'finished',
  values: [{ name: 'v1', label: '複製元', value: '秋のクーポン（番号 3001）', needsConfirm: false, confirmed: false }],
  sentences: ['秋のクーポンを複製して、冬のクーポンを作ります', '書く先：/coupons に作成：1回まで'],
  card: frameStep === 'finished' ? afterCard : null, readAt: frameStep === 'finished' ? new Date().toISOString() : null,
  contentHash: frameStep === 'ready' ? HASH : null, message: null, result: null, ...(frameStep === 'ready' ? { cancellable: true } : {}),
})

installElectronAPI({
  getBrowserWriteCard: async () => {
    const v = frameView()
    if (frameStep === 'running') frameStep = 'finished'
    return { ok: true, view: v }
  },
  runBrowserWrite: async (_c, _id, hash) => { if (hash === HASH) frameStep = 'running'; return { ok: true, view: frameView() } },
  cancelBrowserWrite: async () => { frameStep = 'cancelled'; return { ok: true, view: frameView() } },
  getBrowserInspection: async () => (state === 'gone' ? { ok: false, message: BROWSER_INSPECTION_CARD_WORDS.gone }
    : state === 'other-window' ? { ok: false, message: BROWSER_INSPECTION_CARD_WORDS.notMainWindow } : { ok: true, view }),
})

function Preview() {
  const ref: BrowserInspectionRef = { id: PLAN, companyId: 'co-preview', conversationId: 'conv-1', planId: PLAN, at: new Date().toISOString() }
  const parts = [{ type: 'text', text: '流入経路を点検しました。結果はカードを見てください。' }, { type: BROWSER_INSPECTION_PART_TYPE, id: `browser-inspection-${PLAN}`, data: ref }] as UIMessage['parts']
  return (
    <main className="min-h-screen bg-bg p-8 text-text">
      <p className="mb-4 text-small text-text-muted">表示確認用の人工データ。本番の相談やサイトには接続しません。</p>
      <section className="mx-auto max-w-xl"><AssistantMessageParts parts={parts} isStreaming={false} markdown /></section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

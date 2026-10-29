/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview of the document review in the editor (src/features/doc-review:
// banner, side panel, comment popover, replies, resolve) on a Markdown file shown as a
// preview, with the preload API mocked by an in-memory folder. 提案書.md
// already has a completed review by 佐藤; the member is 山田 (demo@example.com).
// Open /tests/doc-review-ui.html?theme=light|dark (&request=1: a review request exists;
// &history=1: more completed reviews, one all resolved, one whose text is gone;
// &second=1: a second document tab; &slow=1: a slow folder listing).
// window.__acbFailWrites(n) makes the next n writes fail.
// window.__acbFiles is the "disk" (path → content), for the spec to read the
// sidecar files the review writes.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { TabbedEditorPanel } from '../src/components/skill-ui/TabbedEditorPanel'
import { useAppStore } from '../src/stores/appStore'
import { useAuthStore } from '../src/stores/authStore'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const ROOT = '/Users/demo/会社'
const DIR = `${ROOT}/営業部`
const DOC = `${DIR}/提案書.md`
const DOC_TEXT = '# 提案書\n\n来期のご提案です。売上目標は前年比120%とします。\n\n担当は営業部です。'
const SATO_REVIEW = 'a1b2c3d4-0000-4000-8000-000000000001'

const files: Record<string, string> = {
  [DOC]: DOC_TEXT,
  [`${DOC}.review.${SATO_REVIEW}.json`]: JSON.stringify({
    version: 1,
    review: {
      id: SATO_REVIEW,
      reviewerName: '佐藤',
      reviewerEmail: 'sato@example.com',
      status: 'completed',
      createdAt: '2026-10-20T01:00:00.000Z',
      completedAt: '2026-10-20T02:00:00.000Z',
      snapshot: '# 提案書\n\n来期のご提案です。売上目標は前年比110%とします。\n\n担当は営業部です。',
      comments: [{
        id: 'c-sato-1',
        authorName: '佐藤',
        severity: 'must_fix',
        selectedText: '売上目標は前年比120%',
        startOffset: 18,
        endOffset: 31,
        body: '根拠となる数字を添えてください',
        createdAt: '2026-10-20T01:30:00.000Z',
        resolved: false,
        replies: [],
      }],
    },
  }, null, 2),
}

// ?history=1: two more completed reviews — 鈴木's, all resolved, and 田中's, whose
// text is no longer in the document (「位置不明」). Opening must not change either file.
function completedReview(id: string, name: string, email: string, text: string, resolved: boolean) {
  return JSON.stringify({
    version: 1,
    review: {
      id, reviewerName: name, reviewerEmail: email, status: 'completed',
      createdAt: '2026-10-18T01:00:00.000Z', completedAt: '2026-10-18T02:00:00.000Z',
      comments: [{
        id: `c-${id}`, authorName: name, severity: 'should_fix', selectedText: text,
        startOffset: 0, endOffset: text.length, body: `${name}の指摘`, createdAt: '2026-10-18T01:30:00.000Z',
        resolved, replies: [],
      }],
      snapshot: DOC_TEXT,
    },
  }, null, 2)
}
if (params.get('history') === '1') {
  files[`${DOC}.review.b2000000-0000-4000-8000-000000000002.json`] = completedReview('b2000000-0000-4000-8000-000000000002', '鈴木', 'suzuki@example.com', '担当は営業部です', true)
  files[`${DOC}.review.c3000000-0000-4000-8000-000000000003.json`] = completedReview('c3000000-0000-4000-8000-000000000003', '田中', 'tanaka@example.com', '旧い見出しの文言', false)
}

// ?request=1: someone asked for a review of 提案書.md (the button is hidden; the file can still exist).
if (params.get('request') === '1') files[`${DOC}.review-request.json`] = JSON.stringify({ requestedBy: '佐藤', requestedAt: '2026-10-21T00:00:00.000Z' }, null, 2)

// ?second=1: a second document in another folder, 総務/議事録.md, with 高橋's completed review.
const DOC2 = `${ROOT}/総務/議事録.md`
if (params.get('second') === '1') {
  files[DOC2] = '# 議事録\n\n次回は11月です。'
  files[`${DOC2}.review.d4000000-0000-4000-8000-000000000004.json`] = completedReview('d4000000-0000-4000-8000-000000000004', '高橋', 'takahashi@example.com', '次回は11月です', false)
}
// ?slow=1: listing 営業部 takes 800 ms (a slow disk), for switching documents mid-load.
const slowDir = params.get('slow') === '1' ? DIR : null
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// window.__acbFailWrites(n): the next n file writes fail (a busy or refused file).
let failWrites = 0
installElectronAPI({
  readFile: async p => (p in files ? files[p] : null),
  exists: async p => p in files,
  writeFile: async (p, content) => {
    if (failWrites > 0) { failWrites--; return false }
    files[p] = content
    return true
  },
  renameItem: async (from, to) => {
    if (!(from in files)) return { success: false, error: 'ENOENT' }
    files[to] = files[from]
    delete files[from]
    return { success: true, newPath: to }
  },
  deleteItem: async p => {
    if (!(p in files)) return { success: false, error: 'ENOENT' }
    delete files[p]
    return { success: true }
  },
  readDirectory: async dir => {
    if (dir === slowDir) await sleep(800)
    return Object.keys(files)
      .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(p => ({ name: p.slice(dir.length + 1), path: p, isDirectory: false }))
  },
})
Object.assign(window, { __acbFailWrites: (n: number) => { failWrites = n } })
Object.assign(window, { __acbFiles: files })

localStorage.setItem('mdViewMode', 'preview')
useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })
useAuthStore.setState({ user: { id: 'u-yamada', email: 'demo@example.com', name: '山田', image: null, emailVerified: true } })

function Preview() {
  const [active, setActive] = useState(DOC)
  const open = params.get('second') === '1' ? [DOC, DOC2] : [DOC]
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <div className="h-[560px] w-[1000px]">
        <TabbedEditorPanel openFiles={open} activeFilePath={active} onSelectFile={setActive} onCloseFile={() => {}} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)

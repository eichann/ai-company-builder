/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview of the document review in the editor (src/features/doc-review:
// banner, side panel, comment popover, replies, resolve) on a Markdown file shown as a
// preview, with the preload API mocked by an in-memory folder. 提案書.md
// already has a completed review by 佐藤; the member is 山田 (demo@example.com).
// Open /tests/doc-review-ui.html?theme=light|dark
// window.__acbFiles is the "disk" (path → content), for the spec to read the
// sidecar files the review writes.
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

installElectronAPI({
  readFile: async p => (p in files ? files[p] : null),
  writeFile: async (p, content) => { files[p] = content; return true },
  deleteItem: async p => { delete files[p]; return { success: true } },
  readDirectory: async dir => Object.keys(files)
    .filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    .map(p => ({ name: p.slice(dir.length + 1), path: p, isDirectory: false })),
})
Object.assign(window, { __acbFiles: files })

localStorage.setItem('mdViewMode', 'preview')
useAppStore.setState({ currentCompany: { id: 'demo', name: '株式会社デモ', rootPath: ROOT, departments: [], createdAt: new Date() } })
useAuthStore.setState({ user: { id: 'u-yamada', email: 'demo@example.com', name: '山田', image: null, emailVerified: true } })

function Preview() {
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <div className="h-[560px] w-[1000px]">
        <TabbedEditorPanel openFiles={[DOC]} activeFilePath={DOC} onSelectFile={() => {}} onCloseFile={() => {}} />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)

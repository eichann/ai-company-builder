// The user manual's screenshots, declared as data (manual/README.md). Each scene
// opens one preview page (client/tests/<page>-ui.html: the real components with
// the preload API faked and fictional data), does a few steps, draws its
// annotations on top and saves manual/images/<id>.png. `pnpm manual:shoot`
// shoots them all again (shoot.spec.ts).
//
// Targets are Playwright selectors, preferably by role and visible name
// (`role=button[name="サーバーと同期"]`): they follow what the member sees, so a
// restyle keeps them working, and a renamed or removed control fails the shot
// instead of leaving a stale picture. A target must match exactly one visible
// element.
//
// Data shown in a picture must be fictional (検証A社, 山田さん, 株式会社デモ): no real
// people, companies or private-folder names.

export interface SceneAnnotation {
  /** A red frame around the target. */
  box?: string
  /** A numbered red marker beside the target; the manual's text refers to the number. */
  marker?: { target: string; label: string; at?: 'top-left' | 'left' | 'right' | 'below' }
}

export type SceneStep =
  | { click: string }
  | { waitFor: string }

export interface Scene {
  /** File name in manual/images (ASCII, kebab-case). */
  id: string
  /** What the picture shows (for the reader of this file). */
  about: string
  /** Preview page name: client/tests/<page>-ui.html. */
  page: string
  query?: Record<string, string>
  /** CSS pixels; the shot is taken at 2x for sharp text. Default 1280x800. */
  viewport?: { width: number; height: number }
  steps?: SceneStep[]
  /** Crop the shot to an element (plus padding in CSS pixels, default 16; `{ x, y }` for different sides) or to a region (CSS pixels) instead of the whole viewport. */
  crop?: { target: string; padding?: number | { x: number; y: number } } | { region: { x: number; y: number; width: number; height: number } }
  annotations?: SceneAnnotation[]
}

const MAIN = { page: 'skill-layout', query: { companies: '2' } } as const

export const scenes: Scene[] = [
  {
    id: 'main-window',
    about: 'The main window: department tabs, the file list, an open file and the title bar.',
    ...MAIN,
    steps: [
      { click: 'role=button[name="営業部" s]' },
      { click: 'role=button[name="ファイル" s]' },
      // The chat panel needs a chat server this page does not have (chat-panel has its own scene).
      { click: 'role=button[name=/^AIチャット/]' },
      { click: 'role=button[name=/^A社_提案\\.md/]' },
      { waitFor: 'text=A社への提案の骨子。' },
    ],
    annotations: [
      { marker: { target: 'role=button[name="営業部" s]', label: '1' } },
      { marker: { target: 'role=button[name="ファイル" s]', label: '2' } },
      { marker: { target: 'role=tablist[name="開いているもの"]', label: '3' } },
      { marker: { target: 'role=button[name="サーバーと同期" s]', label: '4', at: 'below' } },
    ],
  },
  {
    id: 'sync-button',
    about: 'The sync button in the title bar.',
    ...MAIN,
    crop: { target: 'header', padding: 0 },
    annotations: [{ box: 'role=button[name="サーバーと同期" s]' }],
  },
  {
    id: 'company-switcher',
    about: 'Switching to another company from the company name in the title bar.',
    ...MAIN,
    crop: { region: { x: 0, y: 0, width: 720, height: 200 } },
    steps: [{ click: 'role=button[name="株式会社デモ"]' }, { waitFor: 'role=menuitem[name="別会社"]' }],
    annotations: [{ box: 'role=menuitem[name="別会社"]' }],
  },
  {
    id: 'approval-card',
    about: 'An approval request (承認のお願い) as it appears in the chat.',
    page: 'approval-card',
    crop: { target: 'section', padding: { x: 32, y: 16 } },
    annotations: [
      { box: 'text=1,500,000' },
      { marker: { target: 'role=textbox', label: '1', at: 'left' } },
      { marker: { target: 'role=button[name="承認" s]', label: '2', at: 'left' } },
    ],
  },
]

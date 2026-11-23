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
// Data shown in a picture must be fictional (検証A社, 山田さん, 佐藤さん): no real
// people, companies or private-folder names.

export interface SceneAnnotation {
  /** A red frame around the target. */
  box?: string
  /** A numbered red marker beside the target; the manual's text refers to the number. */
  marker?: { target: string; label: string; at?: 'top-left' | 'left' | 'right' | 'below' }
  /**
   * A short red-framed label below the target (a button's name, as its tooltip says it): drawn by
   * the manual, not by the app, for controls that show only an icon.
   */
  note?: { target: string; text: string; /** 2 = one row lower, so neighbours' labels do not overlap. */ row?: 1 | 2 }
}

export type SceneStep =
  | { click: string }
  /** A right click (a context menu). */
  | { rightClick: string }
  /** Types `text` into the target field, replacing what it held. */
  | { fill: string; text: string }
  /** Clicks the target, moves to its end (⌘↓) and types `text` (an editor). */
  | { typeAtEnd: string; text: string }
  /** Presses a key (Playwright key name, e.g. `Escape`). */
  | { press: string }
  /** Runs a preview page's own hook (e.g. `window.__acbCompany.progress(…)`). */
  | { run: string }
  | { waitFor: string }

export interface Scene {
  /** File name in manual/images (ASCII, kebab-case). */
  id: string
  /** What the picture shows (for the reader of this file). */
  about: string
  /** Preview page name: client/tests/<page>-ui.html. Absent for a diagram. */
  page?: string
  /**
   * A diagram instead of a screen: client/tests/manual/diagrams/<id>.html (static HTML on the
   * design tokens, which the shoot puts in front of it), cut to its `#diagram` element. The
   * manual's site serves pictures only as PNG/JPEG/WebP (no SVG: shared/core/manual.ts), so a
   * diagram is drawn in HTML and shot like a screen.
   */
  diagram?: true
  query?: Record<string, string>
  /** CSS pixels; the shot is taken at 2x for sharp text. Default 1280x800. */
  viewport?: { width: number; height: number }
  steps?: SceneStep[]
  /** Crop the shot to an element (plus padding in CSS pixels, default 16; `{ x, y }` for different sides) or to a region (CSS pixels) instead of the whole viewport. */
  crop?: { target: string; padding?: number | { x: number; y: number } } | { region: { x: number; y: number; width: number; height: number } }
  annotations?: SceneAnnotation[]
}

// The main screen with the manual's company (skill-layout-ui.html ?manual=1: 検証A社, 山田 太郎 in
// 営業部, 総務部 not downloaded, one consultation in 「AIへの相談」).
const MAIN = { page: 'skill-layout', query: { companies: '2', manual: '1' } } as const
// The screens before a company opens, at a size that frames their centred card.
const SELECTOR = { page: 'company-selector', query: { manual: '1' }, viewport: { width: 760, height: 680 } } as const
const SIGN_IN = { page: 'sign-in', viewport: { width: 760, height: 620 } } as const

// 「AIへの相談」 opens with its list over a narrow chat (as in the app): closed for a picture of the screen.
const CLOSE_LIST: SceneStep = { click: 'role=complementary[name="AIへの相談"] >> role=button[name="AIへの相談の一覧を閉じる"]' }
const SALES_TAB = 'role=button[name="営業部" s]'
const FILES_TAB = 'role=button[name="ファイル" s]'
const SKILLS_TAB = 'role=button[name="スキル" s]'
const SYNC = 'role=button[name="サーバーと同期" s]'
const TITLE_BAR = 'header:has(button[aria-label="サーバーと同期"])'
const SALES_FILES: SceneStep[] = [CLOSE_LIST, { click: SALES_TAB }, { click: FILES_TAB }]
const VISIT_MEMO = 'role=button[name=/^訪問メモ_1123\\.md/]'
const PROPOSAL = 'role=button[name=/^提案書_A社向け\\.md/]'
const EDITOR = '.cm-content[data-language="markdown"]'
// The editor continues the list itself after Enter (「- 」).
const ADDED_LINE = '\n次回：12/1 に見積を持って再訪問'
// The main screen's three panes, found from the bars between them.
const LEFT_PANE = 'xpath=//*[@aria-label="ファイルツリーとエディタの境目"]/preceding-sibling::*[1]'
const EDITOR_PANE = 'xpath=//*[@aria-label="ファイルツリーとエディタの境目"]/following-sibling::*[1]'
const CHAT_PANE = 'xpath=//*[@aria-label="左の欄とチャットの境目"]/following-sibling::*[1]'

export const scenes: Scene[] = [
  // ── The sample page (manual/pages/sample.md) ──────────────────────────────
  {
    id: 'main-window',
    about: 'The main window: department tabs, the file list, an open file and the title bar.',
    ...MAIN,
    steps: [
      { click: SALES_TAB },
      { click: FILES_TAB },
      // The chat panel has its own pictures (chapter 4).
      { click: 'role=button[name=/^AIチャット/]' },
      { click: PROPOSAL },
      { waitFor: 'text=受発注の手作業を減らし' },
    ],
    annotations: [
      { marker: { target: SALES_TAB, label: '1' } },
      { marker: { target: FILES_TAB, label: '2' } },
      { marker: { target: 'role=tablist[name="開いているもの"]', label: '3' } },
      { box: SYNC },
      { marker: { target: SYNC, label: '4', at: 'below' } },
    ],
  },
  {
    id: 'sync-button',
    about: 'The sync button in the title bar.',
    ...MAIN,
    crop: { target: TITLE_BAR, padding: 0 },
    annotations: [{ box: SYNC }],
  },
  {
    id: 'company-switcher',
    about: 'Switching to another company from the company name in the title bar.',
    ...MAIN,
    crop: { region: { x: 0, y: 0, width: 720, height: 200 } },
    steps: [{ click: 'role=button[name="検証A社"]' }, { waitFor: 'role=menuitem[name="検証B社"]' }],
    annotations: [{ box: 'role=menuitem[name="検証B社"]' }],
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

  // ── 1章 ACB ってなに？ ───────────────────────────────────────────────────
  {
    id: 'overview-whole-app',
    about: '検証A社 opened: the shared folder on the left, an open file in the middle, 「AIへの相談」 on the right.',
    ...MAIN,
    steps: [...SALES_FILES, { click: PROPOSAL }, { waitFor: 'text=受発注の手作業を減らし' }],
    annotations: [
      { box: LEFT_PANE }, { marker: { target: LEFT_PANE, label: '1' } },
      { box: EDITOR_PANE }, { marker: { target: EDITOR_PANE, label: '2' } },
      { box: CHAT_PANE }, { marker: { target: CHAT_PANE, label: '3' } },
    ],
  },
  {
    id: 'overview-diagram',
    about: 'Diagram: the company server and 山田さん’s and 佐藤さん’s PCs, each with its copy and its AI.',
    diagram: true,
  },

  // ── 2章 招待からログインして、会社を開く ─────────────────────────────────
  {
    id: 'login-server-setup',
    about: 'Opened from the invitation link: the server address to connect to and ［つなぐ］.',
    ...SIGN_IN,
    query: { screen: 'offer' },
    annotations: [
      { box: 'text=https://acb.example.com' }, { marker: { target: 'text=https://acb.example.com', label: '1', at: 'left' } },
      { box: 'role=button[name="つなぐ"]' }, { marker: { target: 'role=button[name="つなぐ"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'login-server-url',
    about: 'The app opened first: typing the server address and ［接続］.',
    ...SIGN_IN,
    query: { screen: 'server' },
    steps: [{ fill: 'role=textbox', text: 'https://acb.example.com' }],
    annotations: [
      { box: 'role=textbox' }, { marker: { target: 'role=textbox', label: '1', at: 'left' } },
      { box: 'role=button[name="接続"]' }, { marker: { target: 'role=button[name="接続"]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'login-screen',
    about: 'The sign-in screen with the address and password filled in.',
    ...SIGN_IN,
    query: { screen: 'login' },
    steps: [
      { fill: 'role=textbox[name="example@company.com"]', text: 'yamada@example.com' },
      { fill: 'role=textbox[name="••••••••"]', text: 'passw0rd!' },
    ],
    annotations: [
      { marker: { target: 'role=textbox[name="example@company.com"]', label: '1', at: 'left' } },
      { marker: { target: 'role=textbox[name="••••••••"]', label: '2', at: 'left' } },
      { box: 'role=button[name="ログイン"]' }, { marker: { target: 'role=button[name="ログイン"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'company-select',
    about: '「会社を選択」: the member’s companies, 検証A社 framed.',
    ...SELECTOR,
    annotations: [{ box: 'role=button[name=/^検証A社/]' }, { marker: { target: 'role=button[name=/^検証A社/]', label: '1', at: 'left' } }],
  },
  {
    id: 'company-folder-choice',
    about: '「作業フォルダを選択してください」: 新しく作成 for a first time, 既存のフォルダを開く otherwise.',
    ...SELECTOR,
    steps: [{ click: 'role=button[name=/^検証A社/]' }],
    annotations: [
      { box: 'role=button[name=/^新しく作成/]' }, { marker: { target: 'role=button[name=/^新しく作成/]', label: '1', at: 'left' } },
      { marker: { target: 'role=button[name=/^既存のフォルダを開く/]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'company-folder-new',
    about: 'Where the company folder is made: フォルダを選択 (already chosen) and 開始.',
    ...SELECTOR,
    steps: [
      { click: 'role=button[name=/^検証A社/]' },
      { click: 'role=button[name=/^新しく作成/]' },
      { click: 'role=button[name=/^フォルダを選択/]' },
      { waitFor: 'text="/Users/yamada/AI Company Builder/検証A社"' },
    ],
    annotations: [
      { marker: { target: 'role=button[name=/^フォルダを選択/]', label: '1', at: 'left' } },
      { box: 'role=button[name=/^開始/]' }, { marker: { target: 'role=button[name=/^開始/]', label: '2', at: 'right' } },
    ],
  },

  // ── 3章 自分の部署を選ぶ ─────────────────────────────────────────────────
  {
    id: 'setup-department-picker',
    about: '「所属する部署を選択」 with 営業部 checked and the download button.',
    ...SELECTOR,
    steps: [
      { click: 'role=button[name=/^検証A社/]' },
      { click: 'role=button[name=/^新しく作成/]' },
      { click: 'role=button[name=/^フォルダを選択/]' },
      { click: 'role=button[name=/^開始/]' },
      { click: 'role=button[name=/^営業部/]' },
    ],
    annotations: [
      { marker: { target: 'text=所属する部署を選んでください', label: '1', at: 'left' } },
      { box: 'role=button[name=/^営業部/]' }, { marker: { target: 'role=button[name=/^営業部/]', label: '2', at: 'left' } },
      { box: 'role=button[name=/^選んだ部署をダウンロード/]' }, { marker: { target: 'role=button[name=/^選んだ部署をダウンロード/]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'setup-department-none',
    about: 'Nothing checked: the button says すべての部署をダウンロード.',
    ...SELECTOR,
    steps: [
      { click: 'role=button[name=/^検証A社/]' },
      { click: 'role=button[name=/^新しく作成/]' },
      { click: 'role=button[name=/^フォルダを選択/]' },
      { click: 'role=button[name=/^開始/]' },
      { waitFor: 'text=所属する部署を選んでください' },
    ],
    annotations: [{ box: 'role=button[name=/^すべての部署をダウンロード/]' }, { marker: { target: 'role=button[name=/^すべての部署をダウンロード/]', label: '1', at: 'below' } }],
  },
  {
    id: 'setup-progress',
    about: 'The first setup downloading: 「ダウンロード中… 46 MB 受信」.',
    ...SELECTOR,
    query: { manual: '1', setup: 'manual' },
    steps: [
      { click: 'role=button[name=/^検証A社/]' },
      { click: 'role=button[name=/^新しく作成/]' },
      { click: 'role=button[name=/^フォルダを選択/]' },
      { click: 'role=button[name=/^開始/]' },
      { click: 'role=button[name=/^営業部/]' },
      { click: 'role=button[name=/^選んだ部署をダウンロード/]' },
      { run: 'window.__acbCompany.progress(48_500_000)' },
      { waitFor: 'text=/ダウンロード中…/' },
    ],
    annotations: [{ box: 'text=/ダウンロード中…/' }, { marker: { target: 'text=/ダウンロード中…/', label: '1', at: 'right' } }],
  },
  {
    id: 'department-not-downloaded',
    about: 'The 総務部 tab of a department not on this PC: ［ダウンロードして同期を開始］.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: 'role=button[name="総務部" s]' }, { waitFor: 'role=button[name="ダウンロードして同期を開始"]' }],
    crop: { region: { x: 0, y: 0, width: 860, height: 800 } },
    annotations: [
      { marker: { target: 'role=button[name="総務部" s]', label: '1' } },
      { box: 'role=button[name="ダウンロードして同期を開始"]' }, { marker: { target: 'role=button[name="ダウンロードして同期を開始"]', label: '2', at: 'left' } },
    ],
  },

  // ── 4章 画面の見方 ───────────────────────────────────────────────────────
  {
    id: 'shell-tour',
    about: 'The whole screen with the four places used on day one.',
    ...MAIN,
    steps: [...SALES_FILES, { click: VISIT_MEMO }, { waitFor: 'text=納期は3月末を希望' }],
    annotations: [
      { box: SYNC }, { marker: { target: SYNC, label: '1', at: 'below' } },
      { marker: { target: SALES_TAB, label: '2' } },
      { box: 'xpath=//button[normalize-space()="スキル"]/..' }, { marker: { target: 'xpath=//button[normalize-space()="スキル"]/..', label: '3' } },
      { box: CHAT_PANE }, { marker: { target: CHAT_PANE, label: '4' } },
    ],
  },
  {
    id: 'screen-map',
    about: 'Diagram: the screen as three areas (choose a file, read and write it, ask the AI).',
    diagram: true,
  },
  {
    id: 'title-bar-zoom',
    about: 'The title bar’s small buttons with their names (as their tooltips say).',
    ...MAIN,
    steps: [CLOSE_LIST],
    crop: { region: { x: 560, y: 0, width: 720, height: 110 } },
    annotations: [
      { note: { target: 'role=button[name="変更を確認"]', text: '① 変更を確認' } },
      { box: SYNC }, { note: { target: SYNC, text: '② サーバーと同期', row: 2 } },
      { note: { target: 'role=button[name="バックアップ履歴"]', text: '③ バックアップ履歴' } },
      { note: { target: 'role=banner >> role=button[name="設定"]', text: '④ 設定', row: 2 } },
    ],
  },
  {
    id: 'department-tabs',
    about: 'The department tabs: 全社, 営業部 (chosen) and 総務部 (not downloaded).',
    ...MAIN,
    steps: [CLOSE_LIST, { click: SALES_TAB }],
    crop: { region: { x: 0, y: 48, width: 480, height: 110 } },
    annotations: [
      { marker: { target: 'role=button[name="全社" s]', label: '1', at: 'below' } },
      { marker: { target: SALES_TAB, label: '2', at: 'below' } },
      { marker: { target: 'role=button[name="総務部" s]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'left-tab-files',
    about: 'The left pane’s ファイル tab: 営業部’s folders and files.',
    ...MAIN,
    steps: SALES_FILES,
    crop: { region: { x: 0, y: 100, width: 430, height: 350 } },
    annotations: [{ box: FILES_TAB }, { marker: { target: FILES_TAB, label: '1' } }],
  },
  {
    id: 'left-tab-skills',
    about: 'The left pane’s スキル tab: 営業部’s Skill.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: SKILLS_TAB }, { waitFor: 'text=提案書の骨子を作る' }],
    crop: { region: { x: 0, y: 100, width: 560, height: 400 } },
    annotations: [{ box: SKILLS_TAB }, { marker: { target: SKILLS_TAB, label: '1' } }],
  },
  {
    id: 'chat-area',
    about: '「AIへの相談」: the input and the list of consultations.',
    ...MAIN,
    steps: [CLOSE_LIST],
    crop: { target: CHAT_PANE, padding: 0 },
    annotations: [
      { box: '[aria-placeholder^="メッセージを入力"]' }, { marker: { target: '[aria-placeholder^="メッセージを入力"]', label: '1' } },
      { box: 'role=button[name="AIへの相談の一覧を開閉"]' }, { marker: { target: 'role=button[name="AIへの相談の一覧を開閉"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'reset-layout',
    about: '「いつもの形に戻す」 in the title bar.',
    ...MAIN,
    steps: [CLOSE_LIST],
    crop: { region: { x: 560, y: 0, width: 720, height: 70 } },
    annotations: [{ box: 'role=button[name="いつもの形に戻す"]' }, { marker: { target: 'role=button[name="いつもの形に戻す"]', label: '1', at: 'left' } }],
  },

  // ── 5章 ファイルを開いて直す ─────────────────────────────────────────────
  {
    id: 'file-list',
    about: 'The ファイル tab: a folder and the file 訪問メモ_1123.md to open.',
    ...MAIN,
    steps: SALES_FILES,
    crop: { region: { x: 0, y: 100, width: 430, height: 350 } },
    annotations: [
      { marker: { target: FILES_TAB, label: '1' } },
      { box: 'role=button[name=/^提案書$/]' }, { marker: { target: 'role=button[name=/^提案書$/]', label: '2', at: 'right' } },
      { box: VISIT_MEMO }, { marker: { target: VISIT_MEMO, label: '3', at: 'right' } },
    ],
  },
  {
    id: 'file-open-edit',
    about: '訪問メモ_1123.md open with one line added at the end (saved).',
    ...MAIN,
    steps: [...SALES_FILES, { click: VISIT_MEMO }, { waitFor: 'text=納期は3月末を希望' }, { typeAtEnd: EDITOR, text: ADDED_LINE }, { press: 'ControlOrMeta+s' }],
    annotations: [
      { box: VISIT_MEMO }, { marker: { target: VISIT_MEMO, label: '1', at: 'right' } },
      { box: '.cm-line:has-text("次回：12/1")' }, { marker: { target: '.cm-line:has-text("次回：12/1")', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'file-unsaved-dot',
    about: 'Just after typing: the dot on the tab (not saved yet).',
    ...MAIN,
    steps: [...SALES_FILES, { click: VISIT_MEMO }, { waitFor: 'text=納期は3月末を希望' }, { typeAtEnd: EDITOR, text: ADDED_LINE }],
    crop: { region: { x: 260, y: 121, width: 600, height: 200 } },
    annotations: [{ marker: { target: 'role=img[name="保存していない変更があります"]', label: '1', at: 'below' } }],
  },
  {
    id: 'saved-on-pc',
    about: 'Diagram: saved on the PC at once; to the company only with the sync button.',
    diagram: true,
  },
  {
    id: 'file-context-menu',
    about: 'Right-clicking the folder 下書き: 新規ファイル, 新しいフォルダ…, 名前を変更.',
    ...MAIN,
    steps: [...SALES_FILES, { rightClick: 'role=button[name=/^下書き$/]' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 350 } },
    annotations: [
      { box: 'role=button[name="新規ファイル"] >> nth=-1' }, { marker: { target: 'role=button[name="新規ファイル"] >> nth=-1', label: '1', at: 'right' } },
      { marker: { target: 'role=button[name="新しいフォルダ…"] >> nth=-1', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'file-new-dialog',
    about: '「新規ファイル」 with the name typed and ［作成］.',
    ...MAIN,
    steps: [...SALES_FILES, { rightClick: 'role=button[name=/^下書き$/]' }, { click: 'role=button[name="新規ファイル"] >> nth=-1' }, { fill: 'role=dialog >> role=textbox', text: '見積_下書き.md' }],
    crop: { target: 'role=dialog', padding: 40 },
    annotations: [
      { marker: { target: 'role=dialog >> role=textbox', label: '1' } },
      { box: 'role=dialog >> role=button[name="作成"]' }, { marker: { target: 'role=dialog >> role=button[name="作成"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'file-rename-menu',
    about: 'Right-clicking a file: 名前を変更.',
    ...MAIN,
    steps: [...SALES_FILES, { rightClick: 'role=button[name=/^訪問メモ_1120\\.md/]' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 420 } },
    annotations: [{ box: 'role=button[name=/^名前を変更/]' }, { marker: { target: 'role=button[name=/^名前を変更/]', label: '1', at: 'right' } }],
  },
  {
    id: 'file-rename',
    about: '「名前を変更」 with the new name typed and its ［名前を変更］ button.',
    ...MAIN,
    steps: [
      ...SALES_FILES,
      { rightClick: 'role=button[name=/^訪問メモ_1120\\.md/]' },
      { click: 'role=button[name=/^名前を変更/]' },
      { fill: 'role=dialog >> role=textbox', text: '訪問メモ_1120_B社.md' },
    ],
    crop: { target: 'role=dialog', padding: 40 },
    annotations: [
      { marker: { target: 'role=dialog >> role=textbox', label: '1' } },
      { box: 'role=dialog >> role=button[name="名前を変更"]' }, { marker: { target: 'role=dialog >> role=button[name="名前を変更"]', label: '2', at: 'right' } },
    ],
  },

  // ── 2章 (Google) ─────────────────────────────────────────────────────────
  {
    id: 'google-settings',
    about: '設定 →「Google」 before allowing: ［Google で許可］.',
    page: 'download-folders',
    query: { tab: 'google', google: 'ready', manual: '1' },
    steps: [{ waitFor: 'role=button[name="Google で許可"]' }],
    annotations: [
      { box: 'role=button[name="Google で許可"]' }, { marker: { target: 'role=button[name="Google で許可"]', label: '1', at: 'right' } },
    ],
  },
]

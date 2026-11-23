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
  /** Drags the target onto `to` (a file from the list onto the chat's input). */
  | { drag: string; to: string }
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
  /** Keep the focus where the steps left it (a list that closes when its input loses focus). */
  keepFocus?: true
}

// The main screen with the manual's company (skill-layout-ui.html ?manual=1: 検証A社, 山田 太郎 in
// 営業部, 総務部 not downloaded, one consultation in 「AIへの相談」).
const MAIN = { page: 'skill-layout', query: { companies: '2', manual: '1' } } as const
// The screens before a company opens, at a size that frames their centred card.
const SELECTOR = { page: 'company-selector', query: { manual: '1' }, viewport: { width: 760, height: 680 } } as const
// 15章: 総務部 downloaded (閲覧のみ), 営業部/過去資料 not downloaded, the private folder 営業部/提案前メモ.
const MARKS = { page: 'skill-layout', query: { companies: '2', manual: '1', folders: 'marks' } } as const
const SIGN_IN = { page: 'sign-in', viewport: { width: 760, height: 620 } } as const

// 「AIへの相談」 opens with its list over a narrow chat (as in the app): closed for a picture of the screen.
const CLOSE_LIST: SceneStep = { click: 'role=complementary[name="AIへの相談"] >> role=button[name="AIへの相談の一覧を閉じる"]' }
const SALES_TAB = 'role=button[name="営業部" s]'
const FILES_TAB = 'role=button[name="ファイル" s]'
const SKILLS_TAB = 'role=button[name="Skill" s]'
const SYNC = 'role=button[name="サーバーと同期" s]'
const SYNC_WAITS = 'role=button[name="サーバーと同期（自動同期は止まっています）"]'
const PREVIEW = 'role=button[name="変更を確認" s]'
/** One change's row in 「変更を確認」 (its file name, then 「変更を元に戻す」). */
const PREVIEW_ROW = (name: string) => `role=dialog >> div.cursor-pointer:has(span[title$="${name}"])`
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
// 6〜9章: 「AIへの相談」 answering what is sent with a fixed reply (skill-layout-ui.html ?chat=live),
// starting on a new consultation with three earlier ones in the list.
const LIVE = { page: 'skill-layout', query: { companies: '2', manual: '1', chat: 'live' } } as const
const COMPOSER = `${CHAT_PANE} >> .cm-content[role="textbox"]`
/** The input's frame (the text and the send button). */
const COMPOSER_BOX = `${COMPOSER} >> xpath=ancestor::div[.//button][1]`
const SEND = `${COMPOSER_BOX} >> button >> nth=-1`
/** Types a request into 「AIへの相談」 and sends it (⌘Enter). */
const ASK = (text: string): SceneStep[] => [{ typeAtEnd: COMPOSER, text }, { press: 'ControlOrMeta+Enter' }]
const FIRST_REQUEST = '営業部の訪問メモ_1123.md を読んで、A社の田村さんへのお礼メールの下書きを 営業部/下書き/ に作ってください。'
const THANKS_FILE = 'role=button[name=/^お礼メール_A社\\.md/]'
/** A Skill's card in the スキル tab, by its name. */
/** The chat pane, with room on its left for markers. */
const CHAT_CROP = { target: CHAT_PANE, padding: { x: 32, y: 0 } }
/** Lets a panel that slides in come to rest before its parts are measured. */
const SETTLE: SceneStep = { run: 'new Promise(resolve => setTimeout(resolve, 600))' }
/** Folds the editor's side panel (つながっているもの・前の版): the preview's history is not this file's. */
const FOLD_SIDE = 'role=button[name="つながっているもの・前の版をたたむ"]'
const SKILL_CARD = (name: string) => `xpath=//*[normalize-space()="${name}"]/ancestor::div[.//button[normalize-space()="実行"]][1]`

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
      { box: 'xpath=//button[normalize-space()="Skill"]/..' }, { marker: { target: 'xpath=//button[normalize-space()="Skill"]/..', label: '3' } },
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
    about: 'The left pane’s Skill tab: 営業部’s Skill.',
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

  // ── 11章 同期ボタン ──────────────────────────────────────────────────────
  {
    id: 'sync-what-happens',
    about: 'Diagram: one press sends the member’s changes and brings the others’ changes.',
    diagram: true,
  },
  {
    id: 'sync-running',
    about: 'Just after pressing 「サーバーと同期」: the button turns while sync runs.',
    ...MAIN,
    query: { ...MAIN.query, sync: 'manual' },
    steps: [CLOSE_LIST, { click: SYNC }],
    crop: { region: { x: 560, y: 0, width: 720, height: 110 } },
    annotations: [{ box: SYNC }, { note: { target: SYNC, text: '① 同期中（くるくる回ります）' } }],
  },
  {
    id: 'sync-done',
    about: 'The notice after a sync with nothing to set aside: 同期が完了しました (it hides itself).',
    ...MAIN,
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=同期が完了しました' }],
    crop: { region: { x: 640, y: 600, width: 640, height: 200 } },
    annotations: [{ box: 'text=同期が完了しました' }, { marker: { target: 'text=同期が完了しました', label: '1', at: 'left' } }],
  },
  {
    id: 'settings-auto-sync',
    about: '設定 →「自動同期」: 自動で受け取る (on) and 自動で送る (off), as a member first finds them.',
    page: 'download-folders',
    query: { tab: 'autosync', manual: '1' },
    steps: [{ waitFor: 'role=switch[name="自動で受け取る"]' }],
    annotations: [
      { marker: { target: 'role=switch[name="自動で受け取る"]', label: '1', at: 'left' } },
      { marker: { target: 'role=switch[name="自動で送る"]', label: '2', at: 'left' } },
    ],
  },

  // ── 12章 送る前に確かめる ────────────────────────────────────────────────
  {
    id: 'sync-preview',
    about: '「変更を確認」: the two changes, undo, the 作業メモ and この内容で同期.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: PREVIEW }, { waitFor: 'role=dialog' }],
    crop: { target: 'role=dialog', padding: 24 },
    annotations: [
      { box: PREVIEW_ROW('訪問メモ_1123.md') }, { marker: { target: PREVIEW_ROW('訪問メモ_1123.md'), label: '1', at: 'left' } },
      { box: `${PREVIEW_ROW('見積_下書き.md')} >> role=button[name="変更を元に戻す"]` },
      { marker: { target: `${PREVIEW_ROW('見積_下書き.md')} >> role=button[name="変更を元に戻す"]`, label: '2', at: 'right' } },
      { marker: { target: 'role=dialog >> role=textbox', label: '3', at: 'left' } },
      { box: 'role=button[name="この内容で同期"]' }, { marker: { target: 'role=button[name="この内容で同期"]', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'sync-preview-diff',
    about: 'A change opened from 「変更を確認」: the line added to 訪問メモ_1123.md.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: PREVIEW }, { click: PREVIEW_ROW('訪問メモ_1123.md') }, { waitFor: 'text=次回：12/1 に見積を持って再訪問' }],
    crop: { region: { x: 0, y: 50, width: 1280, height: 210 } },
    annotations: [{ box: 'text=次回：12/1 に見積を持って再訪問' }, { marker: { target: 'text=次回：12/1 に見積を持って再訪問', label: '1', at: 'below' } }],
  },
  {
    id: 'sync-revert-confirm',
    about: '「元に戻す」 on the added file: what will happen, and that the current content is kept.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: PREVIEW }, { click: `${PREVIEW_ROW('見積_下書き.md')} >> role=button[name="変更を元に戻す"]` }, { waitFor: 'text=変更を元に戻しますか？' }],
    crop: { target: 'role=alertdialog', padding: 24 },
    annotations: [
      { marker: { target: 'text=/今の内容は .backups に保存します/', label: '1', at: 'left' } },
      { box: 'role=alertdialog >> role=button[name="元に戻す"]' }, { marker: { target: 'role=alertdialog >> role=button[name="元に戻す"]', label: '2', at: 'below' } },
    ],
  },

  // ── 13章 同じファイルを二人が直したとき ──────────────────────────────────
  {
    id: 'same-file-diagram',
    about: 'Diagram: 佐藤さん syncs first; 山田さん’s sync keeps the server’s version and saves his to the backups.',
    diagram: true,
  },
  {
    id: 'sync-conflict-notice',
    about: 'The notice when the server’s version was kept: it stays until closed, with 履歴を見る.',
    ...MAIN,
    query: { ...MAIN.query, result: 'conflict' },
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/1ファイルが競合しました/' }],
    crop: { region: { x: 760, y: 560, width: 520, height: 240 } },
    annotations: [
      { marker: { target: 'text=/1ファイルが競合しました/', label: '1', at: 'left' } },
      { box: 'role=button[name="履歴を見る"]' }, { marker: { target: 'role=button[name="履歴を見る"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'backup-history',
    about: '「バックアップ履歴」 with the kept version opened: the file, 復元 and the folder.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: 'role=button[name="バックアップ履歴"]' }, { click: 'text="競合"' }, { waitFor: 'role=button[name="復元"]' }],
    crop: { region: { x: 768, y: 0, width: 512, height: 420 } },
    annotations: [
      { marker: { target: 'text="競合"', label: '1', at: 'left' } },
      { box: 'role=button[name="復元"]' }, { marker: { target: 'role=button[name="復元"]', label: '2', at: 'below' } },
      { marker: { target: 'role=button[name="フォルダを開く"] >> nth=0', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'backup-restore-confirm',
    about: '「復元」 asks first: the file is replaced, its current content kept in the backups.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: 'role=button[name="バックアップ履歴"]' }, { click: 'text="競合"' }, { click: 'role=button[name="復元"]' }, { waitFor: 'text=バックアップから復元しますか？' }],
    crop: { target: 'role=dialog', padding: 24 },
    annotations: [
      { marker: { target: 'text=/今の内容は .backups に保存してから置き換えます/', label: '1', at: 'left' } },
      { box: 'role=button[name="復元する"]' }, { marker: { target: 'role=button[name="復元する"]', label: '2', at: 'below' } },
    ],
  },

  // ── 14章 同期が止まったとき ──────────────────────────────────────────────
  {
    id: 'sync-stop-guide',
    about: 'Diagram: what each stop looks like and what to do (the Mac’s own questions included).',
    diagram: true,
  },
  {
    id: 'sync-stop-denied',
    about: 'Cancelled at 「編集できないファイルがあります」: sync stopped, the file named, nothing changed.',
    ...MAIN,
    query: { ...MAIN.query, result: 'denied' },
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/同期を中止しました/' }],
    crop: { region: { x: 760, y: 520, width: 520, height: 280 } },
    annotations: [{ marker: { target: 'text=/同期を中止しました/', label: '1', at: 'left' } }],
  },
  {
    id: 'sync-stop-restored',
    about: 'After 「元に戻して残りを同期」: that file put back, the member’s version in the backups.',
    ...MAIN,
    query: { ...MAIN.query, result: 'restored' },
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/元に戻しました/' }],
    crop: { region: { x: 760, y: 560, width: 520, height: 240 } },
    annotations: [
      { marker: { target: 'text=/元に戻しました/', label: '1', at: 'left' } },
      { box: 'role=button[name="履歴を見る"]' }, { marker: { target: 'role=button[name="履歴を見る"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'sync-stop-offline',
    about: 'The sync could not reach the server: the work stays on this PC, sent at the next sync.',
    ...MAIN,
    query: { ...MAIN.query, result: 'offline' },
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/次回の同期で再試行します/' }],
    crop: { region: { x: 760, y: 600, width: 520, height: 200 } },
    annotations: [{ marker: { target: 'text=/次回の同期で再試行します/', label: '1', at: 'left' } }],
  },
  {
    id: 'sync-waits-for-you',
    about: 'The sync button when automatic sync waits for the member (warning colour and mark).',
    ...MAIN,
    query: { ...MAIN.query, seed: JSON.stringify({ 'acb.autoSync.state:demo': JSON.stringify({ needsMember: true }) }) },
    steps: [CLOSE_LIST],
    crop: { region: { x: 560, y: 0, width: 720, height: 110 } },
    annotations: [{ box: SYNC_WAITS }, { note: { target: SYNC_WAITS, text: '① サーバーと同期（自動同期は止まっています）' } }],
  },

  // ── 15章 フォルダの見え方 ───────────────────────────────────────────────
  {
    id: 'tree-read-only',
    about: 'The 全社 tab: 総務部 marked 閲覧のみ for 山田さん.',
    ...MARKS,
    steps: [CLOSE_LIST, { click: 'role=button[name="全社" s]' }, { click: FILES_TAB }, { click: '[data-tree-path$="/営業部"]' }, { waitFor: 'text=閲覧のみ' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 200 } },
    annotations: [{ box: 'text=閲覧のみ' }, { marker: { target: 'text=閲覧のみ', label: '1', at: 'right' } }],
  },
  {
    id: 'tree-marks',
    about: 'The 営業部 tab: a private folder (lock) and a folder not downloaded (未ダウンロード).',
    ...MARKS,
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: FILES_TAB }, { waitFor: 'text=未ダウンロード' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 330 } },
    annotations: [
      { marker: { target: '[data-private-folder]', label: '1', at: 'right' } },
      { box: 'text=未ダウンロード' }, { marker: { target: 'text=未ダウンロード', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'tree-not-downloaded-menu',
    about: 'Right-clicking 過去資料 (not downloaded): ダウンロード.',
    ...MARKS,
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: FILES_TAB }, { rightClick: 'role=button[name="過去資料（未ダウンロード）"]' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 400 } },
    annotations: [{ box: 'role=button[name="ダウンロード"] >> nth=-1' }, { marker: { target: 'role=button[name="ダウンロード"] >> nth=-1', label: '1', at: 'right' } }],
  },
  {
    id: 'editor-read-only',
    about: 'A file of 総務部 opened: the 閲覧のみ notice above it.',
    ...MARKS,
    steps: [CLOSE_LIST, { click: 'role=button[name="総務部" s]' }, { click: FILES_TAB }, { click: 'role=button[name=/^申請書のひな形\\.md/]' }, { waitFor: 'text=/このフォルダは閲覧のみです/' }],
    crop: { region: { x: 0, y: 100, width: 1000, height: 300 } },
    annotations: [{ box: 'text=/このフォルダは閲覧のみです/' }, { marker: { target: 'text=/このフォルダは閲覧のみです/', label: '1', at: 'below' } }],
  },
  {
    id: 'tree-private-reader',
    about: 'Inside 提案前メモ (read by 3 people): the 非公開 band says how many.',
    ...MARKS,
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: FILES_TAB }, { click: 'role=button[name=/^C社_検討メモ\\.md/]' }, { waitFor: 'text=/非公開：3人だけが見られます/' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 330 } },
    annotations: [
      { box: 'text=/非公開：3人だけが見られます/' }, { marker: { target: 'text=/非公開：3人だけが見られます/', label: '1', at: 'below' } },
      { marker: { target: '[data-private-folder]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'tree-private-other',
    about: 'The same 営業部 for someone who does not read 提案前メモ: it is not in the list at all.',
    ...MAIN,
    query: { ...MAIN.query, folders: 'other' },
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: FILES_TAB }, { waitFor: 'text=未ダウンロード' }],
    crop: { region: { x: 0, y: 100, width: 430, height: 330 } },
    annotations: [],
  },
  {
    id: 'settings-download-folders',
    about: '設定 →「ダウンロードするフォルダ」: sizes, what is downloaded, 過去資料 left out.',
    page: 'download-folders',
    query: { manual: '1' },
    steps: [{ waitFor: 'text=/をダウンロード済み/' }],
    annotations: [
      { marker: { target: 'text=/をダウンロード済み/', label: '1', at: 'right' } },
      { marker: { target: 'text="営業部"', label: '2', at: 'left' } },
    ],
  },

  // ── 6章 AI に頼む（はじめて） ──────────────────────────────────────────
  {
    id: 'chat-claude-signin',
    about: '「AIへの相談」 before Claude is signed in: ［Claude にログインする］.',
    page: 'chat-header',
    query: { auth: 'none' },
    viewport: { width: 760, height: 560 },
    steps: [{ waitFor: 'role=button[name="Claude にログインする"]' }],
    crop: { target: 'text=Claude へのログインが必要です >> xpath=..', padding: 24 },
    annotations: [{ box: 'role=button[name="Claude にログインする"]' }, { marker: { target: 'role=button[name="Claude にログインする"]', label: '1', at: 'left' } }],
  },
  {
    id: 'ai-request-flow',
    about: 'Diagram: ask, the AI reads and makes files on this PC, asks with a card when needed, the member checks; sync sends.',
    diagram: true,
  },
  {
    id: 'chat-first-type',
    about: 'The first request typed into 「AIへの相談」, before sending.',
    ...LIVE,
    steps: [...SALES_FILES, { typeAtEnd: COMPOSER, text: FIRST_REQUEST }],
    crop: CHAT_CROP,
    annotations: [
      { box: COMPOSER_BOX }, { marker: { target: COMPOSER_BOX, label: '1' } },
      { marker: { target: SEND, label: '2', at: 'below' } },
    ],
  },
  {
    id: 'chat-first-reply',
    about: 'The AI read the visit notes and wrote the draft: its rows, its answer, and the new file in the list.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK(FIRST_REQUEST), { waitFor: 'text=/に作りました。見積を来週/' }, SETTLE],
    annotations: [
      { marker: { target: 'role=button[name=/^ファイルを読みました/]', label: '1', at: 'left' } },
      { box: 'role=button[name=/^ファイルに書きました/]' }, { marker: { target: 'role=button[name=/^ファイルに書きました/]', label: '2', at: 'left' } },
      { box: THANKS_FILE }, { marker: { target: THANKS_FILE, label: '3', at: 'right' } },
    ],
  },
  {
    id: 'chat-first-open',
    about: 'The draft the AI made, opened from the list.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK(FIRST_REQUEST), { waitFor: 'text=/に作りました。見積を来週/' }, { click: THANKS_FILE }, { waitFor: 'text=本日のお打ち合わせのお礼' }, { click: FOLD_SIDE }, SETTLE],
    annotations: [
      { marker: { target: THANKS_FILE, label: '1', at: 'right' } },
      { marker: { target: '.cm-line:has-text("見積を来週までにお送りいたします")', label: '2', at: 'left' } },
    ],
  },

  // ── 7章 上手な頼み方 ───────────────────────────────────────────────────
  {
    id: 'good-request',
    about: 'Diagram: a request says what, from which files, and where to put it.',
    diagram: true,
  },
  {
    id: 'chat-attach-file',
    about: 'A file dragged from the list onto the input waits there as a chip.',
    ...LIVE,
    steps: [...SALES_FILES, { drag: VISIT_MEMO, to: COMPOSER }, { typeAtEnd: COMPOSER, text: 'このメモをもとに、見積で確かめることを箇条書きにしてください。' }],
    crop: { region: { x: 860, y: 560, width: 420, height: 240 } },
    annotations: [
      { box: `${CHAT_PANE} >> [title$="訪問メモ_1123.md"]` }, { marker: { target: `${CHAT_PANE} >> [title$="訪問メモ_1123.md"]`, label: '1', at: 'left' } },
    ],
  },
  {
    id: 'chat-add-instruction',
    about: 'While the AI works: an instruction added from the input joins the running reply; 停止 stops it.',
    ...LIVE,
    steps: [
      ...SALES_FILES, ...ASK('訪問メモ_1123.md をもとに、A社への見積の下書きを 営業部/下書き/ に作ってください。'),
      { waitFor: 'role=button[name=/^ファイルを読んでいます/]' },
      ...ASK('値引きは書かないでください'),
      { waitFor: 'text=作業中に追加した指示' },
      SETTLE,
    ],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'role=button[name=/^ファイルを読んでいます/]', label: '1', at: 'left' } },
      { box: 'text=作業中に追加した指示 >> xpath=..' }, { marker: { target: 'text=作業中に追加した指示 >> xpath=..', label: '2', at: 'left' } },
      { box: `${CHAT_PANE} >> role=button[name="停止"]` }, { note: { target: `${CHAT_PANE} >> role=button[name="停止"]`, text: '③ 停止' } },
    ],
  },
  {
    id: 'chat-history-list',
    about: 'The list of consultations: a new one, search, earlier ones to continue.',
    ...LIVE,
    steps: [{ waitFor: 'text=見積の進め方の相談' }],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'role=button[name="AIに相談する"]', label: '1', at: 'left' } },
      { box: 'role=textbox[name="相談を検索"]' }, { marker: { target: 'role=textbox[name="相談を検索"]', label: '2', at: 'left' } },
      { box: 'role=button[name=/^A社へのお礼メール/]' }, { marker: { target: 'role=button[name=/^A社へのお礼メール/]', label: '3', at: 'left' } },
    ],
  },

  // ── 8章 AI が聞いてくるカード ─────────────────────────────────────────
  {
    id: 'ai-cards-guide',
    about: 'Diagram: the ways the AI stops and asks, and what the member does in each.',
    diagram: true,
  },
  {
    id: 'card-choice',
    about: 'A choice question above the input: pick one (or その他) and 回答する.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK('A社へのお礼メールを、見積のお知らせも入れて書き直してください。'), { waitFor: 'text=お礼メールの宛名はどれにしますか？' }, { click: 'text=田村様 >> nth=0' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'text=お礼メールの宛名はどれにしますか？', label: '1', at: 'left' } },
      { marker: { target: 'text="その他"', label: '2', at: 'left' } },
      { box: 'role=button[name="回答する"]' }, { marker: { target: 'role=button[name="回答する"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'card-tool-approval',
    about: 'A command the app asks about first (deleting a file): 許可 / 拒否.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK('下書きフォルダの古いお礼メール（お礼メール_A社_古い版.md）を消してください。'), { waitFor: 'text=ツール実行の確認' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'text=/^rm "営業部/', label: '1', at: 'left' } },
      { box: 'role=button[name="許可"]' }, { marker: { target: 'role=button[name="許可"]', label: '2', at: 'below' } },
      { marker: { target: 'role=button[name="拒否"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'card-review',
    about: '「確認をお願いします」: the file to look at, the points, この内容で進めて / 直してほしい.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK('訪問メモ_1123.md をもとに、A社への提案書の骨子を 営業部/提案書/ に作ってください。できたら確認をお願いします。'), { waitFor: 'role=group[name="確認をお願いします"]' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'role=list[name="見てほしいファイル"]', label: '1', at: 'left' } },
      { marker: { target: 'text=特に見てほしいところ', label: '2', at: 'left' } },
      { box: 'role=button[name="この内容で進めて"]' }, { marker: { target: 'role=button[name="この内容で進めて"]', label: '3', at: 'left' } },
      { marker: { target: 'role=button[name="直してほしい"]', label: '4', at: 'right' } },
    ],
  },
  {
    id: 'card-approval',
    about: '承認のお願い (only where the company uses it): the fixed content, the reason, 承認.',
    page: 'approval-card',
    query: { manual: '1' },
    crop: { target: 'section', padding: { x: 32, y: 16 } },
    annotations: [
      { box: 'text=1,500,000' }, { marker: { target: 'text=1,500,000', label: '1', at: 'right' } },
      { box: 'role=button[name="承認" s]' }, { marker: { target: 'role=button[name="承認" s]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'chat-write-guard',
    about: 'The AI tried to save into 総務部 (read only for 山田さん): refused before writing, and it asks.',
    ...LIVE,
    query: { ...LIVE.query, folders: 'marks' },
    steps: [...SALES_FILES, ...ASK('お礼メールの書き方のメモを、総務部のフォルダに保存してください。'), { waitFor: 'text=/保存してもよいですか/' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'role=button[name=/^できませんでした/]', label: '1', at: 'left' } },
      { box: 'text=/保存してもよいですか/' }, { marker: { target: 'text=/保存してもよいですか/', label: '2', at: 'left' } },
    ],
  },

  // ── 9章 Skill を使う ──────────────────────────────────────────────────
  {
    id: 'skill-what',
    about: 'Diagram: a skilled way of working becomes a Skill, sync brings it to everyone, each AI follows it.',
    diagram: true,
  },
  {
    id: 'skills-list',
    about: 'The 全社 tab’s スキル: the company’s two Skills, each with 実行 and 設定.',
    ...LIVE,
    steps: [CLOSE_LIST, { click: 'role=button[name="全社" s]' }, { click: SKILLS_TAB }, { waitFor: 'text=thank-you-mail' }],
    crop: { region: { x: 0, y: 48, width: 860, height: 560 } },
    annotations: [
      { marker: { target: 'role=button[name="全社" s]', label: '1', at: 'below' } },
      { box: SKILLS_TAB }, { marker: { target: SKILLS_TAB, label: '2' } },
      { box: SKILL_CARD('thank-you-mail') }, { marker: { target: SKILL_CARD('thank-you-mail'), label: '3' } },
      { marker: { target: `${SKILL_CARD('thank-you-mail')} >> role=button[name="実行"]`, label: '4', at: 'below' } },
    ],
  },
  {
    id: 'skill-detail',
    about: 'A Skill’s 設定: what it does, its SKILL.md, このSKILLを実行.',
    ...LIVE,
    steps: [CLOSE_LIST, { click: 'role=button[name="全社" s]' }, { click: SKILLS_TAB }, { click: `${SKILL_CARD('thank-you-mail')} >> role=button[name="設定"]` }, { waitFor: 'text=SKILL設定' }, SETTLE],
    crop: { region: { x: 0, y: 120, width: 1050, height: 680 } },
    annotations: [
      { box: 'role=button[name="このSKILLを実行"]' }, { marker: { target: 'role=button[name="このSKILLを実行"]', label: '1', at: 'left' } },
      { marker: { target: 'text="公開中"', label: '2', at: 'left' } },
      { marker: { target: 'text="説明"', label: '3', at: 'left' } },
      { box: 'role=button[name=/^SKILL\\.md/]' }, { marker: { target: 'role=button[name=/^SKILL\\.md/]', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'skill-md-open',
    about: 'The Skill’s SKILL.md opened in the editor: the AI’s instructions in plain words.',
    ...LIVE,
    steps: [CLOSE_LIST, { click: 'role=button[name="全社" s]' }, { click: SKILLS_TAB }, { click: `${SKILL_CARD('thank-you-mail')} >> role=button[name="設定"]` }, { click: 'role=button[name=/^SKILL\\.md/]' }, { waitFor: 'text=/件名は「本日のお打ち合わせのお礼」/' }, { click: FOLD_SIDE }, SETTLE],
    crop: { region: { x: 260, y: 120, width: 600, height: 380 } },
    annotations: [{ marker: { target: '.cm-line:has-text("1. 訪問メモを読み")', label: '1', at: 'left' } }],
  },
  {
    id: 'chat-slash-skill',
    about: '「/」 in the input lists the Skills to choose.',
    ...LIVE,
    steps: [...SALES_FILES, { typeAtEnd: COMPOSER, text: '/' }, { waitFor: 'text=訪問のあとのお礼メールを下書きする' }],
    // The list closes when the input loses focus.
    keepFocus: true,
    crop: { region: { x: 860, y: 400, width: 420, height: 400 } },
    annotations: [
      { marker: { target: `${COMPOSER} >> text=/`, label: '1', at: 'left' } },
      { box: 'role=button[name=/thank-you-mail/] >> nth=-1' }, { marker: { target: 'role=button[name=/thank-you-mail/] >> nth=-1', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'chat-skill-run',
    about: 'The Skill chosen with 「/」 and a request: the AI used the Skill, read the notes and wrote the draft.',
    ...LIVE,
    steps: [...SALES_FILES, ...ASK('/thank-you-mail 訪問メモ_1123.md をもとにお願いします。'), { waitFor: 'text=/の手順どおりに/' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'text=/^\\/thank-you-mail/', label: '1', at: 'left' } },
      { box: 'role=button[name=/^スキルを使いました/]' }, { marker: { target: 'role=button[name=/^スキルを使いました/]', label: '2', at: 'left' } },
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

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
const SELECTOR = { page: 'company-selector', query: { manual: '1' }, viewport: { width: 830, height: 680 } } as const
// 15章: 総務部 downloaded (閲覧のみ), 営業部/過去資料 not downloaded, the private folder 営業部/提案前メモ.
const MARKS = { page: 'skill-layout', query: { companies: '2', manual: '1', folders: 'marks' } } as const
const SIGN_IN = { page: 'sign-in', viewport: { width: 830, height: 620 } } as const

// 「AIへの相談」 opens with its list over a narrow chat (as in the app): closed for a picture of the screen.
const CLOSE_LIST: SceneStep = { click: 'role=complementary[name="AIへの相談"] >> role=button[name="AIへの相談の一覧を閉じる"]' }
const SALES_TAB = 'role=button[name="営業部" s]'
const FILES_TAB = 'role=button[name="ファイル" s]'
const SKILLS_TAB = 'role=button[name="Skill" s]'
const TASKS_TAB = 'role=button[name=/^やること/] >> nth=0'
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
/** A Skill's card in the Skill tab, by its name. */
/** The chat pane, with room on its left for markers. */
const CHAT_CROP = { target: CHAT_PANE, padding: { x: 32, y: 0 } }
/** Lets a panel that slides in come to rest before its parts are measured. */
const SETTLE: SceneStep = { run: 'new Promise(resolve => setTimeout(resolve, 600))' }
/** Folds the editor's side panel (つながっているもの・前の版): the preview's history is not this file's. */
const FOLD_SIDE = 'role=button[name="つながっているもの・前の版をたたむ"]'
// 17〜21章: the task list as 山田さん sees it (tasks-list-ui.html ?manual=1), a narrow column as in the app.
const TASKS = { page: 'tasks-list', query: { manual: '1' }, viewport: { width: 420, height: 880 } } as const
/** A section's heading of the task list, by its title. */
const TASK_SECTION = (title: string) => `role=region[name="${title}"] >> h3 >> span >> nth=0`
const QUICK_ADD = 'role=textbox[name="やることを足す"]'
const QUICK_CHIP = (which: 'due' | 'who' | 'bundle' | 'whenDone') => `[data-quick-chip="${which}"]`
// 18〜24章: a task's card as 山田さん sees it (task-card-ui.html ?manual=1).
const CARD = { page: 'task-card', query: { manual: '1' }, viewport: { width: 1100, height: 900 } } as const
// 24章: the meetings 山田さん attended (meetings-ui.html ?manual=1).
const MEETINGS = { page: 'meetings', query: { manual: '1' }, viewport: { width: 1100, height: 900 } } as const
const MINUTES_BLOCK = 'role=region[name="議事録が届きました"]'
// 17章: 「記録の一覧」 as 山田さん reads it (records-table-ui.html ?manual=1).
const TABLE = { page: 'records-table', query: { manual: '1' }, viewport: { width: 1100, height: 700 } } as const
const CARD_MORE = 'role=button[name="その他の操作"] >> nth=0'
// 28〜29章: 設定 →「Google」 after 山田さん allowed it (download-folders-ui.html ?manual=1&google=connected).
const GOOGLE_SETTINGS = { page: 'download-folders', query: { tab: 'google', google: 'connected', manual: '1', role: 'member' }, viewport: { width: 1100, height: 1000 } } as const
// 30章: 山田さん's mails after the meeting with A社 (mail-draft-card-ui.html ?manual=1), one card each.
const MAIL = { page: 'mail-draft-card', query: { manual: '1' }, viewport: { width: 900, height: 2000 } } as const
const THANKS_MAIL = 'role=group[name="メール：本日の打ち合わせのお礼"]'
const FILES_MAIL = 'role=group[name="メール：研修のご提案書をお送りします"]'
const SECOND_MAIL = 'role=group[name="メール：打ち合わせのお礼（山田より）"]'
// 31章: the manual's 法人営業 screens and 案件 (plugin-slots-ui.html ?manual=1).
const DEAL_SCREENS = { page: 'plugin-slots', query: { manual: '1' }, viewport: { width: 1100, height: 700 } } as const
// 32章: the plan card of a made-up 配信ツール (browser-plan-card-ui.html ?manual=1).
// 29章: the Drive card's first line in 設定 →「Google」.
const DRIVE_TEXT = 'text=/^あなたが Google Drive で選んだ/'
const PLAN_CARD = 'role=group[name="承認のお願い（ブラウザ操作）"]'
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
      { marker: { target: 'text=/今の内容は［バックアップ履歴］に保存します/', label: '1', at: 'left' } },
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
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/1件のファイルは、ほかの人も同じところを変えていたため/' }],
    crop: { region: { x: 760, y: 560, width: 520, height: 240 } },
    annotations: [
      { marker: { target: 'text=/1件のファイルは、ほかの人も同じところを変えていたため/', label: '1', at: 'left' } },
      { box: 'role=button[name="履歴を見る"]' }, { marker: { target: 'role=button[name="履歴を見る"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'backup-history',
    about: '「バックアップ履歴」 with the kept version opened: the file, 復元 and the folder.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: 'role=button[name="バックアップ履歴"]' }, { click: 'text="ほかの人も同じところを変えていたため、サーバーの版を残したときのあなたの版"' }, { waitFor: 'role=button[name="復元"]' }],
    crop: { region: { x: 768, y: 0, width: 512, height: 420 } },
    annotations: [
      { marker: { target: 'text="ほかの人も同じところを変えていたため、サーバーの版を残したときのあなたの版"', label: '1', at: 'left' } },
      { box: 'role=button[name="復元"]' }, { marker: { target: 'role=button[name="復元"]', label: '2', at: 'below' } },
      { marker: { target: 'role=button[name="フォルダを開く"] >> nth=0', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'backup-restore-confirm',
    about: '「復元」 asks first: the file is replaced, its current content kept in the backups.',
    ...MAIN,
    steps: [CLOSE_LIST, { click: 'role=button[name="バックアップ履歴"]' }, { click: 'text="ほかの人も同じところを変えていたため、サーバーの版を残したときのあなたの版"' }, { click: 'role=button[name="復元"]' }, { waitFor: 'text=バックアップから復元しますか？' }],
    crop: { target: 'role=dialog', padding: 24 },
    annotations: [
      { marker: { target: 'text=/今の内容もこの履歴に保存してから置き換えます/', label: '1', at: 'left' } },
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
    steps: [CLOSE_LIST, { click: SYNC }, { waitFor: 'text=/サーバーに届けられませんでした/' }],
    crop: { region: { x: 760, y: 600, width: 520, height: 200 } },
    annotations: [{ marker: { target: 'text=/サーバーに届けられませんでした/', label: '1', at: 'left' } }],
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
    viewport: { width: 830, height: 560 },
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
    steps: [...SALES_FILES, ...ASK('下書きフォルダの古いお礼メール（お礼メール_A社_古い版.md）を消してください。'), { waitFor: 'text=AI がこの操作をしてよいか確認しています' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { marker: { target: 'text=ファイルを消すコマンドを実行します', label: '1', at: 'left' } },
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
    about: 'The 全社 tab’s Skill tab: the company’s two Skills, each with 実行 and 設定.',
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
    about: 'A Skill’s 設定: what it does, its SKILL.md, この Skill を実行.',
    ...LIVE,
    steps: [CLOSE_LIST, { click: 'role=button[name="全社" s]' }, { click: SKILLS_TAB }, { click: `${SKILL_CARD('thank-you-mail')} >> role=button[name="設定"]` }, { waitFor: 'text=Skill の設定' }, SETTLE],
    crop: { region: { x: 0, y: 120, width: 1050, height: 680 } },
    annotations: [
      { box: 'role=button[name="この Skill を実行"]' }, { marker: { target: 'role=button[name="この Skill を実行"]', label: '1', at: 'left' } },
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
      { box: 'role=button[name=/^Skill を使いました/]' }, { marker: { target: 'role=button[name=/^Skill を使いました/]', label: '2', at: 'left' } },
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

  // ── 17章〜 2日目から：毎日の仕事 ───────────────────────────────────────────
  // The task list as 山田さん sees it (tasks-list-ui.html ?manual=1: 営業部, プロジェクト, 高橋さん and 佐藤さん).
  {
    id: 'tasks-list-by-turn',
    about: 'The task list by turn: 引き受け待ち, あなたの番 (with today\'s meeting), AI の番, ほかの人の番・返事待ち.',
    ...TASKS,
    annotations: [
      { marker: { target: TASK_SECTION('引き受け待ち'), label: '1', at: 'right' } },
      { marker: { target: TASK_SECTION('あなたの番'), label: '2', at: 'right' } },
      { marker: { target: TASK_SECTION('AI の番'), label: '3', at: 'right' } },
      { marker: { target: TASK_SECTION('ほかの人の番・返事待ち'), label: '4', at: 'right' } },
      { marker: { target: TASK_SECTION('今日終わったこと'), label: '5', at: 'right' } },
    ],
  },
  {
    id: 'tasks-list-header',
    about: 'The top of the task list: how it is arranged (番ごと / プロジェクトごと / 日付ごと), ［表で見る］ and the tags.',
    ...TASKS,
    crop: { region: { x: 0, y: 0, width: 420, height: 112 } },
    annotations: [
      { box: 'role=group[name="並べ方"]' }, { marker: { target: 'role=group[name="並べ方"]', label: '1', at: 'right' } },
      { box: 'role=button[name="表で見る"]' }, { marker: { target: 'role=button[name="表で見る"]', label: '2', at: 'left' } },
      { box: 'role=group[name="タグで絞る"]' }, { marker: { target: 'role=group[name="タグで絞る"]', label: '3', at: 'right' } },
    ],
  },
  {
    id: 'quick-add-chips',
    about: 'The one line: 「見積を直す 明日15時まで #営業」 typed, its due and tag read into the chips.',
    ...TASKS,
    steps: [{ click: QUICK_ADD }, { fill: QUICK_ADD, text: '見積を直す 月曜15時まで #営業' }, SETTLE],
    keepFocus: true,
    crop: { region: { x: 0, y: 40, width: 420, height: 92 } },
    annotations: [
      { box: QUICK_ADD }, { marker: { target: QUICK_ADD, label: '1', at: 'left' } },
      { marker: { target: QUICK_CHIP('due'), label: '2' } },
      { marker: { target: QUICK_CHIP('who'), label: '3' } },
      { marker: { target: 'text=あなただけに見えます', label: '4', at: 'right' } },
    ],
  },
  {
    id: 'quick-add-added',
    about: 'After Enter: the new task in あなたの番, 「あなただけ」.',
    ...TASKS,
    steps: [{ click: QUICK_ADD }, { fill: QUICK_ADD, text: '見積を直す 月曜15時まで #営業' }, { press: 'Enter' }, { waitFor: 'role=button[name=/^見積を直す/]' }, SETTLE],
    crop: { target: 'role=region[name="あなたの番"]', padding: { x: 0, y: 8 } },
    annotations: [
      { box: 'role=button[name=/^見積を直す/] >> xpath=..' },
    ],
  },
  {
    id: 'task-check-done',
    about: 'The ☐ pressed: the task moves to 今日終わったこと, struck through, with the green ✓ (やり直す).',
    ...TASKS,
    steps: [{ click: 'role=button[name="「お礼メールを確かめて送る」を完了にする"]' }, { waitFor: 'role=button[name="「お礼メールを確かめて送る」をやり直す"]' }, SETTLE],
    crop: { target: 'role=region[name="今日終わったこと"]', padding: { x: 0, y: 8 } },
    annotations: [
      { box: 'role=button[name="「お礼メールを確かめて送る」をやり直す"]' },
    ],
  },
  {
    id: 'tasks-archive',
    about: 'The folded アーカイブ opened: the tasks archived in the last 30 days.',
    ...TASKS,
    steps: [{ click: 'role=button[name=/^アーカイブ/]' }, { waitFor: 'text=名刺の注文' }, SETTLE],
    crop: { target: 'role=region[name="アーカイブ"]', padding: { x: 0, y: 8 } },
    annotations: [{ box: 'role=button[name=/^アーカイブ/]' }],
  },
  {
    id: 'quick-add-ask',
    about: 'Asking 高橋さん from the one line: ［高橋さんに頼む］ and ［終わったら：知らせるだけ］.',
    ...TASKS,
    steps: [{ click: QUICK_ADD }, { fill: QUICK_ADD, text: 'セキュリティ資料を送る 火曜まで' }, { click: QUICK_CHIP('who') }, { click: '[data-quick-person="高橋"]' }, SETTLE],
    keepFocus: true,
    crop: { region: { x: 0, y: 40, width: 420, height: 98 } },
    annotations: [
      { box: QUICK_CHIP('who') }, { marker: { target: QUICK_CHIP('who'), label: '1', at: 'right' } },
      { box: QUICK_CHIP('whenDone') }, { marker: { target: QUICK_CHIP('whenDone'), label: '2', at: 'right' } },
    ],
  },
  {
    id: 'tasks-list-asked',
    about: 'What 山田さん asked of others: 「高橋さんに頼んだ・引き受け待ち」 with the 「人に頼んだもの」 mark, and a 返事待ち.',
    ...TASKS,
    crop: { target: 'role=region[name="ほかの人の番・返事待ち"]', padding: { x: 0, y: 8 } },
    annotations: [
      { box: 'role=img[name="人に頼んだもの"]' }, { marker: { target: 'text=高橋さんに頼んだ・引き受け待ち', label: '1', at: 'right' } },
      { marker: { target: 'text=/^返事待ち：/', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'task-accept',
    about: 'A task 佐藤さん asked of 山田さん, in 引き受け待ち with ［引き受ける］.',
    ...TASKS,
    crop: { target: 'role=region[name="引き受け待ち"]', padding: { x: 0, y: 8 } },
    annotations: [{ box: 'role=button[name="引き受ける"]' }, { marker: { target: 'role=button[name="引き受ける"]', label: '1', at: 'left' } }],
  },
  {
    id: 'tasks-list-delegate',
    about: '山田さん covers 高橋さん while he is away: 「高橋さんの代わり」 on the row.',
    ...TASKS,
    query: { manual: '1', absent: '1' },
    crop: { target: 'role=region[name="あなたの番"]', padding: { x: 0, y: 8 } },
    annotations: [{ box: 'text=高橋さんの代わり' }],
  },
  {
    id: 'tasks-list-ai-turn',
    about: 'AI の番: one the AI is working on, one it could not finish with ［もう一度］［人に渡す］.',
    ...TASKS,
    crop: { target: 'role=region[name="AI の番"]', padding: { x: 0, y: 8 } },
    annotations: [
      { marker: { target: 'text=AI が進めています', label: '1', at: 'right' } },
      { box: 'role=button[name="もう一度"]' }, { marker: { target: 'role=button[name="もう一度"]', label: '2', at: 'below' } },
      { box: 'role=button[name="人に渡す"]' }, { marker: { target: 'role=button[name="人に渡す"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'task-card-origin',
    about: 'A task the AI made from a meeting: 「会議『…』から AI が作りました」, ［根拠を見る］ opened.',
    ...CARD,
    steps: [{ click: 'role=button[name="根拠を見る"]' }, SETTLE],
    crop: { region: { x: 0, y: 0, width: 830, height: 150 } },
    annotations: [
      { marker: { target: 'text=/からAI が作りました/', label: '1', at: 'left' } },
      { box: 'role=button[name="根拠をたたむ"] >> xpath=..' },
    ],
  },
  {
    id: 'task-postpone',
    about: '延ばす on the due: the choices (1時間あと, 今日の夕方, あしたの朝…).',
    ...CARD,
    steps: [{ click: 'role=button[name="延ばす"]' }, { waitFor: 'role=group[name="延ばす"]' }],
    crop: { target: 'role=group[name="延ばす"]', padding: { x: 60, y: 90 } },
    annotations: [
      { box: 'role=button[name="延ばす"]' }, { marker: { target: 'role=button[name="延ばす"]', label: '1', at: 'right' } },
      { box: 'role=group[name="延ばす"]' }, { marker: { target: 'role=group[name="延ばす"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'task-archive-menu',
    about: 'The card\'s 「…」 with ［アーカイブ］ and its line: 一覧から外します。消しません。',
    ...CARD,
    query: { manual: '1', task: 'todo-own' },
    steps: [{ click: CARD_MORE }, { waitFor: 'role=menu' }],
    crop: { target: 'role=menu', padding: { x: 60, y: 70 } },
    annotations: [{ box: 'role=menuitem[name=/^アーカイブ/]' }, { marker: { target: 'role=menuitem[name=/^アーカイブ/]', label: '1', at: 'left' } }],
  },
  {
    id: 'task-only-you',
    about: 'A task 山田さん added: 「あなただけ」 top right and ［部署に出す］ below.',
    ...CARD,
    query: { manual: '1', own: '1' },
    crop: { region: { x: 0, y: 0, width: 830, height: 330 } },
    annotations: [
      { box: 'text=あなただけ >> nth=0' }, { marker: { target: 'text=あなただけ >> nth=0', label: '1', at: 'left' } },
      { box: 'role=button[name="部署に出す"]' }, { marker: { target: 'role=button[name="部署に出す"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'task-share-department',
    about: '［部署に出す］ opened: the department, 「あとから「あなただけ」には戻せません」, ［この部署に出す］.',
    ...CARD,
    query: { manual: '1', own: '1' },
    viewport: { width: 1100, height: 1000 },
    steps: [{ click: 'role=button[name="部署に出す"]' }, { waitFor: 'role=group[name="部署に出す"]' }],
    crop: { target: 'role=group[name="部署に出す"]', padding: { x: 40, y: 20 } },
    annotations: [
      { marker: { target: 'role=group[name="部署に出す"] >> role=combobox', label: '1', at: 'right' } },
      { box: 'text=/には戻せません/' },
      { marker: { target: 'role=button[name="この部署に出す"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'task-share-similar',
    about: 'After ［部署に出す］: 「似ているやることがあります」 with ［まとめる］［このまま］.',
    ...CARD,
    query: { manual: '1', own: '1', similar: '1' },
    viewport: { width: 1100, height: 1000 },
    steps: [{ click: 'role=button[name="部署に出す"]' }, { click: 'role=button[name="この部署に出す"]' }, { waitFor: 'text=/似ているやることがあります/' }, SETTLE],
    crop: { target: 'text=/似ているやることがあります/ >> xpath=..', padding: { x: 24, y: 16 } },
    annotations: [{ box: 'role=button[name="まとめる"]' }, { box: 'role=button[name="このまま"]' }],
  },
  {
    id: 'task-seen-department',
    about: 'A task shown to 営業部: 「営業部のみんな」 top right.',
    ...CARD,
    crop: { region: { x: 0, y: 0, width: 830, height: 100 } },
    annotations: [{ box: 'text=営業部のみんな' }],
  },
  {
    id: 'task-decline-dialog',
    about: '「…」→［受けられない］: what happens, who is told, the reason.',
    ...CARD,
    steps: [{ click: CARD_MORE }, { click: 'role=menuitem[name=/^受けられない/]' }, { waitFor: 'role=textbox[name="理由"]' }, { fill: 'role=textbox[name="理由"]', text: '今週は展示会の準備で手が回りません。来週なら引き受けられます。' }, SETTLE],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: 'role=dialog >> text=何が起きるか', label: '1', at: 'left' } },
      { marker: { target: 'role=dialog >> text=知らせる人', label: '2', at: 'left' } },
      { box: 'role=textbox[name="理由"]' }, { marker: { target: 'role=textbox[name="理由"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'task-wait-dialog',
    about: '「…」→［返事待ちにする］: what it waits for and when it may come (明日 / 3日後 / 来週 / 日を選ぶ).',
    ...CARD,
    query: { manual: '1', task: 'todo-own' },
    steps: [{ click: CARD_MORE }, { click: 'role=menuitem[name=/^返事待ちにする/]' }, { waitFor: 'text=いつごろ来そうか' }, { fill: 'role=dialog >> role=textbox >> nth=0', text: '先方からの見積の返事' }, { click: 'role=button[name=/^3日後/]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: 'text=何を待っていますか', label: '1', at: 'left' } },
      { marker: { target: 'text=いつごろ来そうか', label: '2', at: 'left' } },
      { box: 'role=button[name=/^3日後/]' },
    ],
  },
  {
    id: 'task-wait-came-back',
    about: 'The 見込み passed: 「先方からの返事が来ていません」 and ［催促の下書きを作る］［もう少し待つ］［完了にする］.',
    ...CARD,
    query: { manual: '1', task: 'back' },
    crop: { region: { x: 0, y: 0, width: 830, height: 330 } },
    annotations: [
      { marker: { target: 'text=/返事が来ていません/', label: '1', at: 'right' } },
      { box: 'role=button[name="催促の下書きを作る"]' },
    ],
  },
  {
    id: 'task-done-on-ok',
    about: 'A task completed on someone\'s OK: 「山田さんが高橋さんの了承を得たとして完了にしました（電話で）」.',
    ...CARD,
    query: { manual: '1', task: 'done' },
    crop: { region: { x: 0, y: 0, width: 830, height: 200 } },
    annotations: [{ box: 'text=/了承を得たとして完了にしました/ >> nth=0' }],
  },
  {
    id: 'task-ai-prepared',
    about: 'AI が用意したもの at the top of the card: the thank-you mail draft, ［確かめて送る］ is the person\'s.',
    ...CARD,
    crop: { target: 'role=region[name="AI が用意したもの"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'role=region[name="AI が用意したもの"] >> text=AI が用意したもの', label: '1', at: 'right' } },
      { box: 'role=button[name="確かめて送る"]' }, { marker: { target: 'role=button[name="確かめて送る"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'task-consult',
    about: 'The card\'s right column: 「AIへの相談」 with ［相談する］, and the files with ［＋ファイル・フォルダをつなぐ］［＋新しいファイル］.',
    ...CARD,
    query: { manual: '1', own: '1', consult: 'none' },
    crop: { region: { x: 840, y: 0, width: 260, height: 560 } },
    annotations: [
      { box: 'role=button[name=/ファイル・フォルダをつなぐ/]' }, { marker: { target: 'role=button[name=/ファイル・フォルダをつなぐ/]', label: '1', at: 'left' } },
      { box: 'role=button[name=/新しいファイル/]' }, { marker: { target: 'role=button[name=/新しいファイル/]', label: '2', at: 'left' } },
      { box: 'role=button[name=/^相談する/]' }, { marker: { target: 'role=button[name=/^相談する/]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'task-bundle-field',
    about: 'A task in no プロジェクト yet: ［プロジェクトにつなぐ］［新しいプロジェクトにする］.',
    ...CARD,
    query: { manual: '1', own: '1' },
    crop: { region: { x: 0, y: 90, width: 830, height: 140 } },
    annotations: [
      { box: 'role=button[name="プロジェクトにつなぐ"]' }, { marker: { target: 'role=button[name="プロジェクトにつなぐ"]', label: '1', at: 'below' } },
      { box: 'role=button[name="新しいプロジェクトにする"]' }, { marker: { target: 'role=button[name="新しいプロジェクトにする"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'minutes-review',
    about: '「議事録を確認する」: the AI\'s proposals (［全部足す］［選んで足す］［要らない］) and the decisions (［そうです］［違う］).',
    ...CARD,
    query: { manual: '1', task: 'review' },
    viewport: { width: 1100, height: 1150 },
    crop: { region: { x: 0, y: 0, width: 830, height: 880 } },
    annotations: [
      { box: 'role=button[name="全部足す"]' }, { marker: { target: 'role=button[name="全部足す"]', label: '1', at: 'left' } },
      { marker: { target: 'text=/の根拠|「来週までに修正した見積をお送りします」/ >> nth=0', label: '2', at: 'right' } },
      { box: 'role=button[name="そうです"] >> nth=0' }, { marker: { target: 'role=button[name="違う"] >> nth=0', label: '3', at: 'right' } },
      { marker: { target: 'text=責任者の確認待ち >> nth=0', label: '4', at: 'right' } },
    ],
  },
  {
    id: 'project-card',
    about: 'A プロジェクト whose 責任者 is 山田さん: なんのため, 責任者, 進み具合, みんなのやること, ［終える］.',
    page: 'record-card',
    query: { record: 'project', manual: '1' },
    viewport: { width: 1100, height: 900 },
    crop: { region: { x: 0, y: 0, width: 830, height: 500 } },
    annotations: [
      { marker: { target: 'text=なんのため', label: '1', at: 'left' } },
      { marker: { target: 'text=進み具合', label: '2', at: 'left' } },
      { marker: { target: 'text=みんなのやること', label: '3', at: 'left' } },
      { box: 'role=button[name="終える"]' }, { marker: { target: 'role=button[name="終える"]', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'project-stop-dialog',
    about: '「…」→［やめる］ on a プロジェクト: 「一覧から外れ、このタブは閉じます。消しません（経緯は残ります）」.',
    page: 'record-card',
    query: { record: 'project', manual: '1' },
    viewport: { width: 1100, height: 900 },
    steps: [{ click: CARD_MORE }, { click: 'role=menuitem[name=/^やめる/]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'incoming-unsure',
    about: 'A 来た連絡 the AI was unsure about: who, 要約（本文は Slack にあります）, ［済んだ］ and 「…」.',
    page: 'record-card',
    query: { record: 'slack', manual: '1' },
    viewport: { width: 1100, height: 700 },
    crop: { region: { x: 0, y: 0, width: 830, height: 330 } },
    annotations: [
      { box: 'role=button[name="済んだ"]' }, { marker: { target: 'role=button[name="済んだ"]', label: '1', at: 'below' } },
      { marker: { target: CARD_MORE, label: '2', at: 'below' } },
    ],
  },
  {
    id: 'reply-request-card',
    about: 'A 返事のお願い: ［終わりにする］, and ［もう返した］ in 「…」.',
    page: 'record-card',
    query: { record: 'reply', manual: '1' },
    viewport: { width: 1100, height: 700 },
    steps: [{ click: CARD_MORE }, { waitFor: 'role=menu' }],
    crop: { region: { x: 0, y: 0, width: 830, height: 170 } },
    annotations: [
      { box: 'role=button[name="終わりにする"]' },
      { box: 'role=menuitem[name=/^もう返した/]' },
    ],
  },
  {
    id: 'minutes-arrived',
    about: '「議事録が届きました」 above the list: ［AI に読ませる］［読まない］ on each meeting.',
    ...MEETINGS,
    crop: { target: MINUTES_BLOCK, padding: { x: 0, y: 4 } },
    annotations: [
      { box: 'role=button[name="AI に読ませる"] >> nth=1' },
      { box: 'role=button[name="読まない"] >> nth=1' },
    ],
  },
  {
    id: 'minutes-read-done',
    about: 'The AI read it: 「読み終わりました …：決めたことN・やることの案N」 with ［見る］.',
    ...MEETINGS,
    steps: [{ click: 'role=button[name="AI に読ませる"] >> nth=1' }, { waitFor: 'text=/が読んでいます/' }, { run: "window.__acbMeetings.finish('meeting-mensetu1')" }, { waitFor: 'role=button[name="見る"]' }, SETTLE],
    crop: { target: MINUTES_BLOCK, padding: { x: 0, y: 4 } },
    annotations: [{ box: 'role=button[name="見る"]' }],
  },
  {
    id: 'meeting-card',
    about: 'The meeting\'s card: who attended and who can see it, the summary, the AI\'s proposals, ［招待する］.',
    ...MEETINGS,
    steps: [{ run: "window.__acbMeetings.finish('meeting-teirei01')" }, { click: 'role=button[name="見る"] >> nth=0' }, { waitFor: 'role=button[name="招待する"]' }, SETTLE],
    crop: { region: { x: 300, y: 0, width: 800, height: 900 } },
    annotations: [
      { marker: { target: 'text=/参加者のうち ACB の人/', label: '1', at: 'left' } },
      { marker: { target: 'text=決めたことの案 >> nth=0', label: '2', at: 'right' } },
      { marker: { target: 'text=やることの案 >> nth=0', label: '3', at: 'right' } },
      { marker: { target: 'text=この定例は次から自動で読みますか？', label: '4', at: 'left' } },
      { box: 'role=button[name="招待する"]' }, { marker: { target: 'role=button[name="招待する"]', label: '5', at: 'right' } },
      { marker: { target: 'text=/の会議ですか？/', label: '6', at: 'left' } },
    ],
  },
  {
    id: 'meeting-invite',
    about: '［招待する］: who to add, 「一度招待すると、取り消すことはできません」.',
    ...MEETINGS,
    steps: [{ run: "window.__acbMeetings.finish('meeting-teirei01')" }, { click: 'role=button[name="見る"] >> nth=0' }, { click: 'role=button[name="招待する"]' }, { waitFor: 'role=dialog' }, SETTLE],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'title-bar-inbox',
    about: 'The title bar\'s ［受け箱］: the number of things waiting for you and the dot for something new.',
    page: 'title-bar-notices',
    viewport: { width: 760, height: 400 },
    crop: { region: { x: 520, y: 0, width: 240, height: 80 } },
    annotations: [
      { marker: { target: '[data-inbox-count]', label: '1', at: 'below' } },
      { marker: { target: '[data-testid="inbox-news-dot"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'inbox-panel',
    about: 'The inbox (受け箱) opened below: the chips, あなた待ち first, the buttons that only open a card.',
    page: 'inbox',
    query: { manual: '1' },
    viewport: { width: 1000, height: 800 },
    crop: { target: 'role=region[name="受け箱"]', padding: 0 },
    annotations: [
      { box: 'role=button[name=/^あなた待ち/]' }, { marker: { target: 'role=button[name=/^あなた待ち/]', label: '1', at: 'below' } },
      { box: 'role=button[name=/^確かめて送る/] >> nth=0' }, { marker: { target: 'role=button[name=/^確かめて送る/] >> nth=0', label: '2', at: 'left' } },
      { marker: { target: 'role=button[name="知らせの設定"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'inbox-done',
    about: 'できた・未確認: what others finished, and ［まとめて確認済みにする］.',
    page: 'inbox',
    query: { manual: '1' },
    viewport: { width: 1000, height: 800 },
    steps: [{ click: 'role=button[name=/^できた・未確認/]' }, SETTLE],
    crop: { target: 'role=region[name="受け箱"]', padding: 0 },
    annotations: [{ box: 'role=button[name="まとめて確認済みにする"]' }],
  },
  {
    id: 'inbox-settings',
    about: '「知らせの設定」: one switch per kind of notice.',
    page: 'title-bar-notices',
    viewport: { width: 900, height: 900 },
    steps: [{ click: '[data-inbox-button]' }, { click: 'role=button[name="知らせの設定"]' }, { waitFor: 'role=dialog' }, SETTLE],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'records-table',
    about: '記録の一覧 (［表で見る］): the kinds, 状態 済み以外, the text filter, ［列］, sortable headers.',
    ...TABLE,
    steps: [{ click: 'role=button[name="表で見る（やること）"]' }, { waitFor: 'role=row[name="お礼メールを確かめて送る"]' }, SETTLE],
    crop: { region: { x: 0, y: 44, width: 1100, height: 380 } },
    annotations: [
      { box: 'role=group[name="種類"]' }, { marker: { target: 'role=group[name="種類"]', label: '1', at: 'right' } },
      { marker: { target: 'section[aria-label="記録の一覧"] select', label: '2' } },
      { marker: { target: 'role=searchbox[name="文字で絞り込む"]', label: '3' } },
      { marker: { target: 'role=button[name="列"]', label: '4', at: 'left' } },
      { box: 'role=columnheader[name=/期限/]' }, { marker: { target: 'role=columnheader[name=/期限/]', label: '5' } },
    ],
  },
  {
    id: 'records-table-filter',
    about: 'The table narrowed by a word (高橋) and sorted by 期限.',
    ...TABLE,
    steps: [{ click: 'role=button[name="表で見る（やること）"]' }, { waitFor: 'role=row[name="お礼メールを確かめて送る"]' }, { fill: 'role=searchbox[name="文字で絞り込む"]', text: '高橋' }, SETTLE],
    crop: { region: { x: 0, y: 44, width: 1100, height: 300 } },
    annotations: [{ box: 'role=searchbox[name="文字で絞り込む"]' }],
  },
  {
    id: 'records-table-palette',
    about: '⌘K: typing 「記録」 offers 「記録の一覧」.',
    ...TABLE,
    steps: [{ click: 'role=button[name="⌘K を開く"]' }, { fill: 'role=dialog >> input >> nth=0', text: '記録' }, SETTLE],
    keepFocus: true,
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [{ box: 'role=dialog >> text=記録の一覧 >> nth=0' }],
  },
  {
    id: 'approval-card-requester',
    about: 'The approval request as 山田さん, who asked, sees it: 「佐藤さんの承認待ち」 and ［取り下げる］.',
    page: 'approval-card',
    query: { manual: '1', viewer: 'requester' },
    crop: { target: 'section', padding: { x: 32, y: 16 } },
    annotations: [
      { box: 'text=佐藤さんの承認待ち' }, { marker: { target: 'text=佐藤さんの承認待ち', label: '1', at: 'left' } },
      { box: 'role=button[name="取り下げる"]' }, { marker: { target: 'role=button[name="取り下げる"]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'approval-card-approver',
    about: 'The same request as 佐藤さん, who decides, sees it: the change, the reason to write, ［承認］［差し戻す］.',
    page: 'approval-card',
    query: { manual: '1', approver: 'sato' },
    crop: { target: 'section', padding: { x: 32, y: 16 } },
    annotations: [
      { box: 'text=1,500,000 >> nth=0' }, { marker: { target: 'text=1,500,000 >> nth=0', label: '1', at: 'right' } },
      { box: 'role=textbox' }, { marker: { target: 'role=textbox', label: '2', at: 'left' } },
      { box: 'role=button[name="承認" s]' }, { marker: { target: 'role=button[name="承認" s]', label: '3', at: 'left' } },
      { box: 'role=button[name="差し戻す"]' }, { marker: { target: 'role=button[name="差し戻す"]', label: '4', at: 'right' } },
    ],
  },
  {
    id: 'tasks-whole',
    about: 'The main screen in the morning: ［受け箱］ in the title bar, the left tab ［やること］ and its list.',
    page: 'skill-layout',
    query: { companies: '2', manual: '1', tasks: 'manual' },
    steps: [CLOSE_LIST, { click: SALES_TAB }, { click: TASKS_TAB }, { waitFor: 'text=セキュリティのチェックシートを埋める' }, SETTLE],
    annotations: [
      { box: '[data-inbox-button]' }, { marker: { target: '[data-inbox-button]', label: '1', at: 'below' } },
      { box: TASKS_TAB }, { marker: { target: TASKS_TAB, label: '2', at: 'right' } },
      { box: LEFT_PANE }, { marker: { target: 'text=引き受け待ち >> nth=0', label: '3', at: 'right' } },
    ],
  },
  {
    id: 'chat-task-made',
    about: '「…をやることに入れて」 in 「AIへの相談」: the AI made it and says it is 「あなただけ」.',
    ...LIVE,
    steps: [CLOSE_LIST, ...ASK('A社の見積を直す件を、月曜15時までのやることに入れて。'), { waitFor: 'text=/あなただけに見えるやることに入れました/' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [
      { box: 'role=button[name=/^記録を作りました/]' }, { marker: { target: 'role=button[name=/^記録を作りました/]', label: '1', at: 'left' } },
      { marker: { target: 'text=/あなただけに見えるやることに入れました/', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'chat-job-question',
    about: 'The third day with the same Skill: after the work, the AI asks once whether to make it a time job.',
    ...LIVE,
    steps: [CLOSE_LIST, ...ASK('/weekly-report 今週の訪問メモから週報をまとめてください。'), { waitFor: 'text=/定期の仕事としてやりましょうか/' }, SETTLE],
    crop: CHAT_CROP,
    annotations: [{ box: 'text=/定期の仕事としてやりましょうか/' }],
  },
  {
    id: 'job-proposal-card',
    about: 'After 「はい」: the proposal card — when, what makes it run, what it does — ［これで管理者に出す］［やめる］.',
    ...LIVE,
    viewport: { width: 1280, height: 1800 },
    steps: [CLOSE_LIST, ...ASK('はい。毎週月曜の朝9時にお願いします。'), { waitFor: 'role=button[name="これで管理者に出す"]' }, SETTLE,
      { run: "[...document.querySelectorAll('button')].find(b => b.textContent === 'これで管理者に出す')?.scrollIntoView({ block: 'center' })" }, SETTLE],
    crop: { target: 'role=button[name="これで管理者に出す"] >> xpath=ancestor::*[.//text()[contains(., "定期の仕事の案")]][1]', padding: { x: 32, y: 16 } },
    annotations: [
      { box: 'role=button[name="これで管理者に出す"]' }, { marker: { target: 'role=button[name="これで管理者に出す"]', label: '1', at: 'left' } },
      { box: 'role=button[name="やめる"]' }, { marker: { target: 'role=button[name="やめる"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'settings-my-switches',
    about: '設定 →「自分の設定」: 「AI が自動で進める」, 「受信を読む」 and 「AI から定期の仕事を提案してもらう」.',
    page: 'download-folders',
    query: { tab: 'mine', manual: '1', role: 'member' },
    viewport: { width: 1100, height: 1000 },
    steps: [{ waitFor: 'text=AI が自動で進める' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=受信を読む >> nth=0', label: '1', at: 'left' } },
      { marker: { target: 'text=AI が自動で進める >> nth=0', label: '2', at: 'left' } },
      { marker: { target: 'text=AI から定期の仕事を提案してもらう >> nth=0', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'settings-jobs',
    about: '設定 →「定期の仕事」: the approved job waiting for ［受け取る］, and 「出した案」.',
    page: 'download-folders',
    query: { tab: 'jobs', manual: '1', role: 'member' },
    viewport: { width: 1100, height: 1000 },
    steps: [{ waitFor: 'role=button[name="受け取る"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [{ box: 'role=button[name="受け取る"]' }, { marker: { target: 'role=button[name="受け取る"]', label: '1', at: 'left' } }],
  },
  {
    id: 'settings-jobs-running',
    about: 'After ［受け取る］: 「あなたの定期の仕事」 with ［止める］.',
    page: 'download-folders',
    query: { tab: 'jobs', manual: '1', role: 'member', jobs: 'accepted' },
    viewport: { width: 1100, height: 1000 },
    steps: [{ waitFor: 'role=button[name="止める"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [{ box: 'role=button[name="止める"]' }, { marker: { target: 'role=button[name="止める"]', label: '1', at: 'left' } }],
  },
  {
    id: 'ask-flow-diagram',
    about: 'Diagram: asking 高橋さん — 頼む, 引き受け待ち, 引き受ける / 受けられない, 完了, the notice back.',
    diagram: true,
  },
  {
    id: 'minutes-flow-diagram',
    about: 'Diagram: after a meeting — minutes arrive, someone has the AI read them, the AI proposes, people decide.',
    diagram: true,
  },
  {
    id: 'daily-flow-diagram',
    about: 'Diagram: one working day — the morning\'s two places, during the day, after a meeting, before going home.',
    diagram: true,
  },
  // ── 28章〜 つなぐと広がる ─────────────────────────────────────────────────────
  // 28章: 「仕事の道具をつなぐ」 as a new member of 検証A社 first sees it (connect-tools-ui.html ?manual=1).
  {
    id: 'connect-tools-first',
    about: '「仕事の道具をつなぐ」 after the first sign-in: what Google and Slack add, ［Google でつなぐ］［Slack でつなぐ］［あとで］.',
    page: 'connect-tools',
    query: { state: 'first', manual: '1' },
    viewport: { width: 900, height: 820 },
    steps: [{ waitFor: 'role=button[name="Google でつなぐ"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=/^ふだん使っている Google や Slack/', label: '1', at: 'left' } },
      { box: 'role=button[name="Google でつなぐ"]' }, { marker: { target: 'role=button[name="Google でつなぐ"]', label: '2', at: 'right' } },
      { box: 'role=button[name="Slack でつなぐ"]' }, { marker: { target: 'role=button[name="Slack でつなぐ"]', label: '3', at: 'right' } },
      { box: 'role=button[name="あとで"]' }, { marker: { target: 'role=button[name="あとで"]', label: '4', at: 'left' } },
    ],
  },
  // 設定 →「Google」 after 山田さん allowed it (download-folders-ui.html ?manual=1&google=connected).
  {
    id: 'settings-google-allowed',
    about: '設定 →「Google」 allowed: what is allowed, ［メールを送る許可も足す］, ［許可をやめる］ and the Gmail archive card.',
    ...GOOGLE_SETTINGS,
    steps: [{ waitFor: 'text=許可していること' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=許可していること', label: '1', at: 'left' } },
      { box: 'role=button[name="メールを送る許可も足す"]' }, { marker: { target: 'role=button[name="メールを送る許可も足す"]', label: '2', at: 'below' } },
      { box: 'role=button[name="許可をやめる"]' }, { marker: { target: 'role=button[name="許可をやめる"]', label: '3', at: 'below' } },
      { marker: { target: 'text=済んだメールを Gmail でもアーカイブする', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'settings-slack',
    about: '設定 →「Slack」 allowed: DMs and mentions, 「あなたの番」 by DM, ［返事を送る許可も足す］.',
    page: 'download-folders',
    query: { tab: 'slack', slack: 'connected', manual: '1', role: 'member' },
    viewport: { width: 1100, height: 760 },
    steps: [{ waitFor: 'role=button[name="返事を送る許可も足す"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=許可していること', label: '1', at: 'left' } },
      { marker: { target: 'role=checkbox', label: '2', at: 'left' } },
      { box: 'role=button[name="返事を送る許可も足す"]' }, { marker: { target: 'role=button[name="返事を送る許可も足す"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'broker-key-card',
    about: 'In a consultation: 「Google Gemini の鍵がありません」 with the way to 設定 →「自分の鍵」.',
    page: 'broker-key-card',
    viewport: { width: 900, height: 700 },
    steps: [{ waitFor: 'role=group[name="Google Gemini の鍵がありません"] >> role=button' }],
    crop: { target: 'role=group[name="Google Gemini の鍵がありません"]', padding: { x: 16, y: 4 } },
    annotations: [
      { box: 'role=group[name="Google Gemini の鍵がありません"] >> role=button' }, { marker: { target: 'role=group[name="Google Gemini の鍵がありません"] >> role=button', label: '1', at: 'right' } },
    ],
  },
  {
    id: 'settings-own-keys',
    about: '設定 →「自分の鍵」: the key stays on the company server; ［自分の鍵を登録］.',
    page: 'download-folders',
    query: { tab: 'ownkeys', manual: '1', role: 'member' },
    viewport: { width: 1100, height: 700 },
    steps: [{ waitFor: 'role=button[name="自分の鍵を登録"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=/^AI が Skill の中で外部サービス/', label: '1', at: 'left' } },
      { box: 'role=button[name="自分の鍵を登録"]' }, { marker: { target: 'role=button[name="自分の鍵を登録"]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'connect-what-diagram',
    about: 'Diagram: what connecting Google and Slack adds, what stays yours (sending), and where to stop it.',
    diagram: true,
  },
  // 29章: the Drive card of 設定 →「Google」 with one 「もう聞かない」 folder, the relay, a put into a folder A社 can see
  // (chat-outside-cards-ui.html) and a プロジェクト's Drive files (record-card-ui.html &drive=1).
  {
    id: 'settings-google-drive',
    about: '設定 →「Google」: the Drive card (only what you chose), ［オフにする］, and 「もう聞かない」 folders with ［聞くように戻す］.',
    ...GOOGLE_SETTINGS,
    steps: [{ waitFor: 'role=button[name="聞くように戻す"]' }, { run: 'document.querySelector(\'[data-testid="drive-trusted-folders"]\').scrollIntoView({ block: "center" })' }, SETTLE],
    crop: { target: `${DRIVE_TEXT} >> xpath=..`, padding: { x: 40, y: 12 } },
    annotations: [
      { marker: { target: DRIVE_TEXT, label: '1', at: 'left' } },
      { box: 'role=button[name="オフにする"]' }, { marker: { target: 'role=button[name="オフにする"]', label: '2', at: 'right' } },
      { box: 'role=button[name="聞くように戻す"]' }, { marker: { target: 'role=button[name="聞くように戻す"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'settings-google-relay',
    about: '設定 →「Google」: 「スプレッドシートを中継で使う」 the company allows, with ［許可する］.',
    ...GOOGLE_SETTINGS,
    steps: [{ waitFor: 'text=会社が許可しています' }, { run: 'document.querySelector(\'[data-testid="google-relay"]\').scrollIntoView({ block: "center" })' }, SETTLE],
    crop: { target: '[data-testid="google-relay"]', padding: { x: 40, y: 12 } },
    annotations: [
      { marker: { target: 'text=会社が許可しています', label: '1', at: 'right' } },
      { box: '[data-testid="google-relay"] >> role=button[name="許可する"]' }, { marker: { target: '[data-testid="google-relay"] >> role=button[name="許可する"]', label: '2', at: 'right' } },
    ],
  },
  {
    id: 'drive-put-card',
    about: 'The card before the AI puts a file where people outside can see it: who sees it, 「もう聞かない」, ［置く］［やめる］.',
    page: 'chat-outside-cards',
    viewport: { width: 900, height: 900 },
    crop: { target: 'role=group[name="社外の人も見られる場所に置きます"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=/^社外の人（a-sha.example の人）も見られます/', label: '1', at: 'left' } },
      { marker: { target: 'text=/^このフォルダはもう聞かない/', label: '2', at: 'left' } },
      { box: 'role=button[name="置く"]' }, { marker: { target: 'role=button[name="置く"]', label: '3', at: 'below' } },
      { marker: { target: 'role=button[name="やめる"]', label: '4', at: 'below' } },
    ],
  },
  {
    id: 'record-drive-links',
    about: 'A プロジェクト\'s files: ［Google Drive のファイルをつなぐ］, 山田さん\'s Drive file by name, someone else\'s as 「Google Drive のファイル」.',
    page: 'record-card',
    query: { record: 'project', manual: '1', drive: '1' },
    viewport: { width: 1100, height: 1400 },
    steps: [{ waitFor: 'role=button[name=/Google Drive のファイルをつなぐ/]' }],
    crop: { region: { x: 812, y: 222, width: 288, height: 250 } },
    annotations: [
      { box: 'role=button[name=/Google Drive のファイルをつなぐ/]' }, { marker: { target: 'role=button[name=/Google Drive のファイルをつなぐ/]', label: '1', at: 'left' } },
      { marker: { target: 'text=研修の進め方（作業中）', label: '2', at: 'left' } },
      { marker: { target: 'text="Google Drive のファイル"', label: '3', at: 'left' } },
    ],
  },
  // 30章: 山田さん's mails after the meeting with A社 (mail-draft-card-ui.html ?manual=1).
  {
    id: 'mail-draft-card',
    about: 'The mail draft card: from, to with where each address came from, the whole body, ［確かめて送る］［直す］［捨てる］.',
    ...MAIL,
    crop: { target: THANKS_MAIL, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: `${THANKS_MAIL} >> role=list[name="宛先"]`, label: '1', at: 'right' } },
      { marker: { target: `${THANKS_MAIL} >> [aria-label="本文"]`, label: '2', at: 'left' } },
      { box: `${THANKS_MAIL} >> role=button[name="確かめて送る"]` }, { marker: { target: `${THANKS_MAIL} >> role=button[name="確かめて送る"]`, label: '3', at: 'below' } },
      { marker: { target: `${THANKS_MAIL} >> role=button[name="直す"]`, label: '4', at: 'below' } },
      { marker: { target: `${THANKS_MAIL} >> role=button[name="捨てる"]`, label: '5', at: 'below' } },
    ],
  },
  {
    id: 'mail-edit',
    about: 'After ［直す］: To / CC chosen from checked addresses, ［入力した宛先を足す］, the subject and body, ［保存する］.',
    ...MAIL,
    viewport: { width: 900, height: 1100 },
    steps: [{ click: `${THANKS_MAIL} >> role=button[name="直す"]` }, { waitFor: 'role=button[name="入力した宛先を足す"]' }],
    crop: { target: THANKS_MAIL, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=宛先・CC（確かめた宛先から選びます）', label: '1', at: 'left' } },
      { box: 'role=button[name="入力した宛先を足す"]' }, { marker: { target: 'role=button[name="入力した宛先を足す"]', label: '2', at: 'right' } },
      { box: 'role=button[name="保存する"]' }, { marker: { target: 'role=button[name="保存する"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'mail-confirm',
    about: 'After ［確かめて送る］: 「送る前に、もう一度確かめてください」, 「返事を待つ」, ［この内容で送る］.',
    ...MAIL,
    steps: [{ click: `${THANKS_MAIL} >> role=button[name="確かめて送る"]` }, { waitFor: 'role=button[name="この内容で送る"]' }],
    crop: { target: THANKS_MAIL, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=送る前に、もう一度確かめてください', label: '1', at: 'left' } },
      { marker: { target: 'text=/^返事を待つ（来なければ/', label: '2', at: 'left' } },
      { box: 'role=button[name="この内容で送る"]' }, { marker: { target: 'role=button[name="この内容で送る"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'mail-attachments',
    about: 'A mail with two PDFs: 「付いているファイル」, ［開いて確かめる］ and ［外す］.',
    ...MAIL,
    crop: { target: FILES_MAIL, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: `${FILES_MAIL} >> text=付いているファイル`, label: '1', at: 'left' } },
      { box: 'role=button[name="提案書（A社様）.pdfを開いて確かめる"]' }, { marker: { target: 'role=button[name="提案書（A社様）.pdfを開いて確かめる"]', label: '2' } },
      { box: 'role=button[name="提案書（A社様）.pdfを外す"]' }, { marker: { target: 'role=button[name="提案書（A社様）.pdfを外す"]', label: '3' } },
    ],
  },
  {
    id: 'mail-already-sent',
    about: 'A second thank-you for the same meeting: who sent the first and when, 「それでも送る理由」, ［それでも送る］［送らない］.',
    ...MAIL,
    steps: [
      { click: `${SECOND_MAIL} >> role=button[name="確かめて送る"]` },
      { click: `${SECOND_MAIL} >> role=button[name="この内容で送る"]` },
      { waitFor: 'role=group[name="先に送られたメール"]' },
    ],
    crop: { target: SECOND_MAIL, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=/^この会議のお礼メールは高橋さんが/', label: '1', at: 'left' } },
      { marker: { target: 'text=それでも送る理由', label: '2', at: 'left' } },
      { box: 'role=button[name="それでも送る"]' }, { marker: { target: 'role=button[name="それでも送る"]', label: '3', at: 'below' } },
      { marker: { target: 'role=button[name="送らない"]', label: '4', at: 'below' } },
    ],
  },
  {
    id: 'mail-unknown',
    about: 'A mail nobody knows arrived: 「届いたか分かりません。Gmail の送信済みを確かめてください。」, ［送られていた］［送られていなかった］.',
    ...MAIL,
    crop: { target: 'role=group[name="メール：日程のご連絡"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'role=group[name="メール：日程のご連絡"] >> text=/^届いたか分かりません。Gmail/', label: '1', at: 'left' } },
      { box: 'role=button[name="送られていた"]' }, { marker: { target: 'role=button[name="送られていた"]', label: '2', at: 'below' } },
      { marker: { target: 'role=button[name="送られていなかった"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'slack-reply-draft',
    about: 'A Slack reply draft: 「元の Slack のスレッドに、あなたとして返します。」 and the same buttons.',
    ...MAIL,
    crop: { target: 'role=group[name="Slack の返事の下書き"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=元の Slack のスレッドに、あなたとして返します。', label: '1', at: 'left' } },
      { box: 'role=group[name="Slack の返事の下書き"] >> role=button[name="確かめて送る"]' }, { marker: { target: 'role=group[name="Slack の返事の下書き"] >> role=button[name="確かめて送る"]', label: '2', at: 'below' } },
    ],
  },
  {
    id: 'mail-flow-diagram',
    about: 'Diagram: the AI drafts, you check and send from your Gmail, ACB waits for the answer; the AI never sends.',
    diagram: true,
  },
  // 31章: 法人営業's screens (plugin-slots-ui.html ?manual=1) and the customer list's writes (chat-outside-cards-ui.html).
  {
    id: 'plugin-tab',
    about: 'The left pane\'s tabs with the business screen\'s 「案件」 next to 「ファイル」.',
    ...DEAL_SCREENS,
    steps: [{ waitFor: 'role=button[name=/案件/]' }],
    crop: { region: { x: 0, y: 0, width: 300, height: 120 } },
    annotations: [{ box: 'role=button[name=/案件/]' }, { marker: { target: 'role=button[name=/案件/]', label: '1', at: 'right' } }],
  },
  {
    id: 'plugin-file-menu',
    about: 'A file\'s right-click menu with the business screen\'s item at its end.',
    ...DEAL_SCREENS,
    steps: [{ waitFor: 'role=button[name=/案件/]' }, { rightClick: 'role=button[name="提案書_A社向け.pdf"]' }, { waitFor: 'role=button[name="案件の資料にする"]' }],
    crop: { region: { x: 0, y: 0, width: 300, height: 250 } },
    annotations: [{ box: 'role=button[name="案件の資料にする"]' }, { marker: { target: 'role=button[name="案件の資料にする"]', label: '1', at: 'right' } }],
  },
  {
    id: 'deal-step-button',
    about: 'A 案件\'s card with the step button 「提案書を用意する」 above it.',
    ...DEAL_SCREENS,
    steps: [{ waitFor: 'role=region[name="手順"] >> role=button' }, { waitFor: 'text=A社 研修導入' }],
    crop: { region: { x: 160, y: 0, width: 940, height: 240 } },
    annotations: [{ box: 'role=region[name="手順"] >> role=button' }, { marker: { target: 'role=region[name="手順"] >> role=button', label: '1', at: 'right' } }],
  },
  {
    id: 'deal-continue',
    about: 'After the AI prepared the step: ［続きをする］ and 「AI が用意したもの」 with 確かめる点 and the files.',
    ...DEAL_SCREENS,
    query: { manual: '1', prepared: '1' },
    steps: [{ waitFor: 'role=button[name="続きをする"]' }, { waitFor: 'text=確かめる点' }],
    crop: { region: { x: 160, y: 0, width: 940, height: 440 } },
    annotations: [
      { box: 'role=button[name="続きをする"]' }, { marker: { target: 'role=button[name="続きをする"]', label: '1', at: 'right' } },
      { marker: { target: 'text=確かめる点', label: '2', at: 'left' } },
      { marker: { target: 'role=region[name="AI が用意したもの"] >> text=ファイル >> nth=0', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'plugin-operation-applied',
    about: 'The card after the AI updated the customer list: the field before → after, 「AI が記録」, ［変更前の値を書き戻す］.',
    page: 'chat-outside-cards',
    viewport: { width: 900, height: 900 },
    crop: { target: 'role=group[name="HubSpot を更新しました"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'role=group[name="HubSpot を更新しました"] >> role=list[name="変更した欄"]', label: '1', at: 'left' } },
      { marker: { target: 'role=group[name="HubSpot を更新しました"] >> text=AI が記録', label: '2', at: 'left' } },
      { box: 'role=button[name="変更前の値を書き戻す"]' }, { marker: { target: 'role=button[name="変更前の値を書き戻す"]', label: '3', at: 'right' } },
    ],
  },
  {
    id: 'plugin-operation-unknown',
    about: 'A write whose answer was lost: 「HubSpot に届いたか分かりません」 and ［もう一度確かめる］.',
    page: 'chat-outside-cards',
    viewport: { width: 900, height: 900 },
    crop: { target: 'role=group[name="HubSpot に届いたか分かりません"]', padding: { x: 40, y: 16 } },
    annotations: [
      { box: 'role=button[name="もう一度確かめる"]' }, { marker: { target: 'role=button[name="もう一度確かめる"]', label: '1', at: 'right' } },
    ],
  },
  // 32章: ブラウザ操作 with a made-up 配信ツール (download-folders-ui ?tab=browser&browser=1, browser-plan-card-ui ?manual=1).
  {
    id: 'settings-browser',
    about: '設定 →「ブラウザ操作」: the allowed site, ［開いてログイン］［ログインを消す］, 「AI はまだこの窓を操作しません。」.',
    page: 'download-folders',
    query: { tab: 'browser', browser: '1', manual: '1', role: 'member' },
    viewport: { width: 1100, height: 700 },
    steps: [{ waitFor: 'role=button[name="開いてログイン"]' }, SETTLE],
    crop: { target: 'role=dialog', padding: 0 },
    annotations: [
      { marker: { target: 'text=manager.example.net', label: '1', at: 'left' } },
      { box: 'role=button[name="開いてログイン"]' }, { marker: { target: 'role=button[name="開いてログイン"]', label: '2', at: 'below' } },
      { box: 'role=button[name="ログインを消す"]' }, { marker: { target: 'role=button[name="ログインを消す"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'browser-plan-card',
    about: 'The plan\'s card: what was read from the site, 「これから届く人数」, the AI\'s explanation apart, ［任せる］［やめる］.',
    page: 'browser-plan-card',
    query: { manual: '1', audience: '42' },
    viewport: { width: 900, height: 1100 },
    steps: [{ waitFor: 'role=button[name="任せる"]' }],
    crop: { target: PLAN_CARD, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=サイトから読み取った情報', label: '1', at: 'left' } },
      { marker: { target: 'text=これから届く人数', label: '2', at: 'left' } },
      { marker: { target: 'text=AI の説明（サイトから読んだ情報ではありません）', label: '3', at: 'left' } },
      { box: 'role=button[name="任せる"]' }, { marker: { target: 'role=button[name="任せる"]', label: '4', at: 'below' } },
      { marker: { target: 'role=button[name="やめる"]', label: '5', at: 'below' } },
    ],
  },
  {
    id: 'browser-plan-unread',
    about: 'A count the site did not show: 「読み取れませんでした」 in yellow, never 0.',
    page: 'browser-plan-card',
    query: { manual: '1' },
    viewport: { width: 900, height: 1100 },
    steps: [{ waitFor: '[data-audience="unknown"]' }],
    crop: { target: PLAN_CARD, padding: { x: 40, y: 16 } },
    annotations: [{ box: '[data-audience="unknown"]' }, { marker: { target: '[data-audience="unknown"]', label: '1', at: 'right' } }],
  },
  {
    id: 'browser-plan-unknown',
    about: 'A run nobody knows the result of: 「届いたか分かりません。」, where to look, ［済んでいた］［されていなかった］, no resend.',
    page: 'browser-plan-card',
    query: { manual: '1', state: 'unknown', audience: '42' },
    viewport: { width: 900, height: 1200 },
    steps: [{ waitFor: 'role=button[name="済んでいた"]' }],
    crop: { target: PLAN_CARD, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: `${PLAN_CARD} >> role=status`, label: '1', at: 'left' } },
      { box: 'role=button[name="済んでいた"]' }, { marker: { target: 'role=button[name="済んでいた"]', label: '2' } },
      { marker: { target: 'role=button[name="されていなかった"]', label: '3', at: 'right' } },
      { marker: { target: 'text=/^もう一度は送りません/', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'inbox-browser-rows',
    about: 'The inbox with the 配信ツール\'s plan waiting (［承認する…］) and one nobody knows (［確かめる…］).',
    page: 'inbox',
    query: { manual: '1', plans: '1' },
    viewport: { width: 1000, height: 800 },
    steps: [{ waitFor: 'role=button[name=/^確かめる…/]' }],
    crop: { target: 'role=region[name="受け箱"]', padding: 0 },
    annotations: [
      { box: 'role=button[name=/^承認する…/]' }, { marker: { target: 'role=button[name=/^承認する…/]', label: '1', at: 'left' } },
      { box: 'role=button[name=/^確かめる…/]' }, { marker: { target: 'role=button[name=/^確かめる…/]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'browser-flow-diagram',
    about: 'Diagram: you log in yourself, the AI makes a plan, you read and press ［任せる］, it runs once as planned.',
    diagram: true,
  },
]

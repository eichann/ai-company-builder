// The administrator guide's screenshots, declared as data (manual-admin/README.md). Each scene
// opens one page of the admin console (its production build) with the fictional company of
// world.ts answering its API calls, does a few steps, draws its annotations on top and saves
// manual-admin/images/<id>.png. `pnpm manual-admin:shoot` shoots them all again (shoot.spec.ts).
//
// Targets are Playwright selectors, preferably by role and visible name
// (`role=button[name="メンバーを招待"]`): they follow what the reader sees, so a restyle keeps them
// working, and a renamed or removed control fails the shot instead of leaving a stale picture. A
// target must match exactly one visible element.
//
// Everything shown is fictional (検証A社, 高橋さん, 佐藤さん, 田中さん, 山田さん): no real people,
// companies or private-folder names.
import {
  alerts, browserOn, busyHome, effectiveAt, events, firstMonthFeatures, firstMonthTasks, google, hubspotItem, jobList, morningDetail,
  grossProfitDetail, mappingCheckPassed, morningJob, oneStop, proposal, proposalJob, salesDetail, salesItem, sharedInbox, shelfItems, shelfRequest, withoutFolder,
} from './answers'
import { API, at, home, ok, people, setupWith, signedIn, type Routes } from './world'

export interface SceneAnnotation {
  /** A red frame around the target. */
  box?: string
  /** A numbered red marker beside the target; the guide's text refers to the number. */
  marker?: { target: string; label: string; at?: 'top-left' | 'left' | 'right' | 'below' }
  /** A short red-framed label below the target (an icon-only button's name, as its tooltip says it). */
  note?: { target: string; text: string; row?: 1 | 2 }
}

export type SceneStep =
  | { click: string }
  /** The pointer rests on the target (a tooltip). */
  | { hover: string }
  /** Types `text` into the target field, replacing what it held. */
  | { fill: string; text: string }
  /** Chooses the option whose value is `value` in a native select. */
  | { select: string; value: string }
  /** Presses a key (Playwright key name, e.g. `Escape`). */
  | { press: string }
  /** Runs a script in the page. */
  | { run: string }
  | { waitFor: string }

export interface Scene {
  /** File name in manual-admin/images (ASCII, kebab-case). */
  id: string
  /** What the picture shows (for the reader of this file). */
  about: string
  /** The console's page (`at('/members')` for 検証A社's). Absent for a diagram. */
  path?: string
  /** Signed out (the sign-in page); else signed in as 高橋さん, the owner. */
  signedOut?: true
  /** Answers added to (or replacing) world.ts's for this scene: "METHOD /api/…" → reply. */
  api?: Routes
  /**
   * A diagram instead of a screen: admin/tests/manual/diagrams/<id>.html (static HTML on the design
   * tokens, which the shoot puts in front of it), cut to its `#diagram` element. The guide's site
   * serves pictures only as PNG/JPEG/WebP (no SVG: shared/core/manual.ts).
   */
  diagram?: true
  /** CSS pixels; the shot is taken at 2x for sharp text. Default 1280x800. */
  viewport?: { width: number; height: number }
  steps?: SceneStep[]
  /** Crop to an element (plus padding in CSS pixels, default 16) or to a region instead of the whole window. */
  crop?: { target: string; /** Down to this one too (the box around both). */ to?: string; padding?: number | { x: number; y: number } } | { region: { x: number; y: number; width: number; height: number } }
  annotations?: SceneAnnotation[]
  /** Keep the focus where the steps left it. */
  keepFocus?: true
  /**
   * Only for a video (no guide page shows it): saved in manual-admin/images-plain/ (gitignored),
   * never in manual-admin/images, and without annotations (the video draws its own frames).
   */
  video?: true
}

const MENU = 'role=navigation[name="メインメニュー"]'
/** A card of the console (shadcn's Card). */
const CARD = '[data-slot="card"]'
const STOP = 'role=button[name="AI を止める"]'
/** 「フォルダ」's editor of the chosen place. */
const EDITOR = 'div.scroll-mt-16'

export const scenes: Scene[] = [
  // ── 序章 (index.md) ──────────────────────────────────────────────────────
  {
    id: 'admin-login',
    about: 'The sign-in page: e-mail address and password.',
    path: '/login',
    signedOut: true,
    viewport: { width: 900, height: 640 },
    crop: { target: CARD, padding: 24 },
    annotations: [
      { marker: { target: 'role=textbox[name="メールアドレス"]', label: '1', at: 'left' } },
      { marker: { target: '#password', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'admin-menu',
    about: 'The left menu as the owner sees it, 「詳しい設定」 at its foot, and 「AI を止める」 above every page.',
    path: at(),
    annotations: [
      { marker: { target: `${MENU} >> role=link[name="ホーム"]`, label: '1', at: 'right' } },
      { marker: { target: 'role=navigation[name="詳しい設定"]', label: '2', at: 'right' } },
      { box: STOP },
      { marker: { target: STOP, label: '3', at: 'left' } },
    ],
  },

  // ── 1節 会社を始める ─────────────────────────────────────────────────────
  {
    id: 'company-new-folder-kind',
    about: '「会社を作成」 (an operator): the two choices of 全社フォルダ and the hint that it cannot be changed later.',
    path: '/companies/new',
    api: { 'GET /api/me': ok({ ...signedIn, canCreateCompany: true }), 'GET /api/companies': ok([]) },
    viewport: { width: 900, height: 760 },
    steps: [{ fill: 'role=textbox[name="会社名"]', text: '検証A社' }],
    crop: { target: CARD, padding: 24 },
    annotations: [
      { box: 'role=radiogroup[name="全社フォルダ"]' },
      { box: '#folder-kind-hint' },
    ],
  },
  {
    id: 'home-setup',
    about: 'The home\'s 「最初にやること」 with two steps done: the done marks, the next step\'s hint, 「運用担当者に頼む」 on Google.',
    path: at(),
    api: { [`GET ${API}/home`]: ok(home({ setup: setupWith(['departments', 'members']) })) },
    crop: { target: 'section[aria-labelledby="setup-heading"]', padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'role=img[name="終わった"] >> nth=0', label: '1', at: 'left' } },
      { box: 'role=listitem >> nth=2' },
      { marker: { target: 'role=listitem >> nth=2', label: '2', at: 'left' } },
      { marker: { target: 'text=運用担当者に頼む', label: '3', at: 'right' } },
    ],
  },
  {
    id: 'company-info-rename',
    about: '「詳しい設定」 › 「会社の情報」: the company\'s name and 「名前を変更」.',
    path: at('/advanced/info'),
    crop: { target: `${CARD}:has-text("会社の情報") >> nth=0`, padding: 16 },
    annotations: [{ box: 'role=button[name="名前を変更"]' }],
  },

  // ── 2節 人を招く ─────────────────────────────────────────────────────────
  {
    id: 'members-invite',
    about: '「メンバーを招待」: the role, how long the link lasts, the departments the person will belong to.',
    path: at('/members'),
    steps: [{ click: 'role=main >> role=button[name="メンバーを招待"]' }, { click: 'role=dialog >> role=button[name="営業部"]' }],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: '#invite-role', label: '1', at: 'left' } },
      { marker: { target: '#invite-days', label: '2', at: 'right' } },
      { marker: { target: 'role=dialog >> role=button[name="営業部"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'members-list',
    about: 'The members table: 「古い」 on a member\'s app, and 「役割を変更」 in a row\'s menu.',
    path: at('/members'),
    steps: [{ click: 'role=button[name="小林 直樹 の操作"]' }],
    keepFocus: true,
    annotations: [
      { box: 'table >> text=古い' },
      { marker: { target: 'table >> text=古い', label: '1', at: 'left' } },
      { box: 'role=menuitem[name="役割を変更"]' },
      { marker: { target: 'role=menuitem[name="役割を変更"]', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'members-remove',
    about: 'Removing a member: the confirmation asks for the name and says what happens to private folders.',
    path: at('/members'),
    steps: [{ click: 'role=button[name="小林 直樹 の操作"]' }, { click: 'role=menuitem[name="会社から削除"]' }],
    crop: { target: 'role=dialog', padding: 16 },
  },

  // ── 3節 部署 ─────────────────────────────────────────────────────────────
  {
    id: 'departments-list',
    about: 'The departments: who belongs to each, its 部署の管理役, and 「部署を追加」.',
    path: at('/departments'),
    annotations: [
      { marker: { target: 'text=それぞれの部署に、だれが所属していますか？', label: '1', at: 'left' } },
      { marker: { target: 'role=list[name="部署の一覧"] >> text=小林 直樹', label: '2', at: 'left' } },
      { box: 'role=button[name="部署を追加"]' },
      { marker: { target: 'role=button[name="部署を追加"]', label: '3', at: 'below' } },
    ],
  },
  {
    id: 'department-members-dialog',
    about: '「所属する人を変える」 for 営業部: everyone listed, those who belong checked.',
    path: at('/departments'),
    steps: [{ click: 'role=button[name="所属する人を変える"] >> nth=0' }],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'company-calendar',
    about: '「会社の暦」: 「足すものはない」, and a summer holiday being added.',
    path: at('/advanced/calendar'),
    api: { [`GET ${API}/home`]: ok(home({ setup: setupWith(['departments', 'members', 'department-members', 'google']) })) },
    steps: [{ fill: '#holiday-date', text: '2027-08-13' }, { fill: '#holiday-name', text: '夏休み' }],
    annotations: [
      { box: 'role=button[name="足すものはない"]' },
      { marker: { target: 'role=button[name="足すものはない"]', label: '1', at: 'left' } },
      { box: 'role=button[name="休みに足す"]' },
      { marker: { target: 'role=button[name="休みに足す"]', label: '2', at: 'left' } },
    ],
  },

  // ── 4節 不在と代わりの人 ─────────────────────────────────────────────────
  {
    id: 'absence-dialog',
    about: '「山田 太郎さんの不在と代わりの人」 opened from 「部署」: one absence now, a next one being entered.',
    path: at('/departments'),
    api: {
      [`GET ${API}/absences?userId=${people.yamada.userId}`]: ok({
        userId: people.yamada.userId, canEdit: true, covering: [], today: '2026-11-20',
        absences: [{ id: 'ab_1', userId: people.yamada.userId, from: '2026-11-20', until: '2026-11-21', delegateId: people.kobayashi.userId, delegateName: people.kobayashi.name, active: true, setBy: people.yamada.userId, setAt: '2026-11-18T09:00:00.000Z' }],
      }),
    },
    steps: [
      { click: 'role=button[name="山田 太郎さんの不在・代わりの人"]' },
      { waitFor: 'role=list[name="不在の予定"]' },
      { fill: '#absence-from', text: '2026-12-28' },
      { fill: '#absence-until', text: '2027-01-05' },
      { select: '#absence-delegate', value: people.kobayashi.userId },
    ],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: '#absence-from', label: '1', at: 'left' } },
      { marker: { target: '#absence-delegate', label: '2', at: 'left' } },
      { marker: { target: 'role=dialog >> text=休みのあいだ', label: '3', at: 'left' } },
    ],
  },

  // ── 5節 フォルダ・非公開フォルダ ─────────────────────────────────────────
  {
    id: 'folders-who-edits',
    about: '「フォルダ」 › 「だれが変えられるか」 on 営業部: 上の階層と同じ / 全員 / 指定した人だけ, and the preview below.',
    path: at('/folders'),
    viewport: { width: 1280, height: 2200 },
    api: { [`GET ${API}/permissions/effective?path=営業部`]: ok(effectiveAt('営業部')) },
    steps: [{ click: '[data-tree-row][data-path="営業部"]' }, { waitFor: 'text=プレビュー：この場所で誰が何をできるか' }],
    crop: { target: EDITOR, padding: 16 },
    annotations: [
      { marker: { target: `${EDITOR} >> text=/^上の階層と同じ$/`, label: '1', at: 'left' } },
      { marker: { target: `${EDITOR} >> text=/^全員$/`, label: '2', at: 'left' } },
      { marker: { target: `${EDITOR} >> text=/^指定した人だけ$/`, label: '3', at: 'left' } },
      { marker: { target: 'text=プレビュー：この場所で誰が何をできるか', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'private-folder-create',
    about: '「非公開フォルダを作成」 in 総務部: 見られる人, 編集できる人, and that owners and admins always see it.',
    path: at('/folders'),
    viewport: { width: 1280, height: 1000 },
    api: { [`GET ${API}/permissions/folders?path=総務部`]: ok({ path: '総務部', folders: [] }) },
    steps: [
      { click: 'role=button[name="非公開フォルダを作成"]' },
      { click: 'role=list[name="中のフォルダ"] >> role=button[name="総務部"]' },
      { fill: 'role=dialog >> role=textbox[name="名前"]', text: '人事評価' },
    ],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: 'role=dialog >> text=/^見られる人$/', label: '1', at: 'left' } },
      { marker: { target: 'role=dialog >> text=/^編集できる人$/', label: '2', at: 'left' } },
      { box: 'role=dialog >> text=/オーナー・管理者（\\d+人）は常に見られます/' },
      { marker: { target: 'role=dialog >> text=/オーナー・管理者（\\d+人）は常に見られます/', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'private-folder-remove-viewer',
    about: '「見られる人を変更」 of 総務部/人事評価 with someone taken off: the warning that the folder leaves their PC.',
    path: at('/folders?tab=private'),
    viewport: { width: 1280, height: 1000 },
    steps: [
      { click: 'role=list[name="非公開フォルダ"] >> role=button[name="見られる人"]' },
      { click: 'role=button[name="中村 愛を外す"]' },
    ],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [{ box: 'role=dialog >> text=/の手元からは、次の同期で/' }],
  },
  {
    id: 'groups-page',
    about: '「見える人のまとまり」 with two groups.',
    path: at('/groups'),
    api: {
      [`GET ${API}/groups`]: ok({
        groups: [
          { id: 'g_board', name: '経営会議', memberIds: [people.kobayashi.userId, people.nakamura.userId, people.yamada.userId], usedIn: [], createdAt: '2026-11-06T01:00:00.000Z' },
          { id: 'g_hiring', name: '採用チーム', memberIds: [people.nakamura.userId], usedIn: [], createdAt: '2026-11-07T01:00:00.000Z' },
        ],
      }),
    },
    annotations: [
      { box: 'role=button[name="まとまりを作る"]' },
    ],
  },

  // ── 7節 Skill ─────────────────────────────────────────────────────────────
  {
    id: 'skill-editors',
    about: '「フォルダ」 › 「Skill を直せる人」: the whole company and each department, 「選ぶ」, and 全員が直せるようにする.',
    path: at('/folders'),
    viewport: { width: 1280, height: 1400 },
    crop: { target: `${CARD}:has(h2:text-is("Skill を直せる人"))`, padding: 16 },
    annotations: [
      { box: 'role=checkbox[name=/全員が直せるようにする/]' },
      { box: 'role=button[name="会社全体の Skill を直せる人を選ぶ"]' },
    ],
  },
  {
    id: 'skill-shelf',
    about: '「会社の Skill」 of a company without the shared folder: a request to publish, and the shelf with 「これまでの版」.',
    path: at('/skills'),
    api: {
      ...withoutFolder,
      [`GET ${API}/skill-shelf-requests`]: ok({ requests: [shelfRequest] }),
      [`GET ${API}/skill-shelf`]: ok({ items: shelfItems }),
    },
    viewport: { width: 1280, height: 900 },
    annotations: [
      { marker: { target: 'role=button[name="これまでの版"] >> nth=0', label: '1', at: 'left' } },
      { box: 'role=list[name="公開のお願い"] >> role=button[name="公開する"]' },
      { marker: { target: 'role=list[name="公開のお願い"] >> role=button[name="公開する"]', label: '2', at: 'below' } },
      { box: 'role=list[name="公開のお願い"] >> role=button[name="見送る"]' },
    ],
  },

  // ── 8節 仕事の進め方 ─────────────────────────────────────────────────────
  {
    id: 'advanced-index',
    about: '「詳しい設定」: its six headings, with 「変えています」 where 検証A社 changed something.',
    path: at('/advanced'),
    api: { [`GET ${API}/features`]: ok(firstMonthFeatures), [`GET ${API}/task-settings`]: ok(firstMonthTasks) },
    annotations: [
      { box: 'role=main >> text="変えています" >> nth=0' },
      { box: 'role=main >> text="変えています" >> nth=1' },
    ],
  },
  {
    id: 'advanced-features',
    about: '「使う機能」 in 検証A社\'s first month: 会議と議事録 and プロジェクト on.',
    path: at('/advanced/features'),
    api: { [`GET ${API}/features`]: ok(firstMonthFeatures) },
    crop: { target: 'role=list[name="使う機能"]', padding: 24 },
  },
  {
    id: 'advanced-work-auto',
    about: '「仕事の進め方」: whether the AI goes on by itself, how many times a person a day, and after how many failures it stops.',
    path: at('/advanced/work'),
    api: { [`GET ${API}/task-settings`]: ok(firstMonthTasks) },
    viewport: { width: 1280, height: 2400 },
    crop: { target: `${CARD}:has-text("AI に、押さなくても仕事を進めさせますか？")`, padding: 16 },
    annotations: [
      { marker: { target: '#auto-daily', label: '1', at: 'left' } },
      { marker: { target: '#auto-failures', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'advanced-inbox',
    about: '「来た連絡の決まり」: who a message belongs to, and info@ for 総務部.',
    path: at('/advanced/inbox'),
    api: { [`GET ${API}/inbox-settings`]: ok(sharedInbox) },
    viewport: { width: 1280, height: 2200 },
    crop: { target: `${CARD}:has(#intake-domains)`, padding: 16 },
  },

  // ── 9節 Google・Slack ─────────────────────────────────────────────────────
  {
    id: 'integrations-google',
    about: '「つなぎ先」 › Google: 社内のドメイン, 会社で使うもの (メールを送る off for now) and each member\'s permission.',
    path: at('/integrations'),
    api: { [`GET ${API}/google`]: ok({ ...google, featuresOff: ['mail'] }) },
    viewport: { width: 1280, height: 3600 },
    crop: { target: '#google-domain', to: `[data-testid="google-grant-${people.kobayashi.userId}"]`, padding: { x: 48, y: 48 } },
    annotations: [
      { marker: { target: '#google-domain', label: '1', at: 'left' } },
      { marker: { target: 'h3:text-is("会社で使うもの")', label: '2', at: 'left' } },
      { marker: { target: 'h3:text-is("メンバーの許可（読むもの・送るもの）")', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'integrations-slack',
    about: '「つなぎ先」 › Slack: what to register in the Slack app, the app\'s values, 保存 and オンにする, members\' permissions.',
    path: at('/integrations'),
    viewport: { width: 1280, height: 4200 },
    crop: { target: `${CARD}:has(h3:text-is("Slack のアプリに登録するもの"))`, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'text=/^戻り先（Slack のアプリ設定/', label: '1', at: 'left' } },
      { marker: { target: 'text=/^知らせの届け先（/', label: '2', at: 'left' } },
      { marker: { target: 'role=textbox[name="ワークスペースの ID"]', label: '3', at: 'left' } },
      { marker: { target: 'role=button[name="Slack の設定を保存"]', label: '4', at: 'left' } },
    ],
  },
  {
    id: 'integrations-connected',
    about: '「つないでいるサービス」: Google Workspace on, and which service does each of ACB\'s jobs.',
    path: at('/integrations'),
    viewport: { width: 1280, height: 1600 },
    crop: { target: '[data-testid="connected-services"]', padding: 16 },
    annotations: [{ box: '[data-testid="connected-services"] >> h3:text-is("ACB がしてもらうこと")' }],
  },

  // ── 10節 鍵 ───────────────────────────────────────────────────────────────
  {
    id: 'keys-list',
    about: '「API キー」 › 会社の鍵: HubSpot\'s key, who may use it, its daily caps and today\'s use.',
    path: at('/advanced/ai-safety/keys'),
    viewport: { width: 1280, height: 1600 },
    crop: { target: `${CARD}:has-text("部署や全員に使わせる会社の API キーです。")`, padding: 16 },
    annotations: [
      { marker: { target: 'text="上限"', label: '1', at: 'left' } },
      { marker: { target: 'text="今日の利用"', label: '2', at: 'left' } },
    ],
  },
  {
    id: 'keys-register',
    about: '「会社の API キーを登録」: the daily caps (empty = no cap).',
    path: at('/advanced/ai-safety/keys'),
    viewport: { width: 1280, height: 1800 },
    steps: [
      { click: 'role=button[name="API キーを登録"]' },
      { fill: 'role=dialog >> role=textbox[name="名前"]', text: '営業の HubSpot' },
      { fill: 'role=textbox[name="1日の回数（1人あたり）"]', text: '500' },
    ],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: 'role=dialog >> legend:text-is("1日の上限（空欄 = 上限なし）")', label: '3', at: 'left' } },
      { marker: { target: 'role=dialog >> legend:text-is("どの部署の仕事で使えるか")', label: '1', at: 'left' } },
      { marker: { target: 'role=dialog >> legend:text-is("使える人")', label: '2', at: 'left' } },
    ],
  },

  // ── 11節 業務プラグイン ───────────────────────────────────────────────────
  {
    id: 'plugins-list',
    about: '「つなぎ先」: HubSpot (a connector, not on yet) and 法人営業 (a business using it): its exchange with HubSpot waits.',
    path: at('/integrations'),
    api: {
      [`GET ${API}/plugins`]: ok({ plugins: [hubspotItem, salesItem] }),
    },
    crop: { target: 'role=main >> div.space-y-4.pb-4 >> nth=0', padding: { x: 16, y: 6 } },
    annotations: [
      { box: '[data-connection-stopped]' },
      { marker: { target: '[data-connection-stopped]', label: '1', at: 'left' } },
    ],
  },
  {
    id: 'plugins-mapping',
    about: '法人営業\'s 読み替え表 in 「表で直す」: per field, 閲覧のみ / 承認してから書き戻す / 自動で書き戻す.',
    path: at('/integrations'),
    api: {
      [`GET ${API}/plugins`]: ok({ plugins: [{ ...salesItem, install: { ...salesItem.install!, problem: null } }] }),
      [`GET ${API}/plugins/corporate-sales`]: ok(salesDetail),
      [`GET ${API}/plugins/corporate-sales/roles`]: ok({ pluginId: 'corporate-sales', label: '法人営業', roles: [{ name: 'sales_lead', label: '営業の責任者', description: null, userIds: [people.kobayashi.userId] }], overrides: [], history: [] }),
      [`GET ${API}/plugins/corporate-sales/step-skills`]: ok({ steps: [] }),
    },
    viewport: { width: 1280, height: 3000 },
    steps: [{ waitFor: 'role=button[name="表で直す"]' }, { click: 'role=button[name="表で直す"]' }],
    crop: { target: 'role=table >> nth=0', padding: 24 },
    annotations: [{ marker: { target: 'role=table >> nth=0 >> text="書き戻し"', label: '1', at: 'right' } }],
  },

  // ── 12節 定期の仕事 ───────────────────────────────────────────────────────
  {
    id: 'jobs-create-pc',
    about: '「定期の仕事を作る」 with 「Skill を責任者の PC の AI で動かす」: the Skill, what to check first, what it may do, where its files go, the time limit.',
    path: at('/jobs'),
    viewport: { width: 1280, height: 2200 },
    steps: [
      { click: 'role=button[name="定期の仕事を作る"]' },
      { fill: 'role=dialog >> role=textbox[name="名前"]', text: '週報を作る' },
      { select: 'role=combobox[name="すること"]', value: 'pc' },
      { fill: 'role=textbox[name="Skill"]', text: 'weekly-report' },
      { fill: 'role=textbox[name="確かめる場所"]', text: '営業部/訪問メモ' },
      { select: 'role=combobox[name="責任者"]', value: people.yamada.userId },
      { fill: 'role=textbox[name="置き場所の場所"]', text: '営業部' },
      { fill: 'role=textbox[name="置き場所のフォルダ名"]', text: '週報' },
    ],
    crop: { target: 'role=dialog', padding: 16 },
    annotations: [
      { marker: { target: 'role=combobox[name="すること"]', label: '1', at: 'left' } },
      { marker: { target: 'role=textbox[name="Skill"]', label: '2', at: 'left' } },
      { marker: { target: 'role=combobox[name="確かめること"]', label: '3', at: 'left' } },
      { marker: { target: 'role=dialog >> text="できること"', label: '4', at: 'left' } },
      { marker: { target: 'role=textbox[name="置き場所の場所"]', label: '5', at: 'left' } },
      { marker: { target: 'role=combobox[name="1回の上限"]', label: '6', at: 'left' } },
    ],
  },
  {
    id: 'jobs-list',
    about: '「定期の仕事」: one runs on 山田さん\'s PC, one waits for the owner\'s own 受け取る, one waits for approval.',
    path: at('/jobs'),
    api: { [`GET ${API}/jobs`]: ok(jobList) },
    viewport: { width: 1280, height: 1700 },
    crop: { target: `${CARD}:has-text("週報を作る")`, padding: { x: 40, y: 16 } },
    annotations: [
      { marker: { target: 'role=main >> text="PC で動きます"', label: '1', at: 'right' } },
      { box: 'role=button[name="責任者として受け取る"]' },
      { marker: { target: 'role=button[name="責任者として受け取る"]', label: '2', at: 'left' } },
      { marker: { target: 'role=main >> text="承認を待っています"', label: '3', at: 'right' } },
    ],
  },
  {
    id: 'jobs-accept',
    about: '「責任者として受け取る」: the approved version\'s words and the one press of consent.',
    path: at('/jobs'),
    api: { [`GET ${API}/jobs`]: ok(jobList), [`GET ${API}/jobs/${morningJob.id}`]: ok(morningDetail) },
    viewport: { width: 1280, height: 1200 },
    steps: [{ click: 'role=button[name="責任者として受け取る"]' }],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'jobs-proposals',
    about: '「届いた案」: a job 山田さん proposed, with 中身を見る / 承認する / 差し戻す.',
    path: at('/jobs'),
    api: {
      [`GET ${API}/jobs`]: ok({ ...jobList, jobs: [...jobList.jobs, proposalJob] }),
      [`GET ${API}/job-proposals?state=submitted`]: ok({ proposals: [proposal] }),
    },
    crop: { target: '[aria-label="届いた案"]', padding: 16 },
  },

  // ── 13節 ブラウザ操作 ─────────────────────────────────────────────────────
  {
    id: 'browser-settings',
    about: '「ブラウザ操作」 with an example site: the company switch, the site list with its level, and the note that the AI\'s part is being prepared.',
    path: at('/advanced/ai-safety/browser'),
    api: { [`GET ${API}/agent-browser`]: ok(browserOn) },
    viewport: { width: 1280, height: 1300 },
    crop: { target: `role=main >> ${CARD} >> nth=0`, to: 'role=button[name="サイトを追加"]', padding: { x: 24, y: 24 } },
    annotations: [
      { box: 'text=/AI がサイトを操作する機能は準備中です。/' },
      { marker: { target: 'text=/AI がサイトを操作する機能は準備中です。/', label: '1', at: 'left' } },
      { marker: { target: 'role=textbox[name="サイト 1 の操作するサイト"]', label: '2', at: 'left' } },
      { marker: { target: 'text="段階"', label: '3', at: 'right' } },
      { box: 'role=button[name="サイトを追加"]' },
    ],
  },

  // ── 14節 見守る・止める ────────────────────────────────────────────────────
  {
    id: 'home-attention',
    about: 'The home\'s 「対応が必要なこと」: a security alert, a meeting\'s duplicates, a blocked sync and an old app.',
    path: at(),
    api: { [`GET ${API}/home`]: ok(busyHome(home())) },
    viewport: { width: 1280, height: 1500 },
    crop: { target: 'section[aria-labelledby="attention-heading"]', padding: 24 },
  },
  {
    id: 'stop-page',
    about: '「AI を止める」: the band on every page, what is stopped now with 解除, apps that do not follow a stop, and 「すべての鍵を止める」.',
    path: at('/advanced/ai-safety/stop'),
    api: { [`GET ${API}/agent-stops`]: ok(oneStop) },
    viewport: { width: 1280, height: 920 },
    annotations: [
      { marker: { target: 'text=/^AI を止めています（/', label: '1', at: 'left' } },
      { marker: { target: 'role=button[name="解除"]', label: '2', at: 'left' } },
      { box: 'role=button[name="すべての鍵を止める"]' },
      { marker: { target: 'role=button[name="すべての鍵を止める"]', label: '3', at: 'left' } },
    ],
  },
  {
    id: 'stop-dialog',
    about: 'The 「AI を止める」 dialog: whose AI and what to stop.',
    path: at(),
    steps: [{ click: STOP }],
    crop: { target: 'role=dialog', padding: 16 },
  },
  {
    id: 'events-log',
    about: '「AI の操作の記録」: who used which tool where, and whether it was allowed.',
    path: at('/advanced/ai-safety/events'),
    api: { [`GET ${API}/agent-events?from=2026-11-13T15:00:00.000Z&limit=50`]: ok(events) },
    viewport: { width: 1280, height: 1800 },
    crop: { target: 'section[aria-labelledby="events-heading"]', padding: 24 },
  },
  {
    id: 'sandbox-settings',
    about: '「AI の囲い」: the recommended way to start, and the company\'s mode.',
    path: at('/advanced/ai-safety/sandbox'),
    annotations: [{ box: 'text=/^おすすめの進め方/' }],
  },
  {
    id: 'alerts-page',
    about: '「気になる動き」: two alerts and whether to tell owners and admins on Slack too.',
    path: at('/alerts'),
    api: { [`GET ${API}/security-alerts`]: ok(alerts) },
  },

  // ── Video only (`video: true`: manual-admin/images-plain/, no guide page shows them) ──
  {
    id: 'video-mapping-gross-profit',
    about: 'Video: 法人営業\'s 読み替え表 with 案件・金額 read from HubSpot\'s 粗利 (gross_profit) — a mistake HubSpot\'s check does not catch.',
    video: true,
    path: at('/integrations'),
    api: {
      [`GET ${API}/plugins`]: ok({ plugins: [{ ...salesItem, install: { ...salesItem.install!, problem: null } }] }),
      [`GET ${API}/plugins/corporate-sales`]: ok(grossProfitDetail),
      [`GET ${API}/plugins/corporate-sales/roles`]: ok({ pluginId: 'corporate-sales', label: '法人営業', roles: [{ name: 'sales_lead', label: '営業の責任者', description: null, userIds: [people.kobayashi.userId] }], overrides: [], history: [] }),
      [`GET ${API}/plugins/corporate-sales/step-skills`]: ok({ steps: [] }),
      [`POST ${API}/plugins/corporate-sales/mapping/check`]: ok(mappingCheckPassed),
    },
    viewport: { width: 1280, height: 3000 },
    steps: [
      { waitFor: 'role=button[name="表で直す"]' }, { click: 'role=button[name="表で直す"]' },
      { click: 'role=button[name="HubSpot に聞いて確かめる"]' },
      { waitFor: 'text="HubSpot の項目と合っています。"' },
    ],
    crop: { target: 'role=heading[name=/^読み替え表/]', to: 'text="HubSpot の項目と合っています。"', padding: 24 },
  },

  // ── Diagrams ──────────────────────────────────────────────────────────────
  {
    id: 'who-sees-what-diagram',
    about: 'Diagram (6節): who sees a private folder and who sees records — owners and admins are not always in.',
    diagram: true,
  },
  {
    id: 'who-does-what-diagram',
    about: 'Diagram (15節): what the operator does, what the admin console does, what the FDE sets on a member\'s PC.',
    diagram: true,
  },
]

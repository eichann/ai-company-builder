// The Skill shelf as the app reads it (plugins.md "The Skill shelf in the app"): what a member of a
// company without the shared folder gets, where it lands in the working folder, and the sentences
// around it. Pure. The shelf's own rules: shared/core/skill-shelf.ts.
import { isValidFolderName } from '../../shared/core/names'
import { diskKey, isSameOrAncestorPath, pathKey } from '../../shared/core/paths'
import { isLeftoverName } from './skill-leftovers'
import { isShelfKind, isShelfVersion, isValidShelfName, shelfListing, shelfTextFileName, type ShelfKind, type ShelfRequestState } from '../../shared/core/skill-shelf'

/**
 * Where Codex's project root is (`project_root_markers`): a folder without `.git` has none, so
 * Codex started in a department folder would not read the company's `.agents/skills/` above it
 * (checked on codex-cli 0.153.4; Claude Code walks up by itself). The store writes this file; the
 * chat names it when it starts Codex.
 */
export const SHELF_ROOT_MARKER = '.agents/.acb-root'

/** The first part of the names of the store's own short-lived entries in `.claude/` and `.agents/`. */
export const SHELF_STAGING_PREFIX = '.shelf-'

/**
 * What is no part of a Skill, for comparing and for uploading alike: what running one leaves behind
 * (shared/skill-leftovers.ts, the list sync uses), a repository, and a `.env` (keys stay on this PC).
 */
export function isNotSkillContent(name: string, isFolder: boolean): boolean {
  return isLeftoverName(name, isFolder) || name === '.git' || /^\.env/i.test(name)
}

/** One delivered item the app takes: the company's, or a department's the member reads. */
export interface ShelfDelivery {
  id: string
  kind: ShelfKind
  name: string
  department: { id: string; folder: string } | null
  version: string
  /** When this version became the one handed out (absent from an older server). */
  changedAt?: string
}

/**
 * The answer of `GET /me/skill-shelf`: the whole company's items and those of every department the
 * member reads (owner decision 2026-11-08: a reader through a group or by name gets them too; the
 * server lists only places the member reads, its one read check). Undefined when the answer is not
 * one: the app then keeps what it has, and never reads it as "nothing is delivered". An entry that
 * cannot be placed safely is left out.
 */
export function readShelfDeliveries(data: unknown): ShelfDelivery[] | undefined {
  const items = (data as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return undefined
  const kept: ShelfDelivery[] = []
  for (const raw of items as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || !isShelfKind(raw.kind)) continue
    if (!isValidShelfName(raw.kind, raw.name) || !isShelfVersion(raw.version)) continue
    const place = raw.department as { id?: unknown; folder?: unknown } | null | undefined
    const changedAt = typeof raw.changedAt === 'string' && !Number.isNaN(Date.parse(raw.changedAt)) ? { changedAt: raw.changedAt } : {}
    if (place === null || place === undefined) {
      kept.push({ id: raw.id, kind: raw.kind, name: raw.name, department: null, version: raw.version, ...changedAt })
      continue
    }
    if (typeof place.id !== 'string' || typeof place.folder !== 'string') continue
    // A department's root folder, by the department folder rule: never a path.
    if (!isValidFolderName(place.folder)) continue
    kept.push({ id: raw.id, kind: raw.kind, name: raw.name, department: { id: place.id, folder: place.folder.normalize('NFC') }, version: raw.version, ...changedAt })
  }
  return kept
}

/** Where the member may publish a Skill (`MyShelfView.skillPublishing`): the whole company, and department folders (NFC). */
export interface ShelfPublishing {
  company: boolean
  departmentFolders: string[]
}

/** The answer's `skillPublishing`; anything else (an unreadable answer) is "nowhere": the button is then not offered. */
export function readShelfPublishing(data: unknown): ShelfPublishing {
  const raw = (data as { skillPublishing?: { company?: unknown; departmentFolders?: unknown } } | null | undefined)?.skillPublishing
  const folders = Array.isArray(raw?.departmentFolders) ? raw.departmentFolders : []
  return {
    company: raw?.company === true,
    departmentFolders: folders.filter((f): f is string => typeof f === 'string' && isValidFolderName(f)).map(f => f.normalize('NFC')),
  }
}

/**
 * Is 「会社に公開」 offered for the Skill folder at `rel` (working-folder relative)? Only where the
 * server said the member may publish a Skill — the company root or one of those departments. The
 * server still decides (content: auto-run parts); this only spares the member a button that
 * would always be refused.
 */
export function mayPublishShelfSkill(publishing: ShelfPublishing | undefined, rel: string): boolean {
  const place = shelfPlaceOfSkillFolder(rel)
  if (!publishing || !place) return false
  if (place.departmentFolder === null) return publishing.company
  return publishing.departmentFolders.some(folder => sameDepartmentFolder(folder, place.departmentFolder as string))
}

/**
 * Is a folder name in the working folder this department's folder? `pathKey` (NFC, A–Z folded):
 * how the server names a place and keeps department folders apart, so the button
 * (`mayPublishShelfSkill`) and the publish's department lookup (`client.departmentId`) agree.
 */
export function sameDepartmentFolder(departmentFolder: string, folder: string): boolean {
  return pathKey(departmentFolder) === pathKey(folder)
}

/**
 * Where an item lands, relative to the working folder. A Skill: where Claude Code and Codex read
 * Skills natively, at the company root or in the department's folder (the `shelfPlacePath` shape
 * of a company folder). A rule file: `.claude/rules/`. An instruction text has no file: it goes to
 * the AI with the system prompt (`shelfInstructionsPrompt`).
 */
export function shelfTargets(item: Pick<ShelfDelivery, 'kind' | 'name' | 'department'>): string[] {
  const prefix = item.department ? `${item.department.folder}/` : ''
  if (item.kind === 'skill') return [`${prefix}.claude/skills/${item.name}`, `${prefix}.agents/skills/${item.name}`]
  if (item.kind === 'rule') return [`${prefix}.claude/rules/${shelfTextFileName('rule', item.name)}`]
  return []
}

/** The version of some files: sha256 of `shelfListing` (the same on the server). */
export function shelfVersionOf(files: ReadonlyArray<{ path: string; sha256: string }>, sha256: (text: string) => string): string {
  return sha256(shelfListing(files))
}

/** The one of `managed` that `rel` (working-folder relative) is, or lies in; as a disk reads both. */
export function managedShelfPath(managed: readonly string[], rel: string): string | null {
  const key = diskKey(rel)
  return managed.find(place => isSameOrAncestorPath(diskKey(place), key)) ?? null
}

/** The place of a Skill folder (`.claude/skills/<name>`, at the root or in a department), or null for any other folder. */
export function shelfPlaceOfSkillFolder(rel: string): { departmentFolder: string | null; name: string } | null {
  const parts = rel.normalize('NFC').split('/').filter(Boolean)
  const at = parts.length - 3
  if (at !== 0 && at !== 1) return null
  if (parts[at] !== '.claude' || parts[at + 1] !== 'skills') return null
  // A department folder is a folder name (never `..`): a place read back from disk stays inside.
  if (at === 1 && !isValidFolderName(parts[0])) return null
  const name = parts[at + 2]
  if (!isValidShelfName('skill', name)) return null
  return { departmentFolder: at === 1 ? parts[0] : null, name }
}

/**
 * What the Skills panel says of a Skill: delivered by the company; the member's own beside a
 * delivered one of the same name; or a delivered one they chose to change here (「自分用に直す」).
 */
export interface SkillShelfMark {
  state: 'company' | 'clash' | 'editing'
  version: string
  /** 'editing': the company has handed out a newer version than the one the member started from (「会社の版が新しくなっています」). */
  newer?: { version: string; at: string }
}

/**
 * One of the member's requests to publish a Skill (「会社に出してほしいと頼む」), as the last
 * `GET /me/skill-shelf` said: where (department folder, null = the whole company), and its state.
 */
export interface ShelfRequestMark {
  name: string
  departmentFolder: string | null
  state: ShelfRequestState
  requestedAt: string
  decidedAt: string | null
  reason: string | null
}

const REQUEST_STATES: readonly ShelfRequestState[] = ['pending', 'published', 'declined']

/** The answer's `requests`: entries that name a place safely and have a state; anything else is left out (an older server: none). */
export function readShelfRequests(data: unknown): ShelfRequestMark[] {
  const raw = (data as { requests?: unknown } | null | undefined)?.requests
  if (!Array.isArray(raw)) return []
  const kept: ShelfRequestMark[] = []
  for (const r of raw as Array<Record<string, unknown> | null>) {
    if (!r || !isValidShelfName('skill', r.name) || !REQUEST_STATES.includes(r.state as ShelfRequestState) || typeof r.requestedAt !== 'string') continue
    const place = r.department as { folder?: unknown } | null | undefined
    if (place && (typeof place.folder !== 'string' || !isValidFolderName(place.folder))) continue
    kept.push({
      name: r.name,
      departmentFolder: place ? (place.folder as string).normalize('NFC') : null,
      state: r.state as ShelfRequestState,
      requestedAt: r.requestedAt,
      decidedAt: typeof r.decidedAt === 'string' ? r.decidedAt : null,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : null,
    })
  }
  return kept
}

/** The member's latest request for the Skill folder at `rel` (working-folder relative), if any. */
export function shelfRequestOf(requests: readonly ShelfRequestMark[] | undefined, rel: string): ShelfRequestMark | undefined {
  const place = shelfPlaceOfSkillFolder(rel)
  if (!place || !requests) return undefined
  return requests.find(r => r.name === place.name && (r.departmentFolder === null
    ? place.departmentFolder === null
    : place.departmentFolder !== null && sameDepartmentFolder(r.departmentFolder, place.departmentFolder)))
}

/** What the Skills panel knows of 「会社に出してほしいと頼む」 for one Skill: offered there, and the member's latest request. */
export interface SkillShelfRequestInfo {
  offered: boolean
  last?: ShelfRequestMark
}

/** 「会社に出してほしいと頼む」 is offered on a Skill the member may not publish at a place that takes Skills. */
export function mayRequestShelfSkill(publishing: ShelfPublishing | undefined, rel: string): boolean {
  return shelfPlaceOfSkillFolder(rel) !== null && !mayPublishShelfSkill(publishing, rel)
}

/** A version as the member sees it. */
export function shelfMarkTitle(version: string): string {
  return `会社の Skill（版 ${version.slice(0, 8)}）`
}

export const SHELF_COMPANY_NOTE = 'これは会社の Skill です。AI やこの PC で変えても、次に受け取るときに元に戻ります。'
export const SHELF_CLASH_NOTE = '会社にも同じ名前の Skill があります。あなたの Skill をそのまま使っているので、会社の Skill はこの PC に置いていません。'
export const SHELF_PUBLISH_CONFIRM = '会社の Skill として公開します。この場所を見られる全員に届きます。公開のあとは、AI やこの PC で変えても、次に受け取るときに元に戻ります。'
export const SHELF_REPLACE_CONFIRM = '会社の同じ名前の Skill を、この内容に置き換えます。この場所を見られる全員に届きます。'

/** The card of a Skill under 「自分用に直す」: its heading and the one line everyone reads. */
export const SHELF_EDITING_TITLE = '自分用に直している Skill'
export const SHELF_EDITING_NOTE = 'この PC の AI だけが、あなたの直した版を使います。ほかの人には届きません。'
/** What else holds while it lasts; only someone who may publish here is told of publishing. */
export const SHELF_EDITING_DETAIL = '会社の版が新しくなっても、「会社の版に戻す」か「会社に公開」を押すまで、この PC には届きません。'
export const SHELF_EDITING_DETAIL_LOCAL = '会社の版が新しくなっても、「会社の版に戻す」を押すまで、この PC には届きません。'
export const SHELF_EDIT_CONFIRM = 'この PC だけで、あなたが直した版を使うようにします。ほかの人の Skill は変わりません。みんなに使ってほしくなったら「会社に公開」、やめるときは「会社の版に戻す」を押します。'
export const SHELF_EDIT_CONFIRM_LOCAL = 'この PC だけで、あなたが直した版を使うようにします。ほかの人の Skill は変わりません。やめるときは「会社の版に戻す」を押します。'

/** 「自分用に直す」's confirmation and the card's second line: only someone who may publish here is told of publishing. */
export function shelfEditTexts(mayPublish: boolean): { confirm: string; detail: string } {
  return mayPublish ? { confirm: SHELF_EDIT_CONFIRM, detail: SHELF_EDITING_DETAIL } : { confirm: SHELF_EDIT_CONFIRM_LOCAL, detail: SHELF_EDITING_DETAIL_LOCAL }
}

/** 「会社の版に戻す」: the member's version is moved to `.backups/<ts>_skill_edit/` (store.ts `restoreCompany`), never deleted. */
export const SHELF_RESTORE_CONFIRM = '会社の版に戻します。あなたが直した内容は、念のため控えに残します（作業フォルダの中の「.backups」フォルダ）。会社の版は、このあとすぐに受け取ります。'
/** Restored, but the company's version was not received just now (offline, or no longer delivered). */
export const SHELF_RESTORED_LATER_NOTE = '会社の版に戻しました。会社の版は、次に受け取るときに届きます。'
/** Restored, but the company no longer delivers this Skill here: nothing will come. */
export const SHELF_RESTORED_GONE_NOTE = '会社の版に戻しました。ただ、この Skill は会社から配られなくなったため、会社の版は届きません。あなたが直した内容は「.backups」フォルダの控えに残っています。'
/** Restored, but something of the member's stands where the company's would go. */
export const SHELF_RESTORED_OCCUPIED_NOTE = '会社の版に戻しました。ただ、同じ場所に同じ名前の Skill があるため、会社の版を置けませんでした。その Skill の名前を変えるか別の場所に移すと、次に受け取るときに会社の版が届きます。'
export const SHELF_NOT_EDITING_MESSAGE = 'この Skill は自分用に直している Skill ではないため、戻せませんでした。'
export const SHELF_RESTORE_PLACE_MESSAGE = 'この Skill の場所が普通のフォルダではない（ショートカットやファイルになっている）ため、戻せませんでした。何も変更していません。'
export const SHELF_RESTORE_BACKUPS_MESSAGE = '控えを置く「.backups」が普通のフォルダではない（ショートカットやファイルになっている）ため、戻せませんでした。何も変更していません。'
export const SHELF_RESTORE_FAILED_MESSAGE = '会社の版に戻せませんでした。時間をおいて、もう一度やり直してください。'

/**
 * What `skillShelf:restoreCompany` answers: the company's version is back (`back`), comes with a
 * later fetch (`later`), is no longer delivered (`not-delivered`), or something stands in its place (`occupied`).
 */
export type SkillShelfRestoreResult = { success: true; companyVersion: 'back' | 'later' | 'not-delivered' | 'occupied' } | { success: false; error: string }

/** The sentence shown after a restore; null when the company's version is already there. */
export function shelfRestoredNote(companyVersion: 'back' | 'later' | 'not-delivered' | 'occupied'): string | null {
  return { back: null, later: SHELF_RESTORED_LATER_NOTE, 'not-delivered': SHELF_RESTORED_GONE_NOTE, occupied: SHELF_RESTORED_OCCUPIED_NOTE }[companyVersion]
}

/** 「会社に出してほしいと頼む」: what happens, said before it is sent. */
export const SHELF_REQUEST_CONFIRM = 'この Skill を、会社に公開できる人に送って、公開をお願いします。公開されるまでは、この PC だけで使われます。'
export const SHELF_REQUEST_OFFLINE_MESSAGE = 'サーバーにつながらないためお願いを送れませんでした。つながってから、もう一度やり直してください。'

/** The month, day and time of an ISO date, as the member reads it (local time). */
export function shelfDateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** What the card says of the member's request: 待っている / 公開された / 見送られた (with the reason). */
export function shelfRequestStateText(request: Pick<ShelfRequestMark, 'state' | 'requestedAt' | 'decidedAt' | 'reason'>): string {
  if (request.state === 'pending') return `公開をお願いしています（${shelfDateLabel(request.requestedAt)} に送りました）。返事を待っています。`
  const when = request.decidedAt ? `（${shelfDateLabel(request.decidedAt)}）` : ''
  if (request.state === 'published') return `お願いした Skill が公開されました${when}。`
  return `お願いは見送られました${when}。${request.reason ? `理由：${request.reason}` : ''}`
}

/** 「会社の版が新しくなっています」 on the card of a Skill the member is changing for themselves. */
export function shelfNewerText(at: string, mayPublish: boolean): string {
  const when = shelfDateLabel(at)
  const head = `会社の版が新しくなっています${when ? `（${when}）` : ''}。`
  return mayPublish
    ? `${head}「会社の版に戻す」と新しい版が届きます。「会社に公開」を押すと、新しい版をあなたの版で置き換えます。`
    : `${head}「会社の版に戻す」と新しい版が届きます。`
}

/**
 * 「AI と一緒に直す」: the new consultation's first message and title, naming the Skill by its folder
 * and pointing the AI at that folder (working-folder relative, '/'-separated on every system).
 */
export function shelfFixWithAi(rootPath: string, skillPath: string): { message: string; title: string } {
  const slashed = (p: string) => p.replace(/\\/g, '/')
  const root = slashed(rootPath).replace(/\/+$/, '')
  const folder = slashed(skillPath)
  const rel = folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder
  const name = rel.split('/').pop() ?? rel
  return {
    message: `この Skill（${name}）を直したいです。\nSkill のフォルダ：${rel}\nまず中身を読んで、どう直したいかを私に聞いてください。`,
    title: `Skill「${name}」を直す`,
  }
}

/** 「控えを開く」: no copy of this Skill is kept in `.backups` (or it is not a plain folder). */
export const SHELF_NO_BACKUP_MESSAGE = 'この Skill の控えは見つかりませんでした。'
export const SHELF_BACKUP_OPEN_FAILED_MESSAGE = '控えのフォルダを開けませんでした。'

export const SHELF_NOT_HERE_MESSAGE = 'この会社では、Skill を会社に公開できません。'
export const SHELF_OFFLINE_MESSAGE = 'サーバーにつながらないため公開できませんでした。つながってから、もう一度やり直してください。'
export const SHELF_NOT_A_PLACE_MESSAGE = '公開できるのは、作業フォルダの直下か部署のフォルダの直下にある Skill だけです。'
export const SHELF_ALREADY_COMPANY_MESSAGE = 'これは会社から届いた Skill です。直すときは「自分用に直す」を押してください。'
export const SHELF_NOT_READABLE_MESSAGE = 'Skill のフォルダを読めませんでした。中にショートカット（リンク）があるときは、取り除いてからやり直してください。'
export const SHELF_NO_PLACE_MESSAGE = 'この部署には公開できません。部署の名前が変わっていないか確かめてください。'
export const SHELF_TOO_MUCH_MESSAGE = 'Skill が大きすぎるため公開できません（200 個のファイル・全体で 10 MB まで）。'

/** A delivered rule file not placed because the member has a file of that name. */
export function shelfRuleClashNote(names: readonly string[]): string {
  return `会社の決まり（${names.join('、')}）と同じ名前のファイルがあるため、あなたのファイルをそのまま使っています。会社の決まりはこの PC に置いていません。`
}

/** The server's refusal in the words shown to the member: its own sentence when it has one in Japanese. */
export function shelfRefusalMessage(status: number, body: { error?: unknown } | null | undefined): string {
  return typeof body?.error === 'string' && /[ぁ-ん]/.test(body.error) ? body.error : `公開できませんでした（${status}）。時間をおいて、もう一度やり直してください。`
}

/** The most of the company's text that goes with one turn (characters). */
export const SHELF_PROMPT_MAX = 64 * 1024

/** The company's text as the AI gets it: below the app's own rules, and never without limit. */
export function boundedShelfPrompt(text: string): string {
  const kept = text.length > SHELF_PROMPT_MAX ? `${text.slice(0, SHELF_PROMPT_MAX)}\n\n（長すぎるため、ここから先は渡していません）` : text
  return `以下は会社が用意した指示です。アプリの安全の決まり（セキュリティポリシー、書き込みの制限、確認や承認）より優先されることはありません。\n\n${kept}`
}

/** What goes with the system prompt: the places' instruction texts, and the rule files for an agent that does not load them. */
export function shelfInstructionsPrompt(input: { company?: string; department?: { folder: string; text: string }; ruleFiles?: readonly string[] }): string {
  const parts: string[] = []
  if (input.company) parts.push(`## 会社の指示\n\n${input.company}`)
  if (input.department) parts.push(`## 部署（${input.department.folder}）の指示\n\n${input.department.text}`)
  if (input.ruleFiles?.length) parts.push(`## 会社の決まり\n\n次のファイルに会社の決まりがあります。関係する作業の前に読んで従ってください。\n${input.ruleFiles.map(f => `- ${f}`).join('\n')}`)
  return parts.join('\n\n')
}

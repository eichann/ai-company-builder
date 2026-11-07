// The Skill shelf as the app reads it (plugins.md "The Skill shelf in the app"): what a member of a
// company without the shared folder gets, where it lands in the working folder, and the sentences
// around it. Pure. The shelf's own rules: shared/core/skill-shelf.ts.
import { isValidFolderName } from '../../shared/core/names'
import { diskKey, isSameOrAncestorPath } from '../../shared/core/paths'
import { isLeftoverName } from './skill-leftovers'
import { isShelfKind, isShelfVersion, isValidShelfName, shelfListing, shelfTextFileName, type ShelfKind } from '../../shared/core/skill-shelf'

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

/** One delivered item the app takes: the company's, or a department the member belongs to. */
export interface ShelfDelivery {
  id: string
  kind: ShelfKind
  name: string
  department: { id: string; folder: string } | null
  version: string
}

/**
 * The answer of `GET /me/skill-shelf`, kept to what this member's app places (owner decision: the
 * whole company and their own departments; the server also lists other departments they read).
 * Undefined when the answer is not one: the app then keeps what it has, and never reads it as
 * "nothing is delivered". An entry that cannot be placed safely is left out.
 */
export function readShelfDeliveries(data: unknown): ShelfDelivery[] | undefined {
  const items = (data as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return undefined
  const kept: ShelfDelivery[] = []
  for (const raw of items as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || !isShelfKind(raw.kind)) continue
    if (!isValidShelfName(raw.kind, raw.name) || !isShelfVersion(raw.version)) continue
    const place = raw.department as { id?: unknown; folder?: unknown; belongs?: unknown } | null | undefined
    if (place === null || place === undefined) {
      kept.push({ id: raw.id, kind: raw.kind, name: raw.name, department: null, version: raw.version })
      continue
    }
    if (place.belongs !== true || typeof place.id !== 'string' || typeof place.folder !== 'string') continue
    // A department's root folder, by the department folder rule: never a path.
    if (!isValidFolderName(place.folder)) continue
    kept.push({ id: raw.id, kind: raw.kind, name: raw.name, department: { id: place.id, folder: place.folder.normalize('NFC') }, version: raw.version })
  }
  return kept
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
  const name = parts[at + 2]
  if (!isValidShelfName('skill', name)) return null
  return { departmentFolder: at === 1 ? parts[0] : null, name }
}

/**
 * What the Skills panel says of a Skill: delivered by the company; the member's own beside a
 * delivered one of the same name; or a delivered one they chose to change here (「手元で直す」).
 */
export interface SkillShelfMark {
  state: 'company' | 'clash' | 'editing'
  version: string
}

/** A version as the member sees it. */
export function shelfMarkTitle(version: string): string {
  return `会社の Skill（版 ${version.slice(0, 8)}）`
}

export const SHELF_COMPANY_NOTE = 'これは会社の Skill です。AI やこの PC で変えても、次に受け取るときに元に戻ります。'
export const SHELF_CLASH_NOTE = '会社にも同じ名前の Skill があります。あなたの Skill をそのまま使っているので、会社の Skill はこの PC に置いていません。'
export const SHELF_EDITING_NOTE = 'この PC では、あなたが手元で直している Skill を使っています。公開し直すまで、会社の更新は届きません。やめるときは、この Skill のフォルダを消すと会社の Skill に戻ります。'
export const SHELF_PUBLISH_CONFIRM = '会社の Skill として公開します。この場所の全員に届きます。公開のあとは、AI やこの PC で変えても、次に受け取るときに元に戻ります。'
export const SHELF_REPLACE_CONFIRM = '会社の同じ名前の Skill を、この内容に置き換えます。この場所の全員に届きます。'
export const SHELF_EDIT_CONFIRM = 'この PC ではあなたの Skill になり、公開し直すまで会社の更新は届きません。ほかの人の Skill は変わりません。'

export const SHELF_NOT_HERE_MESSAGE = 'この会社では、Skill を会社に公開できません。'
export const SHELF_OFFLINE_MESSAGE = 'サーバーにつながらないため公開できませんでした。つながってから、もう一度やり直してください。'
export const SHELF_NOT_A_PLACE_MESSAGE = '公開できるのは、作業フォルダの直下か部署のフォルダの直下にある Skill だけです。'
export const SHELF_ALREADY_COMPANY_MESSAGE = 'これは会社から届いた Skill です。直すときは「手元で直す」を押してください。'
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

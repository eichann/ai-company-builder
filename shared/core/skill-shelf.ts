/**
 * The server's Skill shelf (「会社の Skill」, `.claude/rules/plugins.md` "The Skill shelf"): how a
 * company WITHOUT the shared company folder shares its Skills, its AI instruction text
 * (CLAUDE.md / AGENTS.md) and its rule files (`.claude/rules/*.md`). The server stores and checks;
 * members' apps fetch them (next step) and keep them as plain files.
 *
 * The checks are the push checker's, not a copy: an item is judged at the company path it would
 * have in a company folder (`shelfPlacePath`: `<department>/.claude/skills/<name>/<file>`,
 * `<department>/CLAUDE.md`, `<department>/.claude/rules/<name>.md`, no department prefix for the
 * whole company) with the same rule functions the push checker and the app's guards use —
 * `isAgentConfig` (owner/admin only), `mayChangeInstructionFile`, `mayChangeSkillFile`
 * (「Skill を直せる人」, department managers) and `autorunFindingsInText` (the auto-run parts:
 * owner/admin only). See `shelfChangeProblems`.
 *
 * The version of an item is the sha256 of `shelfListing` (one line per file: its own sha256 and
 * path, sorted): the same content always has the same version, on the server and in the app, so
 * it can pin a Skill the way a git tree id does today.
 *
 * Pure: imports only sibling core modules.
 */
import { isAgentConfig } from './agent-config'
import { isInstructionFile, mayChangeInstructionFile } from './instruction-files'
import { isValidSkillName, utf8ByteLength } from './names'
import { FULL_ACCESS_ROLES } from './permissions'
import { diskKey, lookalikeKey } from './paths'
import { autorunFindingsInText } from './skill-autorun'
import { isSkillFile, mayChangeSkillFile, type SkillEditing } from './skill-files'

/** What the shelf holds: a Skill folder, the AI instruction text of a place, or one rule file. */
export type ShelfKind = 'skill' | 'instructions' | 'rule'
export const SHELF_KINDS: readonly ShelfKind[] = ['skill', 'instructions', 'rule']

/** The one name of a place's instruction text (there is one per place). */
export const INSTRUCTIONS_NAME = 'instructions'
/** The file the instruction text is, in a company folder (Codex reads the same text as AGENTS.md). */
export const INSTRUCTIONS_FILE = 'CLAUDE.md'

/** Size limits (bytes are the decoded file contents). */
export const SHELF_LIMITS = {
  /** Files in one Skill folder. */
  files: 200,
  /** One file of a Skill. */
  fileBytes: 2 * 1024 * 1024,
  /** All files of one Skill version together. */
  skillBytes: 10 * 1024 * 1024,
  /** An instruction text or a rule file. */
  textBytes: 256 * 1024,
  /** A file's path inside its Skill folder (UTF-16 code units). */
  pathLength: 300,
  /** Folders deep inside a Skill folder. */
  depth: 10,
  /** Name of a Skill or rule file. */
  nameLength: 64,
  /** Every version of every item of one company together. */
  companyBytes: 500 * 1024 * 1024,
} as const

export function isShelfKind(value: unknown): value is ShelfKind {
  return typeof value === 'string' && (SHELF_KINDS as readonly string[]).includes(value)
}

/** A Skill's or a rule file's name: the skill folder rule (`names.ts`), at most 64 characters; the instruction text has its one name. */
export function isValidShelfName(kind: ShelfKind, name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (kind === 'instructions') return name === INSTRUCTIONS_NAME
  return name.length <= SHELF_LIMITS.nameLength && isValidSkillName(name)
}

// eslint-disable-next-line no-control-regex -- control characters are refused
const BAD_CHARS_RE = /[<>:"\\|?*\u0000-\u001f\u007f]/
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?$/i

/**
 * Is `path` a file path the shelf keeps inside a Skill folder? Relative, '/'-separated, NFC, no
 * empty / '.' / '..' segment (nothing can leave the folder), no character a Mac or Windows disk
 * refuses or folds away, no segment ending in a dot or space, no reserved device name, at most
 * `depth` folders deep and `pathLength` long, each name ≤ 255 bytes. Returns the reason or null.
 */
export function shelfFilePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'empty'
  if (path.length > SHELF_LIMITS.pathLength) return 'too-long'
  if (path !== path.normalize('NFC')) return 'not-nfc'
  if (path.startsWith('/') || BAD_CHARS_RE.test(path)) return 'bad-character'
  const segments = path.split('/')
  if (segments.length > SHELF_LIMITS.depth + 1) return 'too-deep'
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return 'traversal'
    if (/[. ]$/.test(s) || RESERVED_RE.test(s)) return 'bad-name'
    if (utf8ByteLength(s) > 255) return 'too-long'
  }
  return null
}

/**
 * Two paths a disk would make one file (`diskKey`, what APFS folds: `a.md` / `A.md`), or one
 * path that is also a folder of another (`x` and `x/y`): the first such path, or null.
 */
export function shelfPathClash(paths: readonly string[]): string | null {
  const files = new Set<string>()
  const folders = new Set<string>()
  for (const p of paths) {
    const key = diskKey(p)
    if (files.has(key) || folders.has(key)) return p
    files.add(key)
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  for (const f of files) if (folders.has(f)) return f
  return null
}

/**
 * Outputs never go into a Skill (owner decision 2026-11-10): a Skill holds its procedure
 * (`SKILL.md`), tools (`scripts/`), reference material (`references/`) and templates
 * (`templates/`); what it produced (a proposal, a report, one run's CSV) belongs in a work folder or
 * a Drive folder, and SKILL.md says where. A Skill is handed out to everyone who reads its place, so
 * an output inside it reaches people it was never meant for. AIs tend to make `output/` there.
 *
 * The folder names directly under a Skill that look like outputs. A flag the person is asked about
 * when publishing or asking for a publish, not a security boundary: kept small. Names a Skill's
 * own tools often use (`out`, `dist`, `generated`, `export`) are left out on purpose.
 */
export const OUTPUT_FOLDER_NAMES: readonly string[] = ['output', 'outputs', 'result', 'results', '成果物', '出力']
/** Deliverable files at the top of a Skill (deeper — `references/`, `templates/` — they are material). */
export const OUTPUT_FILE_EXTENSIONS: readonly string[] = ['.pdf', '.docx', '.xlsx', '.pptx']

const OUTPUT_FOLDER_KEYS = new Set(OUTPUT_FOLDER_NAMES.map(lookalikeKey))

/**
 * The paths (inside a Skill folder, as uploaded) that look like outputs: everything under a folder
 * directly in the Skill named like one (`OUTPUT_FOLDER_NAMES`, compared as `lookalikeKey`: `Output`,
 * `ＯＵＴＰＵＴ`), and a deliverable file (`OUTPUT_FILE_EXTENSIONS`) at the Skill's top. A folder of
 * that name deeper inside (`scripts/output/`) is the tool's own and is not flagged. In the given order.
 */
export function outputLikePaths(paths: readonly string[]): string[] {
  return paths.filter(p => {
    const segments = p.split('/')
    if (segments.length > 1) return OUTPUT_FOLDER_KEYS.has(lookalikeKey(segments[0]))
    const key = lookalikeKey(p)
    return OUTPUT_FILE_EXTENSIONS.some(ext => key.length > ext.length && key.endsWith(ext))
  })
}

/** The file an instruction text or a rule file is stored as (a Skill keeps its own paths). */
export function shelfTextFileName(kind: Exclude<ShelfKind, 'skill'>, name: string): string {
  return kind === 'instructions' ? INSTRUCTIONS_FILE : `${name}.md`
}

/**
 * The company path a shelf file would have in a company folder: what every rule below judges.
 * `departmentFolder` null = the whole company.
 */
export function shelfPlacePath(kind: ShelfKind, departmentFolder: string | null, name: string, file: string): string {
  const prefix = departmentFolder ? `${departmentFolder.normalize('NFC')}/` : ''
  if (kind === 'skill') return `${prefix}.claude/skills/${name}/${file}`
  if (kind === 'rule') return `${prefix}.claude/rules/${file}`
  return `${prefix}${file}`
}

/** Who is changing the shelf: the same three facts the push snapshot carries. */
export interface ShelfAuthority {
  role: string
  /** Department folders (NFC) the member manages. */
  managedFolders: readonly string[]
  /** The member's place on 「Skill を直せる人」. */
  skillEditing: SkillEditing
}

export type ShelfProblemReason =
  /** Agent config (`isAgentConfig`): owner/admin only. */
  | 'owner-admin-only'
  /** An instruction or skill file this member may not change here. */
  | 'not-allowed'
  /** A Skill Markdown file with auto-run parts: owner/admin only. */
  | 'autorun'

export interface ShelfProblem {
  /** The file's path as uploaded (inside the Skill folder, or the text's file name). */
  path: string
  reason: ShelfProblemReason
  /** For 'autorun': what was found (the push checker's words). */
  findings?: string[]
}

/**
 * Why this member may not publish these files (empty = they may). `files[].text` is the UTF-8
 * text of a `.md` file (others need none); `autorun: false` skips the auto-run check (taking
 * something off the shelf, where git checks only who may change the path).
 *
 * Exactly the push checker's file rules, asked of the place path: owner/admin pass everything;
 * agent config is theirs alone; an instruction file needs `mayChangeInstructionFile` (a
 * department's own managers inside it); a skill file needs `mayChangeSkillFile` (managers,
 * 「Skill を直せる人」); a Skill's Markdown with auto-run parts is owner/admin only. The write
 * check of the place (`resolveAccess(...).write`) is the server's, beside this.
 */
export function shelfChangeProblems(
  authority: ShelfAuthority,
  kind: ShelfKind,
  departmentFolder: string | null,
  name: string,
  files: ReadonlyArray<{ path: string; text?: string }>,
  options: { autorun: boolean } = { autorun: true },
): ShelfProblem[] {
  if (FULL_ACCESS_ROLES.has(authority.role)) return []
  const problems: ShelfProblem[] = []
  for (const f of files) {
    const place = shelfPlacePath(kind, departmentFolder, name, f.path)
    if (isAgentConfig(place)) { problems.push({ path: f.path, reason: 'owner-admin-only' }); continue }
    if (isInstructionFile(place) && !mayChangeInstructionFile(authority, place)) { problems.push({ path: f.path, reason: 'not-allowed' }); continue }
    if (isSkillFile(place) && !mayChangeSkillFile(authority, place)) { problems.push({ path: f.path, reason: 'not-allowed' }); continue }
    if (options.autorun && isSkillFile(place) && /\.md$/.test(lookalikeKey(place))) {
      const findings = autorunFindingsInText(f.text ?? '')
      if (findings.length > 0) problems.push({ path: f.path, reason: 'autorun', findings })
    }
  }
  return problems
}

/** Is this a file whose text the auto-run check reads (`shelfChangeProblems`)? */
export function shelfFileNeedsText(path: string): boolean {
  return /\.md$/.test(lookalikeKey(path))
}

/**
 * The canonical listing an item's version is the sha256 of: one line per file,
 * `<sha256 hex of its bytes> <path>\n`, sorted by path (UTF-16 code units). The app computes the
 * same to check what it received.
 */
export function shelfListing(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(f => `${f.sha256} ${f.path}\n`)
    .join('')
}

/** A version id: 64 lower-case hex characters (sha256 of `shelfListing`). */
export function isShelfVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * 「会社に出してほしいと頼む」 (owner decision 2026-11-09): someone who may not publish a Skill at
 * a place sends it to those who may. Limits so the table cannot be filled: pending requests per
 * member and per company, and the bytes of every pending request of a company together (a decided
 * request keeps no files).
 */
export const SHELF_REQUEST_LIMITS = {
  /** Pending requests one member may have in one company. */
  pendingPerMember: 5,
  /** Pending requests of one company together. */
  pendingPerCompany: 50,
  /** Bytes of every pending request of one company together. */
  pendingCompanyBytes: 100 * 1024 * 1024,
  /** The publisher's reason for 見送る (characters). */
  reasonLength: 200,
  /** Decided requests a list answer shows (newest first; pending ones are always shown). */
  decidedShown: 50,
} as const

export type ShelfRequestState = 'pending' | 'published' | 'declined'

/**
 * What no request may carry, whoever would publish it: the parts only an owner/admin may put on
 * the shelf (agent config, auto-run parts), so a request is refused early with the reasons
 * publishing gives. Judged as if someone allowed to change every skill file sent it, so
 * 'not-allowed' never appears.
 */
export function shelfRequestProblems(
  kind: ShelfKind,
  departmentFolder: string | null,
  name: string,
  files: ReadonlyArray<{ path: string; text?: string }>,
): ShelfProblem[] {
  const skillEditor: ShelfAuthority = { role: 'member', managedFolders: [], skillEditing: { everywhere: true, folders: [] } }
  return shelfChangeProblems(skillEditor, kind, departmentFolder, name, files, { autorun: true })
}

/**
 * 今日のフォルダ (owner decision 2026-11-03, the Obsidian daily-note idea): one folder per day inside
 * a department's `.personal/` — on the member's Mac only, never synced (push check
 * `[PERSONAL_PATH]`). `<department>/.personal/inbox/日付別/YYYY/YYYYMMDD/`, the date being the
 * company's day (the same "today" as the task list: Japan time until a company setting exists).
 * Which department holds it is the member's choice on this PC (設定 → 自分の設定), else the first
 * department they belong to (所属) that is downloaded here. Pure: the renderer, main and tests use it.
 */
import { dayWindow, DEFAULT_COMPANY_TIME_ZONE } from '../../shared/core/calendar'

/** Under the department: where the days are. */
export const TODAY_FOLDER_BASE = '.personal/inbox/日付別'

/** `<department>/.personal/inbox/日付別/2026/20261103` for the company's day at `nowMs`. */
export function todayFolderPath(departmentFolder: string, nowMs: number, timeZone = DEFAULT_COMPANY_TIME_ZONE): string {
  const [y, m, d] = dayWindow(nowMs, timeZone).date.split('-')
  return `${departmentFolder}/${TODAY_FOLDER_BASE}/${y}/${y}${m}${d}`
}

/** A company path inside a `.personal/` folder at any depth (one copy, in the core). */
export { isPersonalPath } from '../../shared/core/records'

/**
 * A today folder as the app builds it (`todayFolderPath`): what main accepts from the screen for
 * the AI's instructions — nothing else, so a request body cannot point the AI anywhere.
 */
export function isTodayFolderPath(companyPath: unknown): companyPath is string {
  if (typeof companyPath !== 'string' || companyPath.length > 300) return false
  const m = /^([^/\\]+)\/\.personal\/inbox\/日付別\/(\d{4})\/(\d{8})$/.exec(companyPath)
  return !!m && m[1] !== '.' && m[1] !== '..' && !m[1].startsWith('.') && m[3].startsWith(m[2])
}

export interface TodayDepartment { id: string; folder: string; name: string }

export interface TodayFolderChoice<D extends TodayDepartment> {
  /** The department that holds it; null = none downloaded here. */
  department: D | null
  /** The member chose it (else the default). */
  chosen: boolean
  /** The member chose one that is not on this computer now: the default is used meanwhile. */
  chosenMissing: D | null
}

/**
 * Which department holds today's folder: the member's choice when it is downloaded here, else the
 * first department they belong to (所属, in the tabs' order) that is, else the first downloaded one.
 * `myDepartmentIds` null = not known (offline): the first downloaded department.
 */
export function todayFolderDepartment<D extends TodayDepartment>(input: {
  departments: readonly D[]
  chosenId: string | null
  myDepartmentIds: readonly string[] | null
  isDownloaded: (folder: string) => boolean
}): TodayFolderChoice<D> {
  const here = input.departments.filter(d => d.folder && input.isDownloaded(d.folder))
  const chosenDept = input.chosenId ? input.departments.find(d => d.id === input.chosenId) ?? null : null
  if (chosenDept && here.includes(chosenDept)) return { department: chosenDept, chosen: true, chosenMissing: null }
  const mine = new Set(input.myDepartmentIds ?? [])
  const department = here.find(d => mine.has(d.id)) ?? here[0] ?? null
  return { department, chosen: false, chosenMissing: chosenDept }
}

/**
 * Today's folder on disk, created when missing (`mkdir -p`; main refuses a folder that is not
 * downloaded). Answers its absolute path, or null when it could not be made.
 */
export async function ensureTodayFolder(
  rootPath: string,
  folder: string,
  fs: { exists: (absPath: string) => Promise<boolean>; createDirectory: (absPath: string) => Promise<boolean> },
): Promise<string | null> {
  const abs = `${rootPath}/${folder}`
  try {
    if (await fs.exists(abs)) return abs
    return await fs.createDirectory(abs) ? abs : null
  } catch {
    return null
  }
}

/** A file name suggested from a task's title (the member edits it): characters a name cannot hold dropped, `.md` added. */
export function fileNameFromTitle(title: string): string {
  const printable = [...title.normalize('NFC')].map(c => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  const base = printable.replace(/[/\\<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80).trim()
  return `${base || 'メモ'}.md`
}

/**
 * A linked file inside a `.personal/` folder, on a link row (owner decision 2026-11-03). Only the
 * member who linked it ever gets the row (the server leaves it out for everyone else), so
 * `elsewhere` is that member on another Mac of theirs.
 */
export const PERSONAL_FILE_WORDS = {
  here: 'あなたの Mac だけにあるファイル',
  elsewhere: 'ほかの Mac で作ったファイルです（この Mac にはありません）',
} as const

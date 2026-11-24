// A set watch's run on this PC (schema 5, 4b-4 PR5; owner memo 「4b-4 商談から提案書」 第6版 §4-4 / 付録 B2, jobs.md "The set
// watch" "The app runs it"): main's file work, no Electron (the places come from main.ts):
//   - the pinned copy: both pinned Skills read from their git trees (never the working tree) into this run's own folder in
//     the app's data, read-only — what the AI reads, whatever sync or a hand edit does meanwhile (I9);
//   - the run folder: `<place>/.personal/<folder>/<YYYY-MM-DD>_<company>` made new for each claim (`_2`, `_3`… when taken),
//     with its mark `.acb-job.json` — the only place the run writes (I1);
//   - the draft's images: only names the pinned Skills' `tools/assets/` list, copied into the run folder's `assets/`, never
//     over a file that is there, never through a link (B2);
//   - the PC record of each run, by occurrence, run and generation: written and read back before the completion is sent.
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { departmentSkillPath, isOccurrenceId, type JobSkillPin } from '../../../../shared/core/jobs'
import { diskKey } from '../../../../shared/core/paths'
import { isValidFolderName, isValidSkillName } from '../../../../shared/core/names'
import { SET_WATCH_DRAFT_FILES, draftAssetNames, type SetEvidence } from '../../../shared/ai-turn-steps/set-watch'
import { RUN_FOLDER_MARK } from '../../write-guard'

const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** At most this much of a pinned Skill is copied (a Skill is instructions, templates and a few images). */
const COPY_MAX_FILES = 2_000
const COPY_MAX_BYTES = 100 * 1024 * 1024
const COMPANY_RE = /^[A-Za-z0-9_-]{1,100}$/
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

export interface SetWatchFsDeps {
  /** git in the company folder (no lazy fetch: what is not here is not here). */
  git: (root: string, args: string[]) => Promise<string>
  /** A blob's bytes (binary-safe: images). */
  gitBlob: (root: string, sha: string) => Promise<Buffer>
  /** Where the pinned copies live (the app's data, never the company folder). */
  copiesRoot: () => string
  /** Where the PC records live (the app's data). */
  recordsRoot: () => string
}

/** A run's pinned copy: its folder, where each pinned Skill is in it, and the images their `tools/assets/` list. */
export interface PinnedCopy {
  dir: string
  skills: Array<{ place: string; skill: string; dir: string }>
  /** Image name → its file in the copy (the procedure's first, then the read Skills', the first of a name kept). */
  assets: Map<string, string>
}

/** The run folder made for one claim. */
export interface RunFolder { name: string; rel: string; abs: string }

/** One run's record on this PC (by occurrence, run and generation). Customer words stay here, never on the server. */
export interface SetRunRecord {
  v: 1
  occurrenceId: string
  runId: string
  generation: number
  /**
   * `working`: the run folder is made, nothing reported (a run that stops here is 「途中」); `sending`: written, the completion on
   * its way (its answer not known yet); `sent` / `refused`: the server's answer; `not_adopted`: another generation finished it.
   */
  state: 'working' | 'sending' | 'sent' | 'refused' | 'not_adopted'
  folder: string | null
  decision?: string
  reason?: string
  confidence?: number | null
  unconfirmed?: string[]
  updates?: number
  /** The update proposals' file: none, read and counted, or not the shape (not counted). */
  updatesFile?: 'none' | 'valid' | 'invalid'
  /** The minutes' documents' versions the run read (`notes:7,transcript:7`); null = not known (「確かめられません」, T7). */
  minutesDocVersion?: string | null
  evidence?: SetEvidence[]
  images?: string[]
  at: string
}

/** Whether `p` is `base` or inside it (both absolute). */
function within(base: string, p: string): boolean {
  const r = path.relative(base, p)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/** A path inside a pinned tree: plain segments only. */
function safeTreePath(p: string): boolean {
  return p.length > 0 && p.length <= 400 && !p.startsWith('/') && p.split('/').every(s => s !== '' && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes('\0'))
}

export function createSetWatchFs(deps: SetWatchFsDeps) {
  const copyDirOf = (companyId: string, occurrenceId: string, generation: number) =>
    path.join(deps.copiesRoot(), companyId, `${occurrenceId}.${generation}`)

  /**
   * The department folder is on this PC as a folder, with no link on the way (4-T11: else the AI is never called). Its real
   * location must be the place inside the company folder's real location (compared as the disk folds names).
   */
  async function departmentHere(companyRoot: string | null, place: string): Promise<boolean> {
    if (!companyRoot || !isValidFolderName(place)) return false
    const root = await realpath(companyRoot).catch(() => null)
    if (!root) return false
    const target = path.join(root, place)
    const real = await realpath(target).catch(() => null)
    return !!real && diskKey(real) === diskKey(target) && (await stat(real).catch(() => null))?.isDirectory() === true
  }

  /**
   * Both pinned Skills from their trees into this run's copy (§4-4, I9): `ls-tree` of each pinned tree in the company folder's
   * repository, every blob written read-only under `<copy>/<place>/.claude/skills/<skill>/`. Links and sub-repositories are left
   * out; a tree not on this PC (or too large) → null (`PROCEDURE_NOT_HERE`, tried later). The copy is made anew for each claim.
   */
  async function makeCopy(companyId: string, occurrenceId: string, generation: number, companyRoot: string | null, pins: readonly JobSkillPin[]): Promise<PinnedCopy | null> {
    if (!companyRoot || !COMPANY_RE.test(companyId) || !isOccurrenceId(occurrenceId) || !Number.isInteger(generation) || generation < 1) return null
    const dir = copyDirOf(companyId, occurrenceId, generation)
    await rm(dir, { recursive: true, force: true })
    try {
      let files = 0
      let bytes = 0
      const skills: PinnedCopy['skills'] = []
      const assets = new Map<string, string>()
      const done = new Map<string, string>()
      for (const pin of pins) {
        if (!isValidFolderName(pin.place) || !isValidSkillName(pin.skill) || !TREE_RE.test(pin.fingerprint)) throw new Error('bad pin')
        // The same Skill named twice (the procedure also read): once; two versions of one Skill: refused.
        const where = diskKey(departmentSkillPath(pin).normalize('NFC'))
        if (done.has(where)) { if (done.get(where) !== pin.fingerprint) throw new Error('two versions'); continue }
        done.set(where, pin.fingerprint)
        const skillDir = path.join(dir, ...departmentSkillPath(pin).split('/'))
        await mkdir(skillDir, { recursive: true })
        skills.push({ place: pin.place, skill: pin.skill, dir: skillDir })
        const listing = await deps.git(companyRoot, ['ls-tree', '-r', '-z', '--full-tree', pin.fingerprint])
        for (const entry of listing.split('\0')) {
          if (!entry) continue
          const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(entry)
          if (!m) throw new Error('bad listing')
          const [, mode, type, sha, rel] = m
          // A link (120000) or another repository (commit) is never copied: the copy holds plain files only.
          if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue
          if (!safeTreePath(rel)) throw new Error('bad path')
          if (++files > COPY_MAX_FILES) throw new Error('too many files')
          const content = await deps.gitBlob(companyRoot, sha)
          bytes += content.length
          if (bytes > COPY_MAX_BYTES) throw new Error('too large')
          const target = path.join(skillDir, ...rel.split('/'))
          if (!within(skillDir, target)) throw new Error('outside')
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, content, { flag: 'wx', mode: 0o444 })
          const parts = rel.split('/')
          if (parts.length === 3 && parts[0] === 'tools' && parts[1] === 'assets' && !assets.has(parts[2])) assets.set(parts[2], target)
        }
      }
      return { dir, skills, assets }
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      return null
    }
  }

  /** A file of the copy (SKILL.md, decision.json): only a plain file inside the copy, as text; null when not there. */
  async function readCopyFile(copy: PinnedCopy, skillIndex: number, name: string): Promise<string | null> {
    const skill = copy.skills[skillIndex]
    if (!skill || !safeTreePath(name)) return null
    const target = path.join(skill.dir, ...name.split('/'))
    const s = await lstat(target).catch(() => null)
    if (!s?.isFile() || s.size > 1024 * 1024) return null
    return readFile(target, 'utf8').catch(() => null)
  }

  /** The copy removed (after the completion was sent, or when the run ends here). */
  async function removeCopy(copy: PinnedCopy | null): Promise<void> {
    if (copy && within(deps.copiesRoot(), copy.dir) && copy.dir !== deps.copiesRoot()) await rm(copy.dir, { recursive: true, force: true }).catch(() => {})
  }

  /** Every copy left by an earlier launch (the app quit mid-run): nobody reads them any more. */
  async function removeLeftCopies(): Promise<void> {
    await rm(deps.copiesRoot(), { recursive: true, force: true }).catch(() => {})
  }

  /**
   * A new run folder `<place>/.personal/<folder>/<name>` (B2): made, never reused — `<name>_2`, `_3`… when taken (a previous
   * claim's folder, a person's, another meeting with the same company that day), the base followed only when no link is on
   * the way. The mark (occurrence, run, generation) is written into it at once. null: the place is not here or a link leads out.
   */
  async function makeRunFolder(companyRoot: string | null, place: string, folder: string, name: string, mark: { occurrenceId: string; runId: string; generation: number }): Promise<RunFolder | null> {
    if (!companyRoot || !isValidFolderName(place) || !isValidFolderName(folder) || !isValidFolderName(name)) return null
    const root = await realpath(companyRoot).catch(() => null)
    if (!root) return null
    if (!(await departmentHere(root, place))) return null
    // `.personal` and the proposals folder: each made only where nothing is, never through a link (Codex review: a recursive
    // mkdir would have made a folder where a link pointed before the check refused it).
    const base = path.join(root, place, '.personal', folder)
    for (const dir of [path.join(root, place, '.personal'), base]) {
      const s = await lstat(dir).catch(() => null)
      if (s && (!s.isDirectory() || s.isSymbolicLink())) return null
      if (!s && !(await mkdir(dir).then(() => true, (e: NodeJS.ErrnoException) => e.code === 'EEXIST'))) return null
    }
    const realBase = await realpath(base).catch(() => null)
    if (!realBase || diskKey(realBase) !== diskKey(base)) return null
    for (let i = 1; i <= 99; i++) {
      const candidate = i === 1 ? name : `${name}_${i}`
      const abs = path.join(realBase, candidate)
      try {
        await mkdir(abs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
        return null
      }
      await writeFile(path.join(abs, RUN_FOLDER_MARK), JSON.stringify(mark), { flag: 'wx' }).catch(() => {})
      return { name: candidate, rel: `${place}/.personal/${folder}/${candidate}`, abs }
    }
    return null
  }

  /** A file of the run folder as text: null when it is not there; `invalid` when not a plain file or larger than `max`. */
  async function readRunFile(run: RunFolder, name: string, max: number): Promise<string | null | 'invalid'> {
    const target = path.join(run.abs, name)
    const s = await lstat(target).catch(() => null)
    if (!s) return null
    if (!s.isFile() || s.size > max) return 'invalid'
    return readFile(target, 'utf8').catch(() => 'invalid' as const)
  }

  /** The draft's files that are missing (not a plain non-empty file in the run folder). */
  async function missingDraftFiles(run: RunFolder): Promise<string[]> {
    const missing: string[] = []
    for (const name of SET_WATCH_DRAFT_FILES) {
      const s = await lstat(path.join(run.abs, name)).catch(() => null)
      if (!s?.isFile() || s.size === 0) missing.push(name)
    }
    return missing
  }

  /**
   * The images `proposal.html` names (`assets/<name>`) copied from the pinned copy (B2, 4-T22 / 4-T24): only a plain name the
   * pinned `tools/assets/` list, a plain file there; into the run folder's own `assets/` (a real folder, no link — its real
   * location must be the run folder's), never over a file already there. Answers the names copied; null when the folder is
   * not one to write into (a link) — then nothing is sent.
   */
  async function copyDraftImages(run: RunFolder, copy: PinnedCopy): Promise<string[] | null> {
    const html = await readFile(path.join(run.abs, 'proposal.html'), 'utf8').catch(() => null)
    if (html === null) return []
    const names = draftAssetNames(html).filter(n => copy.assets.has(n))
    if (names.length === 0) return []
    const realRun = await realpath(run.abs).catch(() => null)
    if (!realRun) return null
    const assets = path.join(realRun, 'assets')
    await mkdir(assets).catch(() => {})
    const a = await lstat(assets).catch(() => null)
    const realAssets = await realpath(assets).catch(() => null)
    if (!a?.isDirectory() || a.isSymbolicLink() || realAssets !== assets) return null
    const copied: string[] = []
    for (const name of names) {
      const from = copy.assets.get(name) as string
      const s = await lstat(from).catch(() => null)
      if (!s?.isFile() || !within(copy.dir, from)) continue
      const to = path.join(assets, name)
      try {
        await copyFile(from, to, fsConstants.COPYFILE_EXCL)
        await chmod(to, 0o644).catch(() => {})
        copied.push(name)
      } catch (e) {
        // There already: never overwritten, fine. Any other failure (disk full, permissions): the draft is not whole — nothing
        // is sent (Codex review).
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
      }
    }
    return copied
  }

  const recordDir = (companyId: string, occurrenceId: string) => path.join(deps.recordsRoot(), companyId, occurrenceId)
  const recordFile = (companyId: string, r: Pick<SetRunRecord, 'occurrenceId' | 'runId' | 'generation'>) =>
    path.join(recordDir(companyId, r.occurrenceId), `${r.runId}.${r.generation}.json`)
  const recordKeyOk = (companyId: string, r: Pick<SetRunRecord, 'occurrenceId' | 'runId' | 'generation'>) =>
    COMPANY_RE.test(companyId) && isOccurrenceId(r.occurrenceId) && RUN_ID_RE.test(r.runId) && Number.isInteger(r.generation) && r.generation >= 1

  /**
   * One run's record written and read back (B2 ③): false when it could not be kept — then the completion is never sent. Written
   * through a temporary file and a rename, so a crash leaves the previous record whole.
   */
  async function writeRecord(companyId: string, record: SetRunRecord): Promise<boolean> {
    if (!recordKeyOk(companyId, record)) return false
    const file = recordFile(companyId, record)
    const text = JSON.stringify(record)
    try {
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, file)
      return (await readFile(file, 'utf8')) === text
    } catch {
      return false
    }
  }

  /** The records of a company still `sending` (their completion's answer was lost): asked about when the app looks again. */
  async function sendingRecords(companyId: string, limit = 20): Promise<SetRunRecord[]> {
    if (!COMPANY_RE.test(companyId)) return []
    const out: SetRunRecord[] = []
    for (const occ of await readdir(path.join(deps.recordsRoot(), companyId)).catch(() => [] as string[])) {
      if (!isOccurrenceId(occ)) continue
      for (const f of await readdir(recordDir(companyId, occ)).catch(() => [] as string[])) {
        if (!f.endsWith('.json')) continue
        const r = await readFile(path.join(recordDir(companyId, occ), f), 'utf8').then(t => JSON.parse(t) as SetRunRecord, () => null)
        if (r && r.state === 'sending' && r.occurrenceId === occ && recordKeyOk(companyId, r)) out.push(r)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  return { departmentHere, makeCopy, readCopyFile, removeCopy, removeLeftCopies, makeRunFolder, readRunFile, missingDraftFiles, copyDraftImages, writeRecord, sendingRecords }
}

export type SetWatchFs = ReturnType<typeof createSetWatchFs>

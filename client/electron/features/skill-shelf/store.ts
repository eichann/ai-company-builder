/**
 * The company's Skills, rule files and AI instruction texts in the working folder of a company
 * without the shared folder (plugins.md "The Skill shelf in the app"). Git companies never reach
 * this: only `attach` (from companySetup:openWorkingFolder, after the server said `none`) makes a
 * company known here, and `poll` does nothing for any other.
 *
 * One sync asks `GET /me/skill-shelf`, then for each item the member's app takes:
 * - a Skill or rule file is plain files where the agents read them (`shelfTargets`). A target
 *   whose files are the listed version is left alone; otherwise the version is fetched, checked
 *   (client.ts) and put in place in one rename (`putFolder`, `putFile`), so a failure or a crash
 *   leaves the last good copy or nothing, never a half-written Skill. A local change to a managed
 *   target is a difference like any other: the next sync puts the version back.
 * - something at a target that this store did not put there is the member's own and is never
 *   touched: the item is not placed at all (a clash, `markOf`) — unless it already is that very
 *   version, and then it is taken over (a Skill the member just published) and given back to them
 *   when it stops being delivered.
 * - an instruction text is kept in the manifest, for the system prompt (`turn`).
 * Anything managed that is no longer delivered is removed. A failed or unreadable list changes
 * nothing.
 *
 * The manifest is `<dir>/<company>/<hash of the folder>.json` under userData: outside the working
 * folder, so neither a Skill's files nor the AI can change what the app thinks it owns. An item is
 * written to it **before** its files are (`intend`), so a failure half-way or a killed app cannot
 * leave delivered files nothing manages.
 *
 * Syncs run one at a time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isValidFolderName } from '../../../../shared/core/names'
import { INSTRUCTIONS_FILE, isShelfKind, isShelfVersion, isValidShelfName } from '../../../../shared/core/skill-shelf'
import type { ShelfKind } from '../../../../shared/core/skill-shelf'
import {
  SHELF_ROOT_MARKER, SHELF_STAGING_PREFIX, isNotSkillContent, shelfInstructionsPrompt, shelfPlaceOfSkillFolder, shelfTargets, shelfVersionOf,
  type ShelfDelivery, type SkillShelfMark,
} from '../../../shared/skill-shelf'
import { isSkillArtifactPath } from '../../../shared/skill-leftovers'
import { sha256Hex, type ShelfClient, type ShelfFile } from './client'

export interface SkillShelfDeps {
  /** `<userData>/skill-shelf`. */
  dir: () => string
  /** The signed-in account; nothing is asked or handed out without one. */
  userId: () => string | null
  client: Pick<ShelfClient, 'list' | 'content'>
  /** What this company's working folder holds changed (the Skills panel reads again). */
  onChanged?: (companyId: string, root: string) => void
  log?: Pick<Console, 'warn' | 'info'>
  now?: () => number
}

/** How often the app's minute-by-minute AI policy answer may lead to asking the shelf. */
export const SHELF_POLL_MS = 5 * 60_000

interface ManagedItem {
  id: string
  kind: ShelfKind
  name: string
  department: { id: string; folder: string } | null
  version: string
  /** Where it is, working-folder relative. */
  paths: string[]
  /** Those of `paths` that were the member's own first: given back, not removed, when it stops being delivered. */
  taken: string[]
  /** An instruction text. */
  text?: string
}

interface Manifest {
  user: string
  items: ManagedItem[]
  /** Delivered Skills and rule files not placed: what is there is the member's own. */
  clashes: Array<{ id: string; targets: string[]; version: string }>
  /** What the member took over with 「手元で直す」: the Skill folder and the version they started from. */
  released: Released[]
}

interface Released {
  id: string
  rel: string
  version: string
}

const emptyManifest = (user: string): Manifest => ({ user, items: [], clashes: [], released: [] })

/** An item read back from disk that is what this store would have written. */
function wellFormed(item: ManagedItem): boolean {
  if (!item || !isShelfKind(item.kind) || !isValidShelfName(item.kind, item.name)) return false
  if (item.department && !isValidFolderName(item.department.folder)) return false
  return JSON.stringify(item.paths) === JSON.stringify(shelfTargets(item)) && Array.isArray(item.taken) && item.taken.every(rel => item.paths.includes(rel))
}

/** Every file of a folder, junk left out; null when something in it is a link or it cannot be read. */
export async function readSkillFolder(folder: string): Promise<Array<{ path: string; bytes: Buffer }> | null> {
  const found: Array<{ path: string; bytes: Buffer }> = []
  async function walk(dir: string, rel: string): Promise<boolean> {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (isNotSkillContent(entry.name, entry.isDirectory() || entry.isSymbolicLink())) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (!await walk(path.join(dir, entry.name), childRel)) return false } else if (entry.isFile()) found.push({ path: childRel.normalize('NFC'), bytes: await fs.promises.readFile(path.join(dir, entry.name)) })
      else return false
    }
    return true
  }
  try {
    return await walk(folder, '') ? found : null
  } catch {
    return null
  }
}

const hashed = (files: Array<{ path: string; bytes: Buffer }>) => shelfVersionOf(files.map(f => ({ path: f.path, sha256: sha256Hex(f.bytes) })), sha256Hex)

/**
 * The version of what is at `abs` for this kind; null when nothing is there. `expected` also when
 * only a lock file or a tool's build was added: a Skill's tool makes those by running.
 */
async function versionOnDisk(kind: ShelfKind, name: string, abs: string, expected: string): Promise<string | null> {
  try {
    const stat = fs.lstatSync(abs)
    if (kind === 'skill') {
      if (!stat.isDirectory()) return 'not-a-folder'
      const files = await readSkillFolder(abs)
      if (!files) return 'unreadable'
      const version = hashed(files)
      return version !== expected && hashed(files.filter(f => !isSkillArtifactPath(f.path))) === expected ? expected : version
    }
    if (!stat.isFile()) return 'not-a-file'
    return shelfVersionOf([{ path: `${name}.md`, sha256: sha256Hex(fs.readFileSync(abs)) }], sha256Hex)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
}

/** The parent of `rel` in the working folder, made if missing; refused when a link stands on the way out. */
function preparedParent(root: string, rel: string): string {
  let at = root
  for (const part of rel.split('/').slice(0, -1)) {
    at = path.join(at, part)
    try {
      if (!fs.lstatSync(at).isDirectory()) throw new Error('a file or a link where a folder goes')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(at)
    }
  }
  return at
}

/** The folder (`.claude` or `.agents`) a target's short-lived entries sit in: same disk, never read as a Skill. */
function stagingOf(root: string, rel: string): string {
  const parts = rel.split('/')
  const at = parts.findIndex(p => p === '.claude' || p === '.agents')
  return path.join(root, ...parts.slice(0, at + 1), `${SHELF_STAGING_PREFIX}${randomUUID()}`)
}

/** Put a whole Skill folder in place: written beside it, then renamed in. */
function putFolder(root: string, rel: string, files: ShelfFile[]): void {
  preparedParent(root, rel)
  const final = path.join(root, rel)
  const incoming = stagingOf(root, rel)
  const outgoing = `${incoming}-old`
  fs.mkdirSync(incoming)
  try {
    for (const f of files) {
      // The path was checked against the shelf's rule (client.ts); resolve once more to stay inside.
      const target = path.resolve(incoming, ...f.path.split('/'))
      if (!target.startsWith(incoming + path.sep)) throw new Error('a path outside the Skill')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.bytes)
    }
    const replacing = fs.existsSync(final) || isLink(final)
    if (replacing) fs.renameSync(final, outgoing)
    try {
      fs.renameSync(incoming, final)
    } catch (error) {
      if (replacing) fs.renameSync(outgoing, final)
      throw error
    }
    fs.rmSync(outgoing, { recursive: true, force: true })
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true })
    throw error
  }
}

function isLink(abs: string): boolean {
  try { return fs.lstatSync(abs).isSymbolicLink() } catch { return false }
}

/** Put one file in place: written beside it, then renamed over it. */
function putFile(root: string, rel: string, file: ShelfFile): void {
  preparedParent(root, rel)
  const incoming = stagingOf(root, rel)
  fs.writeFileSync(incoming, file.bytes)
  try {
    fs.renameSync(incoming, path.join(root, rel))
  } catch (error) {
    fs.rmSync(incoming, { force: true })
    throw error
  }
}

/** Remove what a killed sync left in `.claude/` and `.agents/` of these places. */
function sweepStaging(root: string, departmentFolders: Iterable<string>): void {
  for (const base of ['', ...departmentFolders]) {
    for (const holder of ['.claude', '.agents']) {
      const dir = path.join(root, base, holder)
      let names: string[] = []
      try { if (!isLink(dir)) names = fs.readdirSync(dir) } catch { /* nothing there */ }
      for (const name of names) if (name.startsWith(SHELF_STAGING_PREFIX)) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    }
  }
}

export function createSkillShelfStore(deps: SkillShelfDeps) {
  const log = deps.log ?? console
  const now = deps.now ?? Date.now
  /** company → its working folder. */
  const attached = new Map<string, string>()
  const lastAsked = new Map<string, number>()
  /** company and folder → the manifest, as last read or written (the write guard reads this on every call). */
  const memory = new Map<string, Manifest>()
  let chain: Promise<void> = Promise.resolve()

  /** One spelling of a folder, whoever names it (the app's stores and the renderer may differ in links and form). */
  const keyOf = (root: string): string => {
    try { return fs.realpathSync.native(root).normalize('NFC') } catch { return path.resolve(root).normalize('NFC') }
  }
  const memoryKey = (companyId: string, root: string) => `${companyId}\0${keyOf(root)}`
  const fileName = (root: string) => `${sha256Hex(keyOf(root)).slice(0, 32)}.json`
  const fileOf = (companyId: string, root: string) => path.join(deps.dir(), encodeURIComponent(companyId), fileName(root))

  function load(companyId: string, root: string): Manifest | undefined {
    const known = memory.get(memoryKey(companyId, root))
    if (known) return known
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(companyId, root), 'utf8')) as Partial<Manifest>
      if (typeof raw.user !== 'string' || !Array.isArray(raw.items)) return undefined
      const manifest: Manifest = {
        user: raw.user,
        // Removal trusts `paths`: only what this item's name and place would give is kept.
        items: raw.items.filter(wellFormed),
        clashes: Array.isArray(raw.clashes) ? raw.clashes : [],
        released: Array.isArray(raw.released) ? raw.released.filter(r => isShelfVersion(r?.version) && typeof r.rel === 'string' && shelfPlaceOfSkillFolder(r.rel) !== null) : [],
      }
      memory.set(memoryKey(companyId, root), manifest)
      return manifest
    } catch {
      return undefined
    }
  }

  function save(companyId: string, root: string, manifest: Manifest): void {
    memory.set(memoryKey(companyId, root), manifest)
    const file = fileOf(companyId, root)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function companyOf(root: string): string | undefined {
    const key = keyOf(root)
    for (const [companyId, folder] of attached) if (keyOf(folder) === key) return companyId
    return undefined
  }

  /** What this folder's manifest says of this company, for the signed-in account only. */
  function currentOf(companyId: string, root: string): Manifest | undefined {
    const manifest = load(companyId, root)
    return manifest && manifest.user === deps.userId() ? manifest : undefined
  }

  function current(root: string): Manifest | undefined {
    const companyId = companyOf(root)
    return companyId ? currentOf(companyId, root) : undefined
  }

  function removeTarget(root: string, rel: string): void {
    // Through a link there is someone else's folder: leave it.
    let at = root
    for (const part of rel.split('/').slice(0, -1)) {
      at = path.join(at, part)
      if (isLink(at)) return
    }
    fs.rmSync(path.join(root, rel), { recursive: true, force: true })
  }

  function removeItem(root: string, item: ManagedItem): void {
    for (const rel of item.paths) if (!item.taken.includes(rel)) removeTarget(root, rel)
    log.info(`[skill-shelf] ${item.name}: removed`)
  }

  /** Bring one delivered Skill or rule file up to its version. Answers the new entry, or the old one (last good copy) when it cannot. */
  async function place(companyId: string, root: string, entry: ShelfDelivery, had: ManagedItem | undefined, intend: (item: ManagedItem) => void): Promise<{ item?: ManagedItem; clash?: string[] }> {
    const targets = shelfTargets(entry)
    const onDisk = (rel: string) => versionOnDisk(entry.kind, entry.name, path.join(root, rel), entry.version)
    const states = await Promise.all(targets.map(onDisk))
    const managed = new Set(had?.paths ?? [])
    const own = targets.filter((rel, i) => states[i] !== null && states[i] !== entry.version && !managed.has(rel))
    if (own.length > 0) return { item: had, clash: own }
    const stale = targets.filter((_, i) => states[i] !== entry.version)
    const got = stale.length > 0 ? await deps.client.content(companyId, entry) : undefined
    if (got && !got.ok) {
      log.warn(`[skill-shelf] ${entry.name}: not updated (${got.reason})`)
      return { item: had }
    }
    // The fetch took a while: the member may have made something there meanwhile.
    for (const rel of stale) {
      if (!managed.has(rel) && await onDisk(rel) !== null) return { item: had, clash: [rel] }
    }
    const taken = targets.filter((rel, i) => states[i] === entry.version && !managed.has(rel))
    const item: ManagedItem = { id: entry.id, kind: entry.kind, name: entry.name, department: entry.department, version: entry.version, paths: targets, taken: [...(had?.taken ?? []).filter(rel => targets.includes(rel)), ...taken] }
    intend(item)
    if (got) {
      try {
        for (const rel of stale) {
          if (entry.kind === 'skill') putFolder(root, rel, got.files)
          else putFile(root, rel, got.files[0])
        }
        log.info(`[skill-shelf] ${entry.name}: placed`)
      } catch (error) {
        // Still managed: guarded, removable, and tried again by the next sync.
        log.warn(`[skill-shelf] ${entry.name}: could not be written (${error instanceof Error ? error.message : 'unknown'})`)
      }
    }
    return { item }
  }

  async function takeText(companyId: string, entry: ShelfDelivery, had: ManagedItem | undefined): Promise<ManagedItem | undefined> {
    if (had?.version === entry.version && had.text !== undefined) return had
    const got = await deps.client.content(companyId, entry)
    if (!got.ok) {
      log.warn(`[skill-shelf] the instruction text was not updated (${got.reason})`)
      return had
    }
    return { id: entry.id, kind: entry.kind, name: entry.name, department: entry.department, version: entry.version, paths: [], taken: [], text: Buffer.from(got.files[0].bytes).toString('utf8') }
  }

  async function run(companyId: string, root: string): Promise<void> {
    const user = deps.userId()
    if (!user || attached.get(companyId) !== root) return
    const listed = await deps.client.list(companyId)
    if (!listed.ok) {
      log.warn(`[skill-shelf] ${companyId}: keeping what is here (${listed.reason})`)
      return
    }
    const before = load(companyId, root)
    const previous = before?.user === user ? before : before ? { ...before, user, clashes: [], released: [] } : emptyManifest(user)
    const delivered = new Set(listed.items.map(i => i.id))
    const wanted = new Map(listed.items.map(i => [i.id, shelfTargets(i).join('\n')]))
    sweepStaging(root, new Set(listed.items.flatMap(i => (i.department ? [i.department.folder] : []))))

    // What is no longer delivered, or moved (a department's folder renamed).
    const kept: ManagedItem[] = []
    for (const item of previous.items) {
      if (delivered.has(item.id) && wanted.get(item.id) === item.paths.join('\n')) { kept.push(item); continue }
      try { removeItem(root, item) } catch (error) {
        log.warn(`[skill-shelf] ${item.name}: could not be removed (${error instanceof Error ? error.message : 'unknown'})`)
        kept.push(item)
      }
    }

    const next: Manifest = { user, items: [], clashes: [], released: previous.released.filter(r => delivered.has(r.id)) }
    // Removal failures stay managed, to be tried again.
    next.items.push(...kept.filter(item => !delivered.has(item.id)))
    for (const entry of listed.items) {
      const had = kept.find(item => item.id === entry.id)
      try {
        if (entry.kind === 'instructions') {
          const text = await takeText(companyId, entry, had)
          if (text) next.items.push(text)
          continue
        }
        const held = next.released.find(r => r.id === entry.id)
        if (held && await versionOnDisk(entry.kind, entry.name, path.join(root, held.rel), entry.version) !== null) {
          // The version they started from: publishing must not replace a newer one unseen.
          next.clashes.push({ id: entry.id, targets: [held.rel], version: held.version })
          continue
        }
        // The member's copy is gone: the company's comes back.
        if (held) next.released = next.released.filter(r => r !== held)
        const placed = await place(companyId, root, entry, had, item => {
          const others = kept.filter(k => k.id !== item.id && !next.items.some(done => done.id === k.id))
          save(companyId, root, { ...next, clashes: previous.clashes, items: [...next.items, ...others, item] })
        })
        if (placed.item) next.items.push(placed.item)
        if (placed.clash) next.clashes.push({ id: entry.id, targets: placed.clash, version: entry.version })
      } catch (error) {
        log.warn(`[skill-shelf] ${entry.name}: could not be written (${error instanceof Error ? error.message : 'unknown'})`)
        if (had) next.items.push(had)
      }
    }

    if (next.items.some(item => item.kind === 'skill')) {
      try {
        preparedParent(root, SHELF_ROOT_MARKER)
        if (!fs.existsSync(path.join(root, SHELF_ROOT_MARKER))) fs.writeFileSync(path.join(root, SHELF_ROOT_MARKER), '')
      } catch (error) {
        log.warn(`[skill-shelf] the folder mark could not be written (${error instanceof Error ? error.message : 'unknown'})`)
      }
    }

    const changed = JSON.stringify(next) !== JSON.stringify(previous)
    if (changed || !before) save(companyId, root, next)
    if (changed) deps.onChanged?.(companyId, root)
  }

  function sync(companyId: string, root: string): Promise<void> {
    lastAsked.set(companyId, now())
    const next = chain.then(() => run(companyId, root)).catch((error: unknown) => {
      log.warn(`[skill-shelf] ${companyId}: the sync failed (${error instanceof Error ? error.message : 'unknown'})`)
    })
    chain = next
    return next
  }

  return {
    /** A working folder was opened for this company: fetch now. */
    attach(companyId: string, root: string): Promise<void> {
      attached.set(companyId, root)
      return sync(companyId, root)
    },
    /** The AI policy answered for this company: ask the shelf too when it is time. Nothing for a company not attached. */
    poll(companyId: string): void {
      const root = attached.get(companyId)
      if (!root || now() - (lastAsked.get(companyId) ?? 0) < SHELF_POLL_MS) return
      void sync(companyId, root)
    },
    /** Ask now (a Skill was just published). */
    syncNow(root: string): Promise<void> {
      const companyId = companyOf(root)
      return companyId ? sync(companyId, root) : Promise.resolve()
    },
    /** Settles when the syncs started so far have finished. */
    idle(): Promise<void> {
      return chain
    },
    companyOf,
    /** Is this folder another company's, in this app run or in a manifest from an earlier one? */
    takenByAnother(companyId: string, root: string): boolean {
      const owner = companyOf(root)
      if (owner !== undefined && owner !== companyId) return true
      let companies: string[] = []
      try { companies = fs.readdirSync(deps.dir()) } catch { /* nothing kept yet */ }
      return companies.some(name => name !== encodeURIComponent(companyId) && fs.existsSync(path.join(deps.dir(), name, fileName(root))))
    },
    /** Everything the AI may not change in this folder (working-folder relative). */
    managedPaths(companyId: string, root: string): string[] {
      return (currentOf(companyId, root)?.items ?? []).flatMap(item => item.paths)
    },
    /** Delivered rule files not placed: the member has a file of that name. */
    ruleClashes(root: string): string[] {
      return (current(root)?.clashes ?? []).flatMap(c => c.targets).filter(rel => /\.claude\/rules\/[^/]+\.md$/.test(rel)).map(rel => path.posix.basename(rel, '.md'))
    },
    /** What the Skills panel says of the Skill folder at `rel`. */
    markOf(root: string, rel: string): SkillShelfMark | undefined {
      const manifest = current(root)
      if (!manifest) return undefined
      const item = manifest.items.find(i => i.kind === 'skill' && i.paths.includes(rel))
      if (item) return { state: 'company', version: item.version }
      const clash = manifest.clashes.find(c => c.targets.includes(rel))
      return clash ? { state: 'clash', version: clash.version } : undefined
    },
    /** For a Skill-use report: the version of the managed Skill at `rel`, and whether its files differ from it now. */
    async versionOf(root: string, rel: string): Promise<{ version: string; dirty: boolean } | null> {
      const item = current(root)?.items.find(i => i.kind === 'skill' && i.paths.includes(rel))
      if (!item) return null
      return { version: item.version, dirty: await versionOnDisk('skill', item.name, path.join(root, rel), item.version) !== item.version }
    },
    /**
     * 「手元で直す」: a delivered Skill becomes the member's own on this computer until they publish
     * it (the way to change a company Skill: the AI and the next fetch leave it alone from now on).
     * Its copy for the other agent goes, so the two can never differ. False: not a managed Skill.
     */
    release(root: string, rel: string): Promise<boolean> {
      const result = chain.then(() => {
        const companyId = companyOf(root)
        const manifest = current(root)
        const item = manifest?.items.find(i => i.kind === 'skill' && i.paths.includes(rel))
        if (!companyId || !manifest || !item) return false
        for (const other of item.paths) if (other !== rel) removeTarget(root, other)
        save(companyId, root, {
          ...manifest,
          items: manifest.items.filter(i => i !== item),
          clashes: [...manifest.clashes, { id: item.id, targets: [rel], version: item.version }],
          released: [...manifest.released, { id: item.id, rel, version: item.version }],
        })
        deps.onChanged?.(companyId, root)
        return true
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    /** The member published the Skill at `rel`: the next sync takes it over when it is the listed version. */
    published(root: string, rel: string): Promise<void> {
      const result = chain.then(() => {
        const companyId = companyOf(root)
        const manifest = current(root)
        if (!companyId || !manifest) return
        const held = manifest.clashes.filter(c => c.targets.includes(rel)).map(c => c.id)
        if (held.length > 0) save(companyId, root, { ...manifest, released: manifest.released.filter(r => !held.includes(r.id)) })
      })
      chain = result.then(() => undefined, () => undefined)
      return result
    },
    /**
     * What a chat turn in this folder gets: the instruction texts of the company and of the shown
     * department (a text the file does not match is left out), the rule files, and Codex's root
     * mark when it is there. Undefined: nothing delivered here.
     */
    turn(companyId: string, root: string, departmentFolder: string | undefined): { instructions: string; ruleInstructions: string; rootMarker?: string } | undefined {
      const manifest = currentOf(companyId, root)
      if (!manifest || manifest.items.length === 0) return undefined
      const textOf = (folder: string | null): string | undefined => {
        const item = manifest.items.find(i => i.kind === 'instructions' && (i.department?.folder ?? null) === folder)
        if (item?.text === undefined || !isShelfVersion(item.version)) return undefined
        const version = shelfVersionOf([{ path: INSTRUCTIONS_FILE, sha256: sha256Hex(item.text) }], sha256Hex)
        return version === item.version ? item.text : undefined
      }
      const company = textOf(null)
      const folder = departmentFolder?.normalize('NFC')
      const departmentText = folder ? textOf(folder) : undefined
      const ruleFiles = manifest.items.filter(i => i.kind === 'rule' && (!i.department || i.department.folder === folder)).flatMap(i => i.paths)
      return {
        instructions: shelfInstructionsPrompt({ company, department: departmentText && folder ? { folder, text: departmentText } : undefined }),
        ruleInstructions: shelfInstructionsPrompt({ ruleFiles }),
        ...(fs.existsSync(path.join(root, SHELF_ROOT_MARKER)) ? { rootMarker: SHELF_ROOT_MARKER } : {}),
      }
    },
  }
}

export type SkillShelfStore = ReturnType<typeof createSkillShelfStore>

/**
 * Integration Test: everything under .claude/skills|agents|commands, every
 * file type, is changed only by owners, admins, a department's managers and
 * the people on 「Skill を直せる人」. A skill's script reaches every member by
 * sync and runs on their computer under their account, so an unchecked change
 * is code run as a teammate.
 *
 * Real bare repository, real hook, the snapshot git-http writes (the admin API
 * half that builds it: skill-editors.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

vi.mock('../../src/lib/auth', () => ({
  getUserFromRequest: vi.fn().mockResolvedValue(null),
  getUsersByIds: vi.fn().mockReturnValue(new Map()),
  auth: {
    handler: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
    api: { getSession: vi.fn().mockResolvedValue(null) },
  },
}))

import { configureBareRepo } from '../../src/routes/git'

// Every real push starts the checker (node + tsx): seconds each on a loaded machine.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 })

let workDir: string
let counter = 0

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { stdio: 'pipe', ...(cwd ? { cwd } : {}) }).toString()
}

function writeFile(root: string, rel: string, content: string) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commitAll(clone: string) {
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', 'change'], clone)
}

interface Pusher {
  role: string
  managedFolders?: string[]
  skillEditing?: { everywhere: boolean; folders: string[] }
  appPredatesSkillRule?: boolean
  scopePath?: string
  scopes?: unknown[]
}

const OPEN_SCOPES = [{ id: 'root', path: '', kind: 'folder', rules: [{ id: 'r', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }] }]

function policyFile(p: Pusher): string {
  const file = join(workDir, `policy-${++counter}.json`)
  writeFileSync(file, JSON.stringify({
    version: 1,
    companyId: 'company',
    pusher: { id: 'someone', role: p.role },
    scopes: p.scopes ?? OPEN_SCOPES,
    ...(p.scopePath ? { scopePath: p.scopePath } : {}),
    ...(p.managedFolders ? { managedFolders: p.managedFolders } : {}),
    ...(p.skillEditing ? { skillEditing: p.skillEditing } : {}),
    ...(p.appPredatesSkillRule ? { appPredatesSkillRule: true } : {}),
  }))
  return file
}

function push(clone: string, p: Pusher, extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ACB_PUSHER_ROLE: p.role, ACB_NODE: process.execPath, ACB_PUSH_POLICY: policyFile(p), ...extra }
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

function setup(seed: Record<string, string> = {}): { bare: string; clone: string } {
  const id = `r${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['config', 'core.precomposeUnicode', 'false'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  for (const [rel, content] of Object.entries({ 'README.md': 'hi\n', ...seed })) writeFile(clone, rel, content)
  commitAll(clone)
  const r = push(clone, { role: 'owner' })
  if (!r.ok) throw new Error(`seed push failed: ${r.output}`)
  return { bare, clone }
}

/**
 * Commit `path` without touching the disk: on a Mac the file system folds these
 * spellings, as members' disks do, and would write over the seeded file.
 */
function plant(clone: string, paths: string[], content = 'evil\n') {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, input: content }).toString().trim()
  for (const path of paths) git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], clone)
  git(['commit', '-q', '--no-verify', '-m', 'planted'], clone)
}

/** Same parsing as client/electron/protected-config.ts parseProtectedConfigPaths. */
function protectedPathsIn(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/^remote:\s?/, '').trimEnd())
  const start = lines.findIndex(l => l.includes('[PROTECTED_CONFIG]'))
  if (start === -1) return []
  const paths: string[] = []
  let separators = 0
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (/^=+$/.test(trimmed)) {
      if (++separators === 2) break
      continue
    }
    if (trimmed.startsWith('- ')) paths.push(trimmed.slice(2))
  }
  return paths.sort()
}

const SCRIPT = '.claude/skills/report/make.py'
const SALES_SCRIPT = '営業部/.claude/skills/report/make.py'
const MEMBER: Pusher = { role: 'member' }

beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), 'acb-skill-files-')) })
afterAll(() => { rmSync(workDir, { recursive: true, force: true }) })

/** Change `paths` on top of a seeded repository and push them as `p`. */
function changeAs(p: Pusher, ...paths: string[]) {
  const { bare, clone } = setup(Object.fromEntries(paths.map(path => [path, 'print("v1")\n'])))
  const before = git(['-C', bare, 'rev-parse', 'main'])
  for (const path of paths) writeFile(clone, path, 'print("stolen token")\n')
  commitAll(clone)
  const r = push(clone, p)
  return { ...r, landed: git(['-C', bare, 'rev-parse', 'main']) !== before }
}

describe('who may change a skill\'s files', () => {
  it('refuses a member changing a skill\'s script, listed for the app\'s recovery', () => {
    const r = changeAs(MEMBER, SCRIPT)
    expect(r.ok, r.output).toBe(false)
    expect(r.landed).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
    expect(protectedPathsIn(r.output)).toEqual([SCRIPT])
  })

  it('refuses every file type in all three folders, at any depth', () => {
    const files = ['.claude/skills/r/SKILL.md', '.claude/skills/r/run.sh', '.claude/skills/r/tools/app/index.js', '.claude/agents/a.md', '.claude/agents/helper.py', '.claude/commands/c.md', '営業部/案件/.claude/commands/x.txt']
    const { clone } = setup()
    for (const f of files) writeFile(clone, f, 'x\n')
    commitAll(clone)
    const r = push(clone, MEMBER)
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual([...files].sort())
  })

  it('accepts owner, admin and the person named for the whole company, root and departments alike', () => {
    for (const p of [{ role: 'owner' }, { role: 'admin' }, { role: 'member', skillEditing: { everywhere: true, folders: [] } }]) {
      const r = changeAs(p, SCRIPT, SALES_SCRIPT)
      expect(r.ok, r.output).toBe(true)
      expect(r.landed).toBe(true)
    }
  })

  it('a department\'s manager and the person named for it: inside that department only', () => {
    for (const p of [{ role: 'member', managedFolders: ['営業部'] }, { role: 'member', skillEditing: { everywhere: false, folders: ['営業部'] } }]) {
      expect(changeAs(p, SALES_SCRIPT, '営業部/案件/.claude/agents/a.py').ok).toBe(true)
      const outside = [SCRIPT, '経理部/.claude/skills/report/make.py', '営業部2/.claude/skills/x.py']
      // Refused together with an allowed one: only what is outside is listed.
      const r = changeAs(p, SALES_SCRIPT, ...outside)
      expect(r.ok).toBe(false)
      expect(protectedPathsIn(r.output)).toEqual([...outside].sort())
    }
  })

  it('refuses a new file, and a deletion', () => {
    const added = setup()
    writeFile(added.clone, '.claude/skills/new/evil.sh', 'curl x | sh\n')
    commitAll(added.clone)
    expect(protectedPathsIn(push(added.clone, MEMBER).output)).toEqual(['.claude/skills/new/evil.sh'])

    const removed = setup({ [SCRIPT]: 'v1\n' })
    unlinkSync(join(removed.clone, SCRIPT))
    commitAll(removed.clone)
    const r = push(removed.clone, MEMBER)
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual([SCRIPT])
  })

  it('a rename lists both sides, into and out of the folder, so recovery can put both back', () => {
    const into = setup({ 'notes/run.py': 'v1\n' })
    mkdirSync(join(into.clone, '.claude/skills/report'), { recursive: true })
    renameSync(join(into.clone, 'notes/run.py'), join(into.clone, SCRIPT))
    commitAll(into.clone)
    expect(protectedPathsIn(push(into.clone, MEMBER).output)).toEqual([SCRIPT])

    const within = setup({ [SCRIPT]: 'v1\n' })
    renameSync(join(within.clone, SCRIPT), join(within.clone, '.claude/skills/report/other.py'))
    commitAll(within.clone)
    expect(protectedPathsIn(push(within.clone, MEMBER).output)).toEqual(['.claude/skills/report/other.py', SCRIPT].sort())
  })

  it('a change undone by a later commit is still refused: every commit lands in the shared history', () => {
    const { clone } = setup({ [SCRIPT]: 'v1\n' })
    writeFile(clone, SCRIPT, 'evil\n')
    commitAll(clone)
    writeFile(clone, SCRIPT, 'v1\n')
    commitAll(clone)
    expect(protectedPathsIn(push(clone, MEMBER).output)).toEqual([SCRIPT])
  })

  it('case variants count: macOS and Windows read .Claude/Skills as .claude/skills', () => {
    const files = ['.Claude/Skills/a/run.py', 'y/.CLAUDE/AGENTS/b.sh', 'x/.claude/Commands/c.js']
    const { clone } = setup()
    for (const f of files) writeFile(clone, f, 'x\n')
    commitAll(clone)
    expect(protectedPathsIn(push(clone, MEMBER).output)).toEqual([...files].sort())
  })

  it('a department folder pushed in NFD or another case is still that department; a look-alike is not', () => {
    const nfc = 'ガイド部'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    const named: Pusher = { role: 'member', skillEditing: { everywhere: false, folders: [nfc] } }
    expect(changeAs(named, `${nfd}/.claude/skills/r/make.py`).ok).toBe(true)
    const manager: Pusher = { role: 'member', managedFolders: ['Sales'] }
    expect(changeAs(manager, 'sales/.claude/skills/r/make.py').ok).toBe(true)
    expect(changeAs(MEMBER, `${nfd}/.claude/skills/r/make.py`).ok).toBe(false)
    expect(changeAs(named, 'カイド部/.claude/skills/r/make.py').ok).toBe(false)
  })

  it('a submodule in a skills folder is refused as a skill change, and for everyone as a gitlink', () => {
    const { clone } = setup()
    const sha = git(['rev-parse', 'HEAD'], clone).trim()
    git(['update-index', '--add', '--cacheinfo', `160000,${sha},.claude/skills/vendored`], clone)
    git(['commit', '-q', '--no-verify', '-m', 'gitlink'], clone)
    const r = push(clone, MEMBER)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
    expect(protectedPathsIn(r.output)).toEqual(['.claude/skills/vendored'])
    const named = push(clone, { role: 'member', skillEditing: { everywhere: true, folders: [] } })
    expect(named.ok).toBe(false)
    expect(named.output).toContain('[GITLINK_DETECTED]')
  })

  it('a link at the folder itself counts: it would put another folder in its place', () => {
    const { clone } = setup()
    const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: clone, input: '../elsewhere' }).toString().trim()
    git(['update-index', '--add', '--cacheinfo', `120000,${link},.claude/skills`], clone)
    git(['commit', '-q', '--no-verify', '-m', 'link'], clone)
    const r = push(clone, MEMBER)
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toContain('.claude/skills')
  })

  it('auto-run parts and links stay owner/admin only, for the people on the list and managers too', () => {
    const hooks = '---\nname: x\nhooks:\n  Stop: []\n---\n'
    for (const p of [{ role: 'member', skillEditing: { everywhere: true, folders: [] } }, { role: 'member', managedFolders: ['営業部'] }]) {
      const { clone } = setup()
      writeFile(clone, '営業部/.claude/skills/x/SKILL.md', hooks)
      commitAll(clone)
      const r = push(clone, p)
      expect(r.ok).toBe(false)
      expect(protectedPathsIn(r.output)).toContain('営業部/.claude/skills/x/SKILL.md')
    }
  })

  it('lists a file with auto-run parts once, under its reason', () => {
    const { clone } = setup()
    writeFile(clone, '.claude/skills/x/SKILL.md', '---\nhooks: {}\n---\n')
    writeFile(clone, '.claude/skills/x/run.py', 'x\n')
    commitAll(clone)
    const r = push(clone, MEMBER)
    expect(protectedPathsIn(r.output)).toEqual(['.claude/skills/x/SKILL.md', '.claude/skills/x/run.py'])
  })

  it('look-alikes a Mac folds onto a protected path are refused: ſ (U+017F), K (U+212A), full-width, an invisible character', () => {
    const files = ['.claude/ſkills/report/make.py', '.claude/sKills/report/x.py', '.mcp.jſon', '.claude/hooKs/evil.sh', '.claude/ſettings.json', '.ｃｌａｕｄｅ/commands/c.md', '.cl\u200Daude/agents/a.md', 'x/CLAUDE.md'.replace('A', '\uFF21'), 'ſales/AGENTſ.md']
    const { bare, clone } = setup()
    const before = git(['-C', bare, 'rev-parse', 'main'])
    plant(clone, files)
    const r = push(clone, MEMBER)
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual([...files].sort())
    expect(git(['-C', bare, 'rev-parse', 'main'])).toBe(before)
  })

  it('a look-alike hides no auto-run part from someone on the list', () => {
    const { clone } = setup()
    plant(clone, ['.claude/ſkills/x/SKILL.md'], '---\nhooks: {}\n---\n')
    const r = push(clone, { role: 'member', skillEditing: { everywhere: true, folders: [] } })
    expect(r.ok).toBe(false)
    expect(protectedPathsIn(r.output)).toEqual(['.claude/ſkills/x/SKILL.md'])
  })

  it('a look-alike of a read-only folder is that folder, for the write check too', () => {
    const scopes = [...OPEN_SCOPES, { id: 's', path: 'sales', kind: 'folder', rules: [{ id: 'e', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: false }] }]
    const { clone } = setup({ 'sales/keep.md': 'k\n' })
    plant(clone, ['ſales/new.md'])
    const r = push(clone, { role: 'member', scopes })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[WRITE_DENIED]')
  })

  it('a look-alike of a private folder is that folder: reserved, for everyone', () => {
    const scopes = [...OPEN_SCOPES, { id: 'q', path: 'assets', kind: 'folder', repoId: 'repo-2', rules: [{ id: 'e2', subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false }] }, { id: 'p', path: 'secret', kind: 'folder', repoId: 'repo-1', rules: [{ id: 'e', subjectType: 'everyone', subjectId: null, canRead: false, canWrite: false }] }]
    const { clone } = setup()
    plant(clone, ['ſecret/x.md', 'aẞets/y.md'])
    const r = push(clone, { role: 'owner', scopes })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[RESERVED_PATH]')
  })

  it('a new path a disk folds onto an existing one stops at the collision check, for owners too; files and folders alike', () => {
    for (const [seed, added] of [['docs/secret.md', 'docs/ſecret.md'], ['sales/old.md', 'ſales/new.md'], ['docs/ﬁle.md', 'docs/file.md'], ['docs/Strasse.md', 'docs/Straẞe.md']]) {
      const { clone } = setup({ [seed]: 'real\n' })
      plant(clone, [added])
      const r = push(clone, { role: 'owner' })
      expect(r.ok, added).toBe(false)
      expect(r.output).toContain('[WINPATH_DETECTED]')
      expect(r.output).toContain(added)
    }
  })

  it('names that only look alike on paper stay two files; a Mac\'s NFD and an old pair stop nobody', () => {
    const { clone } = setup({ '資料/見積(1).md': 'a\n', 'ガイド/a.md': 'a\n' })
    // É.md: with a spelling a disk folds in the tree, the comparison really runs.
    plant(clone, ['資料/見積（1）.md', 'ｶﾀﾛｸﾞ.md', 'カタログ.md', `${'ガイド'.normalize('NFD')}/b.md`, 'É.md',
      // What APFS keeps apart, so ordinary names a member may well have.
      '⭐重要.md', '⭐️重要.md', '葛城.pdf', '葛\u{E0100}城.pdf', 'ı.md', 'i.md', 'ab.md', 'a\u200Bb.md'], 'b\n')
    const r = push(clone, MEMBER)
    expect(r.ok, r.output).toBe(true)

    // A pair that reached the repository before this rule: unrelated work goes on.
    const old = setup()
    plant(old.clone, ['É.md', 'é.md'], 'x\n')
    git(['-C', old.bare, 'fetch', '-q', old.clone, '+main:main'])
    plant(old.clone, ['other.md'], 'o\n')
    expect(push(old.clone, MEMBER).ok).toBe(true)

    // A folder pair: a new file inside either one creates nothing new.
    const folders = setup()
    plant(folders.clone, ['Ａ社/a.md', 'ａ社/b.md'], 'x\n')
    git(['-C', folders.bare, 'fetch', '-q', folders.clone, '+main:main'])
    plant(folders.clone, ['Ａ社/new.md', 'notes.md'], 'n\n')
    expect(push(folders.clone, MEMBER).ok).toBe(true)
  })

  it('an app that says it predates the rule is not refused, it would loop; auto-run parts are refused all the same', () => {
    const app: Pusher = { role: 'member', appPredatesSkillRule: true }
    expect(changeAs(app, SCRIPT).ok).toBe(true)
    const { clone } = setup()
    writeFile(clone, '.claude/skills/x/SKILL.md', '---\nhooks: {}\n---\n')
    commitAll(clone)
    expect(push(clone, app).ok).toBe(false)
  })


  it('leaves the rest of .claude and the existing skills alone', () => {
    const { bare, clone } = setup({ [SCRIPT]: 'v1\n' })
    writeFile(clone, '.claude/notes.py', 'mine\n')
    writeFile(clone, 'skills/report/make.py', 'mine\n')
    writeFile(clone, '.claude/skillset/x.py', 'mine\n')
    commitAll(clone)
    const r = push(clone, MEMBER)
    expect(r.ok, r.output).toBe(true)
    expect(git(['-C', bare, 'show', `main:${SCRIPT}`])).toBe('v1\n')
  })

  it('a scope repository judges the path as <private folder>/<path>', () => {
    const scopes = [...OPEN_SCOPES, {
      id: 'p', path: '営業部/評価', kind: 'folder', repoId: 'repo-1',
      rules: [{ id: 'e', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }],
    }]
    const inScope = (p: Partial<Pusher>) => {
      const { clone } = setup({ [SCRIPT]: 'v1\n' })
      writeFile(clone, SCRIPT, 'v2\n')
      commitAll(clone)
      return push(clone, { role: 'member', scopes, scopePath: '営業部/評価', ...p })
    }
    expect(inScope({}).ok).toBe(false)
    expect(inScope({ managedFolders: ['経理部'] }).ok).toBe(false)
    expect(inScope({ managedFolders: ['営業部'] }).ok).toBe(true)
    expect(inScope({ skillEditing: { everywhere: false, folders: ['営業部'] } }).ok).toBe(true)
  })

  it('the server\'s own commit may move skills (a department renamed by an owner); a member cannot claim to be it', () => {
    const { clone } = setup({ [SCRIPT]: 'v1\n' })
    writeFile(clone, SCRIPT, 'v2\n')
    commitAll(clone)
    // A member's push always carries a snapshot, so the marker does not lift the rule.
    const claimed = push(clone, MEMBER, { ACB_INTERNAL_PUSH: '1' })
    expect(claimed.ok).toBe(false)
    expect(protectedPathsIn(claimed.output)).toEqual([SCRIPT])

    const env: NodeJS.ProcessEnv = { ...process.env, ACB_INTERNAL_PUSH: '1', ACB_NODE: process.execPath }
    delete env.ACB_PUSHER_ROLE
    delete env.ACB_PUSH_POLICY
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  })

  it('a push with no role at all, and not the server\'s, fails closed', () => {
    const { clone } = setup({ [SCRIPT]: 'v1\n' })
    writeFile(clone, SCRIPT, 'v2\n')
    commitAll(clone)
    const env: NodeJS.ProcessEnv = { ...process.env, ACB_NODE: process.execPath }
    delete env.ACB_PUSHER_ROLE
    delete env.ACB_PUSH_POLICY
    delete env.ACB_INTERNAL_PUSH
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
    expect(r.status).not.toBe(0)
    expect(protectedPathsIn(`${r.stdout}${r.stderr}`)).toEqual([SCRIPT])
  })
})

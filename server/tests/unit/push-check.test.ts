/**
 * Unit tests for the push checker's pure parts (lib/push-check/rules.ts,
 * policy.ts, report.ts). End-to-end equivalence with the old shell hook is
 * covered by tests/integration/push-check-differential.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  SecretScanner,
  addedGitlinks,
  autorunFindings,
  autorunTargets,
  autorunUnavailable,
  parseRefUpdates,
  instructionFilePaths,
  localOnlyPaths,
  personalPaths,
  protectedPaths,
  utf8Bytes,
  windowsPathProblems,
} from '../../src/lib/push-check/rules'
import { everyoneWritesEverywhere, instructionFileAllowed, parsePushPolicy, reservedAncestorOf, writeGateFor, type PushPolicy } from '../../src/lib/push-check/policy'
import { emptyFindings, renderReport } from '../../src/lib/push-check/report'
import type { ScopeWithRules } from '../../shared/core/permissions'

const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const PAT = ['ghp_', 'a'.repeat(36)].join('')
const OAUTH = ['gho_', 'b'.repeat(36)].join('')
const SK = ['sk-', 'd'.repeat(24)].join('')

describe('path rules (bytewise, A–Z case-insensitive)', () => {
  it('protected config at any depth and case, sorted and unique', () => {
    expect(protectedPaths(['a/.Claude/Settings.json', '.mcp.json', 'x.mcp.json', '.claude', '.claude/hooks/x.sh', '.claude/hooksx', '.mcp.json', ''])).toEqual([
      '.claude', '.claude/hooks/x.sh', '.mcp.json', 'a/.Claude/Settings.json',
    ])
  })

  it('instruction files: CLAUDE.md, CLAUDE.local.md, AGENTS.md at any depth and case', () => {
    expect(instructionFilePaths(['CLAUDE.md', 'a/claude.md', 'b/.claude/CLAUDE.md', 'c/CLAUDE.local.md', 'd/agents.MD', 'notCLAUDE.md', 'CLAUDE.md.bak', 'e/CLAUDE.md/x'])).toEqual([
      'CLAUDE.md', 'a/claude.md', 'b/.claude/CLAUDE.md', 'c/CLAUDE.local.md', 'd/agents.MD',
    ])
  })

  it('local-only folders: .backups/ and .workspace/ content at any depth and case', () => {
    expect(localOnlyPaths(['.backups/2026/x.md', 'a/.Workspace/tmp.txt', '.backupsx/a', 'b/.backups', 'c/backups/a'])).toEqual([
      '.backups/2026/x.md', 'a/.Workspace/tmp.txt',
    ])
  })

  it('a manager may change instruction files inside their department only (NFC, A–Z folded; scope repositories prefixed)', () => {
    const managed = ['人事', 'Sales']
    expect(instructionFileAllowed('人事/CLAUDE.md', managed)).toBe(true)
    expect(instructionFileAllowed(`${'人事'.normalize('NFD')}/sub/AGENTS.md`, managed)).toBe(true)
    expect(instructionFileAllowed('sales/deep/x/CLAUDE.md', managed)).toBe(true)
    expect(instructionFileAllowed('CLAUDE.md', managed)).toBe(false)
    expect(instructionFileAllowed('人事2/CLAUDE.md', managed)).toBe(false)
    expect(instructionFileAllowed('経理/CLAUDE.md', managed)).toBe(false)
    expect(instructionFileAllowed('CLAUDE.md', managed, '人事/評価')).toBe(true)
    expect(instructionFileAllowed('CLAUDE.md', managed, '経理/秘密')).toBe(false)
    expect(instructionFileAllowed('人事/CLAUDE.md', [])).toBe(false)
  })

  it('a non-folder above a reserved path is reported in the pusher\'s spelling', () => {
    const reserved = ['sales/secret', '人事/評価']
    expect(reservedAncestorOf('Sales', reserved)).toBe('Sales')
    expect(reservedAncestorOf('人事', reserved)).toBe('人事')
    expect(reservedAncestorOf('sales/secret', reserved)).toBeNull() // at the path: reservedPrefixOf's case
    expect(reservedAncestorOf('sales2', reserved)).toBeNull()
    expect(reservedAncestorOf('sal', reserved)).toBeNull()
    expect(reservedAncestorOf('x', [])).toBeNull()
  })

  it('.personal content except the .gitignore directly inside', () => {
    expect(personalPaths(['.personal/a', 'x/.PERSONAL/b', 'x/.personal/.gitignore', 'x/.personal/sub/.gitignore', '.personalx/a'])).toEqual([
      '.personal/a', 'x/.PERSONAL/b', 'x/.personal/sub/.gitignore',
    ])
  })

  it('does not fold non-ASCII letters (É/é, Ａ/ａ) — as grep -i / tr under LC_ALL=C', () => {
    const lines = ['É.md', 'é.md', 'Ａ.md', 'ａ.md', 'A.md', 'a.md'].map(utf8Bytes)
    expect(windowsPathProblems(lines)).toEqual([`a.md${utf8Bytes(' （大文字小文字のみ異なるパスが複数存在）')}`])
  })

  it('Windows rules in the hook order', () => {
    const out = windowsPathProblems(['a:b', 'end.', 'CON.txt', 'readme', 'README'])
    expect(out.map(l => l.split(' ')[0])).toEqual(['a:b', 'end.', 'CON.txt', 'readme'])
  })

  it('gitlinks: entries whose new mode is 160000', () => {
    expect(addedGitlinks(':000000 160000 0 a A\tvendor/x\n:100644 100644 b c M\tf\n')).toEqual(['vendor/x'])
  })
})

describe('auto-run detection', () => {
  it('finds frontmatter keys and body openers, ignores look-alikes', () => {
    expect(autorunFindings(Buffer.from('---\n"hooks": 1\n---\n!`date`\n'))).toEqual(['frontmatter の hooks', '!`…` コマンド'])
    expect(autorunFindings(Buffer.from('---\nname: x\n---\nif ! grep; `!` ok !important\n'))).toEqual([])
  })

  it('parses plain and combined raw diffs and skips deletions', () => {
    const raw = Buffer.from([
      ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A', '.claude/skills/a/SKILL.md',
      ':100644 000000 2222222222222222222222222222222222222222 0000000000000000000000000000000000000000 D', '.claude/skills/b/SKILL.md',
      '::100644 100644 120000 3333333333333333333333333333333333333333 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 MM', '.claude/agents/l.md',
      ':000000 100644 0000000000000000000000000000000000000000 5555555555555555555555555555555555555555 A', 'docs/x.md', '',
    ].join('\0'))
    const t = autorunTargets(raw)
    expect([...t.blobsByPath.keys()]).toEqual(['.claude/skills/a/SKILL.md'])
    expect([...t.symlinks]).toEqual(['.claude/agents/l.md'])
    expect(() => autorunTargets(Buffer.from(':000000 100644 0 1 A'))).toThrow()
  })

  it('fails closed with every listed path in those folders', () => {
    expect(autorunUnavailable(':x\0.claude/skills/a/x.sh\0:y\0docs/a.md\0')).toEqual([`.claude/skills/a/x.sh\t${utf8Bytes('内容を確認できませんでした')}`])
  })
})

describe('secret scan', () => {
  const diff = [
    'diff --git a/b.txt b/b.txt', 'new file mode 100644', '--- /dev/null', '+++ b/b.txt', '@@ -0,0 +1,2 @@', `+${AWS} ${PAT}`, `+${PAT}`,
    'diff --git a/with space.md b/with space.md', '--- a/with space.md', '+++ b/with space.md\t', '@@ -1 +1 @@', `+${AWS}`, ` ${PAT}`,
  ]
  it("line mode: first pattern per line, one entry per file × pattern, diff order; names from '+++ b/'", () => {
    const s = new SecretScanner('line')
    diff.forEach(l => s.push(l))
    expect(s.entries()).toEqual(['  - b.txt (AWS Access Key ID)', '  - b.txt (GitHub Personal Access Token)', '  - with space.md (AWS Access Key ID)'])
  })
  it('file mode: lowest pattern per file', () => {
    const s = new SecretScanner('file')
    diff.forEach(l => s.push(l))
    expect(s.entries()).toEqual(['  - b.txt (AWS Access Key ID)', '  - with space.md (AWS Access Key ID)'])
  })
  it('combined diff (merge): only lines added relative to every parent count; several diffs share one dedupe', () => {
    const s = new SecretScanner('line')
    ;[
      'diff --combined m.txt', 'index 1,2..3', '--- a/m.txt', '+++ b/m.txt', '@@@ -1,1 -1,1 +1,3 @@@',
      ` +${AWS}`, `+ ${PAT}`, `++${OAUTH}`, '-  gone',
      // The next diff (a new commit's own) repeats a file × pattern already reported.
      'diff --git a/m.txt b/m.txt', '--- a/m.txt', '+++ b/m.txt', '@@ -1 +1,2 @@', `+${OAUTH}`, `+${AWS}`,
      '@@ -9 +10 @@', `+${SK}`,
    ].forEach(l => s.push(l))
    expect(s.entries()).toEqual([
      '  - m.txt (GitHub OAuth Token)',
      '  - m.txt (AWS Access Key ID)',
      '  - m.txt (OpenAI/Anthropic API Key)',
    ])
  })
})

describe('ref lines', () => {
  it('reads like bash `while read old new ref`', () => {
    expect(parseRefUpdates(' a  b  refs/heads/x \nc d refs/heads/y')).toEqual([{ oldSha: 'a', newSha: 'b', refname: 'refs/heads/x' }])
  })
})

describe('write policy', () => {
  const scope = (id: string, path: string, rules: Array<[ScopeWithRules['rules'][number]['subjectType'], string | null, boolean, boolean]>): ScopeWithRules => ({
    id, path, kind: path === '' ? 'company' : 'folder', departmentId: null, repoId: null,
    rules: rules.map(([subjectType, subjectId, canRead, canWrite], i) => ({ id: `${id}-${i}`, subjectType, subjectId, canRead, canWrite })),
  })
  const open = scope('c', '', [['everyone', null, true, true]])
  const salesRO = scope('s', 'sales', [['everyone', null, true, false], ['user', 'u-boss', true, true]])
  const policy = (pusher: PushPolicy['pusher'], scopes: ScopeWithRules[]): PushPolicy => ({ version: 1, companyId: 'c1', pusher, scopes })

  it('the default rules allow everything without listing paths', () => {
    expect(writeGateFor(policy({ id: 'u', role: 'member' }, [open])).kind).toBe('allow-all')
    expect(everyoneWritesEverywhere([open])).toBe(true)
    expect(everyoneWritesEverywhere([open, salesRO])).toBe(false)
    expect(everyoneWritesEverywhere([])).toBe(false)
  })

  it('owner/admin always write; members per resolveAccess; A–Z case variants count as the folder', () => {
    expect(writeGateFor(policy({ id: 'o', role: 'owner' }, [open, salesRO])).kind).toBe('allow-all')
    const gate = writeGateFor(policy({ id: 'u', role: 'member' }, [open, salesRO]))
    if (gate.kind !== 'check') throw new Error(gate.kind)
    expect(gate.canWrite('other/a.md')).toBe(true)
    expect(gate.canWrite('sales/a.md')).toBe(false)
    expect(gate.canWrite('SALES/a.md')).toBe(false)
    expect(gate.canWrite('salesx/a.md')).toBe(true)
    expect(writeGateFor(policy({ id: 'u-boss', role: 'member' }, [open, salesRO])).kind).toBe('allow-all')
  })

  it('no pusher: deny everything unless writing is open to everyone', () => {
    expect(writeGateFor(policy(null, [open])).kind).toBe('allow-all')
    expect(writeGateFor(policy(null, [open, salesRO])).kind).toBe('deny-all')
    expect(writeGateFor(policy({ id: 'gone', role: null }, [open, salesRO])).kind).toBe('deny-all')
  })

  it('two scopes differing only in A–Z case: the one sorting first decides, whatever order the database returns', () => {
    const lower = scope('l', 'café', [['everyone', null, true, true]])
    const upper = scope('u', 'Café', [['everyone', null, true, false]])
    for (const scopes of [[open, lower, upper], [open, upper, lower]]) {
      const gate = writeGateFor(policy({ id: 'u', role: 'member' }, scopes))
      if (gate.kind !== 'check') throw new Error(gate.kind)
      // Folded, both are "café"; "Café" sorts first (code unit order) and is read-only.
      expect(gate.canWrite('café/a.md')).toBe(false)
      expect(gate.canWrite('Café/a.md')).toBe(false)
      expect(gate.canWrite('other/a.md')).toBe(true)
    }
  })

  it('a company without rules denies members (no-rule), as resolveAccess does', () => {
    const gate = writeGateFor(policy({ id: 'u', role: 'member' }, [scope('c', '', [])]))
    expect(gate.kind === 'check' && gate.canWrite('a.md')).toBe(false)
  })

  it('rejects malformed snapshots', () => {
    for (const bad of ['', '{}', '{"version":2}', '{"version":1,"companyId":"c","pusher":null,"scopes":[{"id":"s","path":"","rules":[{"subjectType":"god"}]}]}']) {
      expect(() => parsePushPolicy(bad)).toThrow()
    }
    expect(parsePushPolicy(JSON.stringify(policy(null, [open]))).scopes[0].rules[0].canWrite).toBe(true)
  })
})

describe('report', () => {
  it('prints WRITE_DENIED with "  - " path lines and explanation lines that do not start with "- "', () => {
    const out = renderReport({ ...emptyFindings(), writeDenied: 'sales/a.md\nsales/b.md\n\nsales/a.md\n' })!.toString('utf8').split('\n')
    const start = out.indexOf('[WRITE_DENIED] 変更する権限のないファイルが含まれています')
    expect(start).toBeGreaterThan(0)
    expect(out.filter(l => l.startsWith('  - '))).toEqual(['  - sales/a.md', '  - sales/b.md'])
    expect(out.filter(l => l.trim().startsWith('- ') && !l.startsWith('  - '))).toEqual([])
    expect(renderReport(emptyFindings())).toBeNull()
  })

  it('prints LOCAL_ONLY_PATH like PERSONAL_PATH, and instruction files inside the PROTECTED_CONFIG section', () => {
    const out = renderReport({ ...emptyFindings(), localOnly: '.backups/a.md\n', instructions: 'CLAUDE.md\n' })!.toString('utf8').split('\n')
    const local = out.findIndex(l => l.startsWith('[LOCAL_ONLY_PATH]'))
    const prot = out.findIndex(l => l.startsWith('[PROTECTED_CONFIG]'))
    expect(local).toBeGreaterThan(0)
    expect(prot).toBeGreaterThan(local)
    // each path inside its own section (what the apps parse: "- " lines up to the second separator)
    const section = (start: number) => {
      const lines: string[] = []
      let seps = 0
      for (const l of out.slice(start + 1)) {
        if (/^=+$/.test(l)) { if (++seps === 2) break; continue }
        if (l.trim().startsWith('- ')) lines.push(l.trim().slice(2))
      }
      return lines
    }
    expect(section(local)).toEqual(['.backups/a.md'])
    expect(section(prot)).toEqual(['CLAUDE.md'])
  })
})

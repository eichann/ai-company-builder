// Rule parity: the name and path rules that exist as separate copies in the
// server, the desktop app and the admin console must agree on one corpus.
// One table test per rule; each copy is the production code (imported, or —
// for constants private to a React component or a route module that opens
// the database at import — the regex literal read from its source).
//
//   path key (NFC + A–Z fold)  client write-access / sparse-paths, shared
//                              normalizeReservedPath, server private-folders
//                              pathKey, push-check policy reservedKey, push-check
//                              rules foldAsciiCase (bytewise, latin1 — by design)
//   department folder names    server routes/departments.ts, admin lib/folder-name.ts,
//                              client NewFolderDialog.tsx
//   skill folder names         client NewSkillWizard.tsx, CopySkillModal.tsx
//   AI instruction files       client write-guard.ts vs push-check rules.ts / policy.ts
//
// Intended differences are pinned explicitly (and explained) so that a
// refactor which merges the copies (R2, one shared core) keeps them or
// removes them on purpose.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldAsciiCase as clientFold, normalizeRepoPath } from '../shared/write-access'
import { pathKey as sparsePathKey } from '../shared/sparse-paths'
import { editorOverwriteBackupPlan } from '../shared/editor-disk-state'
import { normalizeReservedPath } from '../../shared/types/private-folders'
import { pathKey as serverPathKey } from '../../server/src/lib/private-folders'
import { instructionFileAllowed, reservedKey } from '../../server/src/lib/push-check/policy'
import { foldAsciiCase as hookFold, INSTRUCTION_FILE_RE } from '../../server/src/lib/push-check/rules'
import * as adminFolderNameModule from '../../admin/src/lib/folder-name'
import { isInstructionFile, mayChangeInstructionFile } from '../electron/write-guard'

// admin/ is a CommonJS-typed package: tsx exposes its named exports on `default`.
const adminFolderName: (s: string) => boolean = (adminFolderNameModule as unknown as { default?: typeof adminFolderNameModule }).default?.isValidFolderName
  ?? adminFolderNameModule.isValidFolderName

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A regex literal from a source file (group 1 of `pattern`), as the code compiles it. */
function regexFromSource(rel: string, pattern: RegExp): RegExp {
  const m = readFileSync(join(repo, rel), 'utf8').match(pattern)
  assert.ok(m, `${rel}: the rule's regex was not found (moved? update this test to import it)`)
  return new Function(`return ${m[1]}`)() as RegExp
}

// ---------------------------------------------------------------------------
// Path key: NFC + A–Z only
// ---------------------------------------------------------------------------

const PATHS = [
  '営業部/提案書.md', 'Sales/Q1/Report.MD', 'sales/q1/report.md', 'SALES', 'がいど/ガイド',
  'がいど/ガイド'.normalize('NFD'), 'Café/É/é', 'Café/É'.normalize('NFD'), 'ｓａｌｅｓ/Ｓａｌｅｓ', 'Σίσυφος/ΣΑΣ',
  'İstanbul/ı', 'Kelvin/K', 'ß/ẞ', '.claude/Skills/My-Skill/SKILL.md', 'a/b/c/d/e/f/g/h', '人事/評価/2026 年度/Ａ.xlsx',
]

test('path keys: every copy computes the same NFC + A–Z-folded key', () => {
  for (const p of PATHS) {
    const expected = p.normalize('NFC').replace(/[A-Z]/g, c => c.toLowerCase())
    const keys: Record<string, string> = {
      'client normalizeRepoPath + foldAsciiCase': clientFold(normalizeRepoPath(p) ?? '<null>'),
      'client sparse-paths pathKey': sparsePathKey(p),
      'shared normalizeReservedPath': normalizeReservedPath(p),
      'server private-folders pathKey': serverPathKey(p),
      'server push-check reservedKey': reservedKey(p),
      // The push checker folds git's raw bytes read as latin1 (LC_ALL=C): UTF-8
      // multi-byte sequences never contain 0x41–0x5A, so on NFC input it is the
      // same function. It does not NFC-normalise: git hands it the bytes as pushed.
      'server push-check foldAsciiCase (bytewise)': Buffer.from(hookFold(Buffer.from(p.normalize('NFC'), 'utf8').toString('latin1')), 'latin1').toString('utf8'),
    }
    for (const [copy, key] of Object.entries(keys)) assert.equal(key, expected, `${copy}(${JSON.stringify(p)})`)
  }
})

test('path keys: the intended differences between the copies', () => {
  // Backslashes: the client and the paths/check contract treat '\\' as a
  // separator (paths typed on Windows); the server's own keys only see paths
  // git produced, which never contain one as a separator.
  assert.equal(normalizeReservedPath('a\\B'), 'a/b')
  assert.equal(clientFold(normalizeRepoPath('a\\B')!), 'a/b')
  assert.equal(serverPathKey('a\\B'), 'a\\b')
  assert.equal(reservedKey('a\\B'), 'a\\b')
  // '.' / '..': the client's path normaliser refuses them; key functions keep them.
  assert.equal(normalizeRepoPath('a/../b'), null)
  assert.equal(serverPathKey('a/../b'), 'a/../b')
  // The push checker is bytewise: an NFD name is NOT the same key as its NFC
  // spelling there (everything else normalises first).
  const nfd = 'がいど'.normalize('NFD')
  assert.notEqual(hookFold(Buffer.from(nfd, 'utf8').toString('latin1')), hookFold(Buffer.from('がいど', 'utf8').toString('latin1')))
  // A local-only copy folds full Unicode case (toLowerCase), not A–Z only:
  // deciding where the editor keeps an overwrite backup it treats "É" as "é"
  // — over-inclusive (the private backup location), never the other way.
  const plan = (privateFolder: string, file: string) => editorOverwriteBackupPlan({
    rootPath: '/c', filePath: `/c/${file}`, privateFolders: [privateFolder], insideNestedRepo: false, now: new Date(0),
  })
  for (const p of PATHS) {
    const r = plan(p, `${p.replace(/[A-Z]/g, c => c.toLowerCase())}/x.md`)
    assert.ok('privateFolder' in r && r.privateFolder, `A–Z variants agree with the shared key: ${p}`)
  }
  const unicode = plan('É', 'é/x.md')
  assert.ok('privateFolder' in unicode && unicode.privateFolder, 'editor backup plan folds É/é (Unicode lowercase)')
  assert.notEqual(serverPathKey('É'), serverPathKey('é'), 'the shared rule does not')
})

// ---------------------------------------------------------------------------
// Department folder names (also private folder names: the server uses the same rule)
// ---------------------------------------------------------------------------

const FOLDER_NAMES: Array<[string, boolean]> = [
  ['営業部', true], ['sales', true], ['Sales-2026.v1', true], ['dev_team', true], ['0start', true], ['_x', true],
  ['ひらがな', true], ['カタカナー', true], ['漢字', true], ['ゟ', true], ['ヿ', true], ['鿿', true], ['぀', true], ['゠', true], ['一', true],
  ['.hidden', false], ['-x', false], ['a b', false], ['a/b', false], ['', false], ['営業 部', false], ['a\\b', false],
  ['ｓａｌｅｓ', false], ['Ａ', false], ['㐀', false], ['\uF900', false], ['café', false], ['ＡＢ', false], ['a\n', false],
  ['ﾃｽﾄ', false], ['🙂', false], ['〜', false], ['・', true], ['x.', true], ['々', false],
]

test('department folder names: server, admin and the app accept exactly the same names', () => {
  const copies: Record<string, (s: string) => boolean> = {
    'server routes/departments.ts isValidFolderName': (s) => regexFromSource('server/src/routes/departments.ts',
      /export function isValidFolderName\(folder: string\): boolean \{\s*return (\/.+\/[a-z]*)\.test\(folder\)/).test(s),
    'admin lib/folder-name.ts isValidFolderName': adminFolderName,
    'client NewFolderDialog.tsx FOLDER_RE': (s) => regexFromSource('client/src/components/skill-ui/NewFolderDialog.tsx',
      /const FOLDER_RE = (\/.+\/[a-z]*)\n/).test(s),
  }
  for (const [name, expected] of FOLDER_NAMES) {
    for (const [copy, accepts] of Object.entries(copies)) {
      assert.equal(accepts(name), expected, `${copy}(${JSON.stringify(name)})`)
    }
  }
})

// ---------------------------------------------------------------------------
// Skill folder names
// ---------------------------------------------------------------------------

const SKILL_NAMES: Array<[string, boolean]> = [
  ['my-skill', true], ['skill_2', true], ['0abc', true], ['a', true], ['a'.repeat(50), true],
  ['My-Skill', false], ['-skill', false], ['_skill', false], ['skill.md', false], ['my skill', false], ['', false],
  ['スキル', false], ['ｓｋｉｌｌ', false], ['skill/sub', false], ['café', false],
]

test('skill folder names: the wizard and the copy dialog agree', () => {
  const copies: Record<string, (s: string) => boolean> = {
    'NewSkillWizard.tsx isValidFolderName': (s) => regexFromSource('client/src/components/skill-ui/NewSkillWizard.tsx',
      /function isValidFolderName\(name: string\): boolean \{\s*return (\/.+\/[a-z]*)\.test\(name\)/).test(s),
    'CopySkillModal.tsx isValidFolderName': (s) => regexFromSource('client/src/components/skill-ui/CopySkillModal.tsx',
      /function isValidFolderName\(name: string\): boolean \{\s*return (\/.+\/[a-z]*)\.test\(name\)/).test(s),
  }
  for (const [name, expected] of SKILL_NAMES) {
    for (const [copy, accepts] of Object.entries(copies)) assert.equal(accepts(name), expected, `${copy}(${JSON.stringify(name)})`)
  }
})

// ---------------------------------------------------------------------------
// AI instruction files (CLAUDE.md, CLAUDE.local.md, AGENTS.md)
// ---------------------------------------------------------------------------

test('AI instruction files: the chat guard and the push check name the same files and the same managers', () => {
  const files = [
    'CLAUDE.md', 'claude.md', 'Claude.MD', 'CLAUDE.local.md', 'claude.LOCAL.md', 'AGENTS.md', 'agents.md', '営業部/CLAUDE.md',
    'a/b/c/AGENTS.md', 'CLAUDE.md.bak', 'MY-CLAUDE.md', 'CLAUDE.markdown', 'CLAUDE', 'ＣＬＡＵＤＥ.md', 'AGENT.md', 'claude.md/x.txt',
    'CLAUDE.local.md.txt', 'docs/agents.MD',
  ]
  for (const f of files) {
    // The push checker matches git's bytes read as latin1.
    const server = INSTRUCTION_FILE_RE.test(Buffer.from(f, 'utf8').toString('latin1'))
    assert.equal(isInstructionFile(f), server, `isInstructionFile(${JSON.stringify(f)})`)
  }
  const managed = ['営業部', 'Dev', 'がいど'.normalize('NFD')]
  const paths = [
    'CLAUDE.md', '営業部/CLAUDE.md', '営業部/提案/AGENTS.md', '営業部2/CLAUDE.md', 'dev/CLAUDE.md', 'DEV/x/CLAUDE.md',
    'Dev/CLAUDE.md', 'がいど/CLAUDE.md', 'がいど'.normalize('NFD') + '/x/CLAUDE.md', '人事/CLAUDE.md', '営業/CLAUDE.md',
  ]
  for (const p of paths) {
    const client = mayChangeInstructionFile({ role: 'member', managedFolders: managed }, p)
    assert.equal(client, instructionFileAllowed(p, managed), `manager of ${managed.join(', ')} changes ${JSON.stringify(p)}`)
  }
  for (const role of ['owner', 'admin']) assert.equal(mayChangeInstructionFile({ role, managedFolders: [] }, 'CLAUDE.md'), true)
})

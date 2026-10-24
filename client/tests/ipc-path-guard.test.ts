// Every IPC handler that takes a local path checks it against the allowed
// roots (electron/allowed-roots.ts, `AllowedRoots.validate`: inside a company
// folder by name AND by real location). Splitting main.ts into modules must
// keep that true for every handler, including ones added later:
//
//  - each handler parameter whose name says path / root / folder / dir (from
//    the IPC inventory, i.e. the source as written) must be listed below:
//    GUARDED (an absolute local path the handler validates) or EXEMPT (not a
//    local path to check, with the reason);
//  - each GUARDED parameter is called with a path outside every root, the
//    others with valid values inside one, and `AllowedRoots.validate` must
//    have been asked about that exact path — and the handler must not report
//    success.
//
// The per-handler failure values are pinned in ipc-fs.test.ts / ipc-git.test.ts.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadMain, writeFiles, type MainHarness } from './ipc-harness/main-harness.ts'
import { staticMainChannels } from './ipc-harness/inventory.ts'
import { AllowedRoots } from '../electron/allowed-roots.ts'

/** A valid path inside the registered root (replaced per call). */
const IN = Symbol('inside')
const IN_FILE = Symbol('inside file')

/** channel → its arguments (IN = a folder inside the root) and the indexes that are checked local paths. */
const GUARDED: Record<string, { args: unknown[]; paths: number[] }> = {
  'fs:readDirectory': { args: [IN], paths: [0] },
  'fs:readDirectoryTree': { args: [IN, 2], paths: [0] },
  'fs:readFile': { args: [IN_FILE], paths: [0] },
  'fs:readFileBinary': { args: [IN_FILE], paths: [0] },
  'fs:writeFile': { args: [IN_FILE, 'x'], paths: [0] },
  'fs:createDirectory': { args: [IN], paths: [0] },
  'fs:exists': { args: [IN], paths: [0] },
  'fs:delete': { args: [IN_FILE], paths: [0] },
  'fs:rename': { args: [IN_FILE, IN_FILE], paths: [0, 1] },
  'fs:move': { args: [IN_FILE, IN_FILE], paths: [0, 1] },
  'fs:copy': { args: [IN_FILE, IN_FILE], paths: [0, 1] },
  'fs:moveFromExternal': { args: [IN_FILE, IN_FILE], paths: [1] },
  'fs:stat': { args: [IN], paths: [0] },
  'fs:watch': { args: [IN], paths: [0] },
  'fs:unwatch': { args: [IN], paths: [0] },
  'fs:startDrag': { args: [IN_FILE], paths: [0] },
  'editor:backupBeforeOverwrite': { args: [IN, IN_FILE], paths: [0, 1] },
  'env:read': { args: [IN], paths: [0] },
  'env:write': { args: [IN, { A: '1' }], paths: [0] },
  'privateFolders:reservedPathRefusal': { args: [IN_FILE], paths: [0] },
  'git:sync': { args: [IN, 'co', 'msg'], paths: [0] },
  'git:preview': { args: [IN], paths: [0] },
  'git:generateSummary': { args: [IN], paths: [0] },
  'git:revertFile': { args: [IN, 'a.txt', 'modified'], paths: [0] },
  'git:fileDiff': { args: [IN, 'a.txt', 'modified'], paths: [0] },
  'git:commitFileDiff': { args: [IN, 'abcdef0', 'a.txt'], paths: [0] },
  'git:listFiles': { args: [IN, ''], paths: [0] },
  'git:grep': { args: [IN, 'q', ''], paths: [0] },
  'git:log': { args: [IN, '', 5], paths: [0] },
  'git:showCommit': { args: [IN, 'abcdef0', ''], paths: [0] },
  'git:setupCompanyRemote': { args: [IN, 'co', []], paths: [0] },
  'git:inspectCompanyFolder': { args: [IN, 'co'], paths: [0] },
  'git:sparseGetExclusions': { args: [IN], paths: [0] },
  'git:sparseSetExclusions': { args: [IN, []], paths: [0] },
  'git:sparseUncommittedChanges': { args: [IN, []], paths: [0] },
  'git:folderSizes': { args: [IN, '', '', []], paths: [0] },
  'backup:list': { args: [IN], paths: [0] },
  'backup:restore': { args: [IN, 'b', 'a.txt'], paths: [0] },
  'backup:openFolder': { args: [IN], paths: [0] },
  'skills:list': { args: [IN, '', 'd'], paths: [0] },
  'skills:publish': { args: [IN, 'x/.claude/skills/s/'], paths: [0] },
  'skills:makePrivate': { args: [IN, 'x/.claude/skills/s/'], paths: [0] },
  'skills:toggleNurturing': { args: [IN_FILE, true], paths: [0] },
  'tools:start': { args: [IN, 'dev'], paths: [0] },
}

/** Parameters named like a path that are not a local path to check (channel → parameter → why). */
const EXEMPT: Record<string, Record<string, string>> = {
  'fs:registerAllowedRoot': { dirPath: 'adds a root (the company folder the member chose); nothing is read or written' },
  'fs:moveFromExternal': { sourcePath: 'a Finder drop comes from outside by design; only the destination is checked' },
  'tools:stop': { toolPath: 'only a key into the tools tools:start started (after validating); nothing on disk is touched' },
  'backup:restore': { filePath: 'relative to the backup and the repository; both joined paths are checked' },
  'git:revertFile': { filePath: 'a repository pathspec; a new file is checked after joining' },
  'git:fileDiff': { filePath: 'a repository pathspec; a new file is checked after joining' },
  'git:commitFileDiff': { filePath: 'a repository pathspec' },
  'git:listFiles': { folderPath: 'a folder inside the repository (git-search.ts normalizeSearchFolder)' },
  'git:grep': { folderPath: 'a folder inside the repository (git-search.ts normalizeSearchFolder)' },
  'git:log': { folderPath: 'a repository pathspec' },
  'git:showCommit': { folderPath: 'a repository pathspec' },
  'git:setupCompanyRemote': { selectedPaths: 'department folder names to download' },
  'git:folderSizes': { folder: 'a repository folder sent to the server' },
  'git:sparseUncommittedChanges': { folders: 'repository folders (git pathspecs)' },
  'privateFolders:createContext': { parentPath: 'a company-relative folder sent to the server' },
  'skills:list': { departmentFolder: 'a department folder under the checked root' },
  'skills:publish': { skillRelativePath: 'a .gitignore line (one line, checked), not a file access' },
  'skills:makePrivate': { skillRelativePath: 'a .gitignore line (one line, checked), not a file access' },
}

const PATH_LIKE = /path|root|folder|dir/i

/** Parameter names of a handler as written (`a: string, b?: X = 1` → a, b). */
function paramNames(params: string): string[] {
  if (params.startsWith('<')) return [] // a function reference, not an inline handler
  const names: string[] = []
  let depth = 0
  let current = ''
  for (const ch of params) {
    if ('{[(<'.includes(ch)) depth++
    if ('}])>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { names.push(current); current = '' } else current += ch
  }
  if (current.trim()) names.push(current)
  return names.map(p => p.trim().split(/[?:=\s]/)[0])
}

let h: MainHarness
let root: string
before(async () => {
  h = await loadMain()
  root = h.companyDir('guard')
  writeFiles(root, { 'a.txt': 'a' })
  await h.invoke('fs:registerAllowedRoot', root)
})
after(() => h.shutdown())

test('every path-like handler parameter is either checked against the allowed roots or exempt with a reason', () => {
  const main = staticMainChannels()
  const found: string[] = []
  for (const [channel, { params }] of [...Object.entries(main.handle), ...Object.entries(main.on)]) {
    paramNames(params).forEach((name, index) => {
      if (!PATH_LIKE.test(name)) return
      found.push(`${channel} ${name}`)
      const guarded = GUARDED[channel]?.paths.includes(index)
      const exempt = EXEMPT[channel]?.[name]
      assert.ok(guarded || exempt, `${channel}: parameter ${index} '${name}' looks like a path. Validate it (allowed roots) and add it to GUARDED in this test, or add it to EXEMPT with the reason.`)
      assert.ok(!(guarded && exempt), `${channel} '${name}' is both GUARDED and EXEMPT`)
    })
  }
  // No stale entries: every listed channel still exists.
  for (const channel of [...Object.keys(GUARDED), ...Object.keys(EXEMPT)]) {
    assert.ok(main.handle[channel] || main.on[channel], `${channel} is listed here but no longer registered`)
  }
  assert.ok(found.length > 50)
})

test('each guarded parameter reaches AllowedRoots.validate, and an outside path is refused', async () => {
  const seen: string[] = []
  const original = AllowedRoots.prototype.validate
  AllowedRoots.prototype.validate = function (this: AllowedRoots, inputPath, options) {
    seen.push(inputPath)
    return original.call(this, inputPath, options)
  }
  try {
    const outside = path.join(h.base, 'outside-guard')
    for (const [channel, { args, paths }] of Object.entries(GUARDED)) {
      for (const index of paths) {
        const probe = path.join(outside, channel.replace(/[^a-zA-Z]/g, '_'), String(index))
        const callArgs = args.map((a, i) => i === index ? probe : a === IN ? root : a === IN_FILE ? path.join(root, 'a.txt') : a)
        seen.length = 0
        let result: unknown
        try {
          result = h.fake.handlers.has(channel) ? await h.invoke(channel, ...callArgs) : h.send(channel, ...callArgs)
        } catch (error) {
          result = error
        }
        assert.ok(seen.includes(probe), `${channel}: argument ${index} never reached AllowedRoots.validate`)
        const succeeded = result === true || (typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true)
        assert.ok(!succeeded, `${channel}: an outside path in argument ${index} succeeded: ${JSON.stringify(result)}`)
      }
    }
  } finally {
    AllowedRoots.prototype.validate = original
  }
})

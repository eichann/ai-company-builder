import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bashWriteTargets, decideToolWrite, type WriteGuard } from '../electron/write-guard'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import type { WriteAccess } from '../shared/write-access'
import type { claudeCode } from 'ai-sdk-provider-claude-code'

const ROOT = '/Users/me/会社'
const ACCESS: WriteAccess = { version: 'v1', role: 'member', all: false, scopes: [
  { path: '', write: true },
  { path: '営業部', write: false },
  { path: '営業部/下書き', write: true },
  { path: 'Sales', write: false },
] }
const guard = (access: WriteAccess | undefined = ACCESS): WriteGuard => ({ root: ROOT, getAccess: () => access })
const CWD = `${ROOT}/営業部`

test('Write / Edit / MultiEdit / NotebookEdit to a read-only folder are denied with the Japanese reason', () => {
  for (const [tool, key] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']] as const) {
    const d = decideToolWrite(guard(), tool, { [key]: `${ROOT}/営業部/契約書/a.md` }, CWD)
    assert.equal(d.deny, true, tool)
    if (d.deny) {
      assert.equal(d.path, '営業部/契約書/a.md')
      assert.equal(d.folder, '営業部')
      assert.match(d.message, /^このフォルダ（営業部）は閲覧のみのため、編集できません。/)
    }
  }
})

test('allowed paths, nested exceptions and paths outside the company are not blocked', () => {
  const g = guard()
  assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/総務/a.md` }, CWD).deny, false)
  assert.equal(decideToolWrite(g, 'Edit', { file_path: `${ROOT}/営業部/下書き/a.md` }, CWD).deny, false) // deeper scope allows
  assert.equal(decideToolWrite(g, 'Write', { file_path: '/tmp/out.md' }, CWD).deny, false)
  assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/../elsewhere/営業部/a.md` }, CWD).deny, false)
  assert.equal(decideToolWrite(g, 'Read', { file_path: `${ROOT}/営業部/a.md` }, CWD).deny, false)
  assert.equal(decideToolWrite(g, 'Write', {}, CWD).deny, false)
})

test('relative paths, ../ traversal, case and NFD variants resolve to the folder they land in', () => {
  const g = guard()
  assert.equal(decideToolWrite(g, 'Write', { file_path: 'a.md' }, CWD).deny, true) // relative to cwd (営業部)
  assert.equal(decideToolWrite(g, 'Write', { file_path: '下書き/a.md' }, CWD).deny, false)
  assert.equal(decideToolWrite(g, 'Write', { file_path: '../営業部/a.md' }, `${ROOT}/総務`).deny, true)
  assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/営業部/下書き/../契約書/a.md` }, CWD).deny, true)
  assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/sales/a.md` }, CWD).deny, true) // A–Z case variant
  assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/営業部/a.md`.normalize('NFD') }, CWD).deny, true)
  assert.equal(decideToolWrite(g, 'Write', { file_path: 'a.md' }, ROOT).deny, false)
})

test('unknown access, owner/admin (all) and no guard never block', () => {
  const target = { file_path: `${ROOT}/営業部/a.md` }
  assert.equal(decideToolWrite({ root: ROOT, getAccess: () => undefined }, 'Write', target, CWD).deny, false)
  assert.equal(decideToolWrite(guard({ version: 'v', role: 'owner', all: true, scopes: [] }), 'Write', target, CWD).deny, false)
  assert.equal(decideToolWrite(undefined, 'Write', target, CWD).deny, false)
})

test('Bash: literal redirections and tee into a read-only folder are denied, the rest is left alone', () => {
  const g = guard()
  const deny = (command: string, cwd = ROOT) => decideToolWrite(g, 'Bash', { command }, cwd).deny
  assert.equal(deny('echo hi > 営業部/a.md'), true)
  assert.equal(deny('echo hi >> "営業部/契約書/a b.md"'), true)
  assert.equal(deny(`cat x | tee -a ${ROOT}/営業部/log.txt`), true)
  assert.equal(deny('echo hi &> 営業部/a.log'), true)
  assert.equal(deny('echo hi > a.md', CWD), true)
  assert.equal(deny('echo hi > 営業部/下書き/a.md'), false)
  assert.equal(deny('echo hi > 総務/a.md'), false)
  assert.equal(deny('ls 営業部 2>&1 > /dev/null'), false)
  assert.equal(deny('python3 -c "print(1 > 0)"', CWD), false) // quoted '>' is not a redirection
  assert.equal(deny('cat 営業部/a.md | grep x'), false)
  assert.equal(deny('cd /tmp && echo hi > a.md', CWD), false) // cwd changes: not judged
  assert.equal(deny('echo hi > $OUT', CWD), false) // expansions: not judged
})

test('bashWriteTargets', () => {
  assert.deepEqual(bashWriteTargets('a > b; c >> "d e" 2> f'), ['b', 'd e', 'f'])
  assert.deepEqual(bashWriteTargets('x | tee -a one two'), ['one', 'two'])
  assert.deepEqual(bashWriteTargets("cat <<'EOF' > out.md\nline > not-a-target\nEOF"), ['out.md'])
  assert.deepEqual(bashWriteTargets('[[ a > b ]]'), [])
  assert.deepEqual(bashWriteTargets('echo $((1 > 0))'), [])
  assert.deepEqual(bashWriteTargets('echo hi > /dev/null'), [])
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Options = any

test('the Claude Code PreToolUse hook denies a read-only write before the tool runs', async () => {
  const calls: Options[] = []
  const factory = ((_: string, options: Options) => { calls.push(options); return {} }) as unknown as typeof claudeCode
  const base: ClaudeConnectionConfig = {
    getPermissionMode: () => 'bypassPermissions',
    isClaudeCodeAuthenticated: () => true,
    getClaudeCodeCliPath: () => '/test/claude',
    getShellEnv: () => ({}),
  }
  createClaudeConnection(base, factory).createChatModel({ workingDirectory: CWD, writeGuard: guard() })
  const hook = calls[0].hooks.PreToolUse[0].hooks[0]
  const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `${ROOT}/営業部/契約書/a.md` }, cwd: CWD })
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^このフォルダ（営業部）は閲覧のみのため、編集できません。編集が必要な場合はフォルダの管理者に依頼してください。別の場所に保存する場合は、ユーザーに確認してください。$/)
  // Relative to the hook's cwd, not ours.
  assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.md' }, cwd: `${ROOT}/総務` })).hookSpecificOutput, undefined)
  // Allowed: left to the permission mode (no decision).
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/営業部/下書き/a.md` }, cwd: CWD }), { continue: true })
  // Without a guard (unknown company / Codex-style callers) nothing changes.
  createClaudeConnection(base, factory).createChatModel({ workingDirectory: CWD })
  assert.deepEqual(await calls[1].hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${ROOT}/営業部/a.md` }, cwd: CWD }), { continue: true })
})

test('a folder that is not downloaded refuses writes — even with full or unknown access — with its own message', () => {
  const notDownloaded = ['コンテンツ/動画', 'Media/Raw']
  for (const access of [undefined, { version: 'v', role: 'owner', all: true, scopes: [] }, ACCESS] as Array<WriteAccess | undefined>) {
    const g: WriteGuard = { root: ROOT, getAccess: () => access, getNotDownloaded: () => notDownloaded }
    const d = decideToolWrite(g, 'Write', { file_path: `${ROOT}/コンテンツ/動画/編集/a.md` }, ROOT)
    assert.equal(d.deny, true)
    if (d.deny) {
      assert.equal(d.folder, 'コンテンツ/動画')
      assert.equal(d.message, 'このフォルダ（コンテンツ/動画）はダウンロードしていないため、ここには保存できません。必要ならユーザーに設定でダウンロードしてもらってください。')
    }
    assert.equal(decideToolWrite(g, 'Edit', { file_path: 'media/raw/take.md' }, ROOT).deny, true) // A–Z case variant
    assert.equal(decideToolWrite(g, 'NotebookEdit', { notebook_path: '動画/x.ipynb' }, `${ROOT}/コンテンツ`).deny, true)
    assert.equal(decideToolWrite(g, 'Bash', { command: `cat a > ${ROOT}/コンテンツ/動画/out.md` }, ROOT).deny, true)
    assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/コンテンツ/動画編集/a.md` }, ROOT).deny, false) // sibling
    assert.equal(decideToolWrite(g, 'Write', { file_path: `${ROOT}/コンテンツ/top.md` }, ROOT).deny, false)
  }
  // Nothing excluded → only the access decides.
  assert.equal(decideToolWrite({ root: ROOT, getAccess: () => undefined, getNotDownloaded: () => [] }, 'Write', { file_path: `${ROOT}/コンテンツ/動画/a.md` }, ROOT).deny, false)
})

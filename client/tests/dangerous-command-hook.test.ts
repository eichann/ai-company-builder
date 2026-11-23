// The commands Claude Code's PreToolUse hook asks the member about (client/shared/dangerous-commands.ts,
// moved there from agents/claude.ts on 2026-11-23 so the banner's words come from the same list):
// every entry, sent through the real hook, still asks before it runs, and none was dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeConnection, type ClaudeConnectionConfig } from '../electron/agents/claude'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { DANGEROUS_COMMANDS } from '../shared/dangerous-commands'
import { approvalWordsOf } from '../shared/tool-approval-words'

/** One command per entry of DANGEROUS_COMMANDS, in the same order. */
const EXAMPLES = [
  'rm old.md',
  'unlink old.md',
  'shred -u secret.txt',
  'find . -name "*.tmp" -delete',
  'find . -name "*.tmp" -exec rm {} \\;',
  'python3 -c "import os; os.remove(\'a\')"',
  'python3 -c "import os; os.unlink(\'a\')"',
  'python3 -c "import shutil; shutil.rmtree(\'d\')"',
  'python3 -c "import pathlib; pathlib.Path(\'a\').unlink()"',
  'node -e "const fs = require(\'fs\'); fs.unlinkSync(\'a\')"',
  'node -e "fs.rm(\'d\', () => {})"',
  'node -e "fs.rmdirSync(\'d\')"',
  'git reset --hard HEAD~1',
  'git push --force origin main',
  'git push -f origin main',
  'git clean -fd',
  'chmod 777 report.md',
  'mkfs.ext4 /dev/sdb1',
  'dd if=/dev/zero of=disk.img bs=1m count=1',
  'echo x > /etc/hosts',
]

type Ask = [toolName: string, toolInput: Record<string, unknown>, toolUseId: string, appSessionId?: string, reason?: string]

function hookAsking(answer: boolean) {
  const asked: Ask[] = []
  const config: ClaudeConnectionConfig = {
    getPermissionMode: () => 'bypassPermissions',
    isClaudeCodeAuthenticated: () => true,
    getClaudeCodeCliPath: () => '/test/claude',
    getShellEnv: () => ({ PATH: '/test' }),
    requestToolApproval: async (...args: Ask) => { asked.push(args); return { approved: answer } },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the factory's options are inspected loosely
  let options: any
  const factory = ((_model: string, o: unknown) => { options = o; return {} as ReturnType<typeof claudeCode> }) as typeof claudeCode
  createClaudeConnection(config, factory).createChatModel({ appSessionId: 'c1' })
  return { hook: options.hooks.PreToolUse[0].hooks[0], asked }
}

test('the list keeps all 20 commands, and each example is one its own entry catches', () => {
  assert.equal(DANGEROUS_COMMANDS.length, 20, 'a dropped or added entry is a change to what the member is asked about')
  assert.equal(EXAMPLES.length, DANGEROUS_COMMANDS.length)
  DANGEROUS_COMMANDS.forEach((entry, i) => assert.ok(entry.pattern.test(EXAMPLES[i]), `${entry.pattern} catches ${EXAMPLES[i]}`))
})

test('every one of them, sent through the real hook, asks the member first and is refused when they say no', async () => {
  for (const command of EXAMPLES) {
    const { hook, asked } = hookAsking(false)
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't' })
    assert.equal(asked.length, 1, `asked about: ${command}`)
    assert.equal(asked[0][0], 'Bash')
    assert.equal(asked[0][1].command, command)
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny', command)
  }
  const { hook, asked } = hookAsking(false)
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 't' })
  assert.equal(asked.length, 0, 'an ordinary command is not asked about here')
})

test('Claude\'s own description goes with the question, for the banner only; the decision is the same', async () => {
  for (const answer of [true, false]) {
    const { hook, asked } = hookAsking(answer)
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm 古い下書き.md', description: '古い下書きを消します' }, tool_use_id: 't' })
    assert.deepEqual(asked[0][1], { command: 'rm 古い下書き.md', description: '古い下書きを消します' })
    assert.equal(result.hookSpecificOutput.permissionDecision, answer ? 'allow' : 'deny')
    const words = approvalWordsOf(asked[0][0], asked[0][1])
    assert.equal(words.action, 'ファイルを消すコマンドを実行します')
    assert.equal(words.detail, '古い下書きを消します', 'shown above 「くわしく」')
  }
  const { hook, asked } = hookAsking(false)
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm a' }, tool_use_id: 't' })
  assert.deepEqual(asked[0][1], { command: 'rm a' }, 'no description: as before')
})

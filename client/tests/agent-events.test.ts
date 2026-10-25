import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_MCP_SERVERS, categorizeTool, createToolEventTracker, describeCommand, describePath, describeTarget,
  type AgentToolEvent, type TargetContext,
} from '../shared/agent-events'
import { COMPANY_FILES_SERVER } from '../electron/company-files/tools'
import { CODEX_CHOICE_SERVER } from '../shared/choice-prompt'
import { REVIEW_SERVER } from '../electron/review/tools'
import { parseAgentToolEvent } from '../../shared/types/agent-events'
import { createAgentEventRecorder, formatAgentEvent } from '../electron/services/agent-events'

const ROOT = '/Users/m/会社'
const ctx: TargetContext = { companyRoot: ROOT, cwd: ROOT, home: '/Users/m', appDataDirs: ['/Users/m/Library/Application Support/AICompanyBuilder'] }

test('categories: Claude, Codex (app names) and the API-key tools; MCP servers by who provides them', () => {
  assert.equal(categorizeTool('Read'), 'read')
  assert.equal(categorizeTool('Grep'), 'read')
  assert.equal(categorizeTool('Edit'), 'write')
  assert.equal(categorizeTool('NotebookEdit'), 'write')
  assert.equal(categorizeTool('Bash'), 'command')
  assert.equal(categorizeTool('WebFetch'), 'web')
  assert.equal(categorizeTool('WebSearch'), 'web')
  assert.equal(categorizeTool('Task'), 'subagent')
  assert.equal(categorizeTool('Agent'), 'subagent')
  assert.equal(categorizeTool('AskUserQuestion'), 'question')
  assert.equal(categorizeTool('mcp__acb_ask__ask_user'), 'question')
  assert.equal(categorizeTool('mcp__acb_company_files__company_search'), 'app-tool')
  assert.equal(categorizeTool('mcp__acb_consultations__read_consultation'), 'app-tool')
  assert.equal(categorizeTool('mcp__acb_review__request_review'), 'app-tool')
  assert.equal(categorizeTool('mcp__github__create_issue'), 'mcp-external')
  assert.equal(categorizeTool('readFile'), 'read')
  assert.equal(categorizeTool('writeFile'), 'write')
  assert.equal(categorizeTool('executeCommand'), 'command')
  assert.equal(categorizeTool('TodoWrite'), 'other')
  assert.equal(categorizeTool('constructor'), 'other')
})

test('the app MCP server list matches the servers the app starts', () => {
  assert.ok(APP_MCP_SERVERS.includes(COMPANY_FILES_SERVER))
  assert.ok(APP_MCP_SERVERS.includes(CODEX_CHOICE_SERVER))
  assert.ok(APP_MCP_SERVERS.includes('acb_consultations'))
  assert.ok(APP_MCP_SERVERS.includes(REVIEW_SERVER))
})

test('paths: company-relative NFC; outside only says so, with the kind of secret place', () => {
  assert.deepEqual(describePath(`${ROOT}/営業/提案.md`, ctx), { kind: 'file', path: '営業/提案.md' })
  assert.deepEqual(describePath('営業/../総務/a.md', ctx), { kind: 'file', path: '総務/a.md' })
  assert.deepEqual(describePath(ROOT, ctx), { kind: 'file', path: '' })
  // NFD spelling of the same name, and A–Z case of the root.
  assert.deepEqual(describePath(`${ROOT}/${'デザイン'.normalize('NFD')}/x.md`, ctx), { kind: 'file', path: 'デザイン/x.md' })
  assert.deepEqual(describePath('/USERS/m/会社/a.md', ctx), { kind: 'file', path: 'a.md' })
  assert.deepEqual(describePath(`${ROOT}/.env.local`, ctx), { kind: 'file', path: '.env.local', sensitive: 'env-file' })
  assert.deepEqual(describePath('/etc/hosts', ctx), { kind: 'outside' })
  assert.deepEqual(describePath('../other/secret-plan.md', ctx), { kind: 'outside' })
  assert.deepEqual(describePath('~/.ssh/id_ed25519', ctx), { kind: 'outside', sensitive: 'ssh' })
  assert.deepEqual(describePath('/Users/m/.ssh/config', ctx), { kind: 'outside', sensitive: 'ssh' })
  assert.deepEqual(describePath('/Users/m/project/.env', ctx), { kind: 'outside', sensitive: 'env-file' })
  assert.deepEqual(describePath('/Users/m/Library/Keychains/login.keychain-db', ctx), { kind: 'outside', sensitive: 'keychain' })
  assert.deepEqual(describePath('/Users/m/.aws/credentials', ctx), { kind: 'outside', sensitive: 'credentials' })
  assert.deepEqual(describePath('/Users/m/Library/Application Support/AICompanyBuilder/config.json', ctx), { kind: 'outside', sensitive: 'app-data' })
  assert.deepEqual(describePath('/Users/m/会社2/a.md', ctx), { kind: 'outside' })
  assert.deepEqual(describePath('relative.md', {}), { kind: 'outside' })
})

test('commands: program + subcommand for well-known tools, never arguments', () => {
  assert.deepEqual(describeCommand('git push origin main'), { kind: 'command', programs: ['git push'] })
  assert.deepEqual(describeCommand('git -C ../x log --oneline'), { kind: 'command', programs: ['git log'] })
  assert.deepEqual(describeCommand('npm install --save left-pad'), { kind: 'command', programs: ['npm install'] })
  assert.deepEqual(describeCommand('pnpm --filter client test'), { kind: 'command', programs: ['pnpm test'] })
  assert.deepEqual(describeCommand('python3 -m pytest tests/x.py'), { kind: 'command', programs: ['python3 -m pytest'] })
  assert.deepEqual(describeCommand('python script.py --key abc'), { kind: 'command', programs: ['python'] })
  assert.deepEqual(describeCommand('npx playwright@1.50.0 test'), { kind: 'command', programs: ['npx playwright'] })
  assert.deepEqual(describeCommand('/usr/bin/curl -s https://example.com'), { kind: 'command', programs: ['curl'] })
  assert.deepEqual(describeCommand('FOO=1 sudo rm -rf /tmp/x'), { kind: 'command', programs: ['sudo rm'] })
  assert.deepEqual(describeCommand('cd 営業 && ls -la | grep md; echo done'), { kind: 'command', programs: ['cd', 'ls', 'grep', 'echo'] })
  assert.deepEqual(describeCommand('a; b; c; d; e; f; g'), { kind: 'command', programs: ['a', 'b', 'c', 'd', 'e'], more: 2 })
  assert.deepEqual(describeCommand("/bin/zsh -lc 'git status && npm test'"), { kind: 'command', programs: ['git status', 'npm test'] })
})

test('commands: file redirection and tee are flagged; fd duplication and /dev/null are not', () => {
  assert.equal(describeCommand('echo hi > notes.md').redirect, true)
  assert.equal(describeCommand('echo hi >> notes.md').redirect, true)
  assert.equal(describeCommand('make &> build.log').redirect, true)
  assert.equal(describeCommand('cat a | tee b').redirect, true)
  assert.equal(describeCommand("bash -c 'echo x > y'").redirect, true)
  assert.equal(describeCommand('npm test 2>&1').redirect, undefined)
  assert.equal(describeCommand('ls 2>/dev/null').redirect, undefined)
  assert.equal(describeCommand('echo "a > b"').redirect, undefined)
  assert.deepEqual(describeCommand('git status 2>&1 | head').programs, ['git status', 'head'])
})

test('the app\'s web research is a web call: the first given page\'s host, never the question', () => {
  assert.equal(categorizeTool('mcp__acb_web__web_research'), 'web')
  assert.ok(!APP_MCP_SERVERS.includes('acb_web'))
  assert.equal(categorizeTool('mcp__acb_web__other'), 'mcp-external')
  assert.deepEqual(describeTarget('mcp__acb_web__web_research', { question: '社外秘', urls: ['https://u:p@Docs.Example.com/a?t=1', 'https://b.example.com'] }, ctx), { kind: 'web', host: 'docs.example.com' })
  assert.deepEqual(describeTarget('mcp__acb_web__web_research', { question: 'https://leak.example.com/in-question' }, ctx), { kind: 'web' })
  assert.deepEqual(describeTarget('mcp__acb_web__web_research', { question: 'q', urls: ['file:///etc/passwd'] }, ctx), { kind: 'web' })
})

test('targets: web host only, MCP server, subagent type; nothing for questions', () => {
  assert.deepEqual(describeTarget('WebFetch', { url: 'https://user:pw@Docs.Example.com:8443/a/b?token=x#f', prompt: 'p' }, ctx), { kind: 'web', host: 'docs.example.com' })
  assert.deepEqual(describeTarget('WebFetch', { url: 'file:///etc/passwd' }, ctx), { kind: 'web' })
  assert.deepEqual(describeTarget('WebSearch', { query: '社外秘 案件名' }, ctx), { kind: 'web' })
  assert.deepEqual(describeTarget('mcp__github__create_issue', { title: 't', body: 'b' }, ctx), { kind: 'mcp', server: 'github', tool: 'create_issue' })
  assert.deepEqual(describeTarget('Agent', { subagent_type: 'general-purpose', prompt: 'p' }, ctx), { kind: 'subagent', subagentType: 'general-purpose' })
  assert.deepEqual(describeTarget('AskUserQuestion', { questions: [{ question: 'q' }] }, ctx), { kind: 'none' })
  assert.deepEqual(describeTarget('Grep', { pattern: 'password' }, ctx), { kind: 'file', path: '' })
  assert.deepEqual(describeTarget('Write', { file_path: `${ROOT}/a.md`, content: 'x' }, ctx), { kind: 'file', path: 'a.md' })
  assert.deepEqual(describeTarget('Write', { changes: [{ path: `${ROOT}/a.md` }, { path: '/tmp/b' }] }, ctx), { kind: 'files', files: [{ kind: 'file', path: 'a.md' }, { kind: 'outside' }] })
  assert.deepEqual(describeTarget('readFile', { path: 'x/y.md' }, ctx), { kind: 'file', path: 'x/y.md' })
})

test('no content, argument, URL path/query or message ever reaches a serialized event', () => {
  const secrets = ['sk-ant-api03-AAAABBBBCCCCDDDD', 'ghp_SECRETSECRET', 'tok3n-in-query', 'hunter2', '社外秘の本文', '/private/plan', 'a/b?q', 'm@example.com']
  const events: AgentToolEvent[] = []
  const tracker = createToolEventTracker({ agent: 'claude-code', companyRoot: ROOT, cwd: ROOT, home: '/Users/m', conversationId: 'conv', companyId: 'co' }, e => events.push(e))
  const calls: Array<[string, unknown]> = [
    ['Bash', { command: `curl -H "Authorization: Bearer ${secrets[0]}" https://api.example.com${secrets[5]}?token=${secrets[2]}` }],
    ['Bash', { command: `git push https://x:${secrets[1]}@github.com/o/r.git` }],
    ['Bash', { command: `ANTHROPIC_API_KEY=${secrets[0]} npm run deploy -- --password ${secrets[3]}` }],
    ['Bash', { command: `echo '${secrets[4]}' > /tmp/out` }],
    ['WebFetch', { url: `https://example.com${secrets[5]}?token=${secrets[2]}`, prompt: secrets[4] }],
    ['WebSearch', { query: secrets[4] }],
    ['mcp__acb_web__web_research', { question: `${secrets[4]} ${secrets[3]}`, urls: [`https://example.com${secrets[5]}?token=${secrets[2]}`] }],
    ['Write', { file_path: `${ROOT}/a.md`, content: `${secrets[4]} ${secrets[0]}` }],
    ['Edit', { file_path: `/Users/m${secrets[5]}.md`, old_string: secrets[3], new_string: secrets[4] }],
    ['mcp__mail__send', { to: secrets[7], body: secrets[4] }],
    ['AskUserQuestion', { questions: [{ question: secrets[4] }] }],
    ['Agent', { subagent_type: 'general-purpose', prompt: secrets[4], description: secrets[3] }],
    ['executeCommand', { command: `python -c "print('${secrets[3]}')"` }],
  ]
  calls.forEach(([tool, input], i) => {
    const id = tracker.decide(`call-${i}`, { tool, input }, i % 2 ? 'member-allowed' : 'policy-default')
    tracker.finish(id, 'ok')
  })
  tracker.decide('denied', { tool: 'Bash', input: { command: `rm -rf ${secrets[5]}` } }, 'guard-denied', 'dangerous-command')
  assert.equal(events.length, calls.length + 1)
  const serialized = JSON.stringify(events) + events.map(formatAgentEvent).join('\n')
  for (const secret of secrets) assert.ok(!serialized.includes(secret), `leaked: ${secret}`)
})

test('the server accepts every event the tracker makes, unchanged (shared/types parseAgentToolEvent)', () => {
  const events: AgentToolEvent[] = []
  const tracker = createToolEventTracker({
    agent: 'claude-code', companyRoot: ROOT, cwd: `${ROOT}/営業部`, home: '/Users/m', conversationId: 'conv-1', turnId: 'turn-1',
    companyId: 'co', model: 'claude-opus-5-5[1m]', department: '営業部', appDataDirs: ctx.appDataDirs,
  }, e => events.push(e))
  const calls: Array<[string, unknown]> = [
    ['Read', { file_path: `${ROOT}/営業部/提案.md` }],
    ['Glob', { pattern: '*.md', path: ROOT }],
    ['Edit', { file_path: '/Users/m/.ssh/config' }],
    ['MultiEdit', { file_path: `${ROOT}/a.md` }],
    ['Bash', { command: 'sudo rm -rf x && git push origin main | tee log && npx @scope/pkg@1 && ./weird$name' }],
    ['Bash', { command: 'a; b; c; d; e; f; g' }],
    ['WebFetch', { url: 'https://Example.COM/a?b' }],
    ['WebSearch', { query: 'x' }],
    ['mcp__acb_web__web_research', { question: 'q', urls: ['https://Docs.Example.com/x'] }],
    ['mcp__acb_web__web_research', { question: 'q' }],
    ['mcp__github__create_issue', {}],
    ['mcp__acb_company_files__company_read_file', { path: 'x' }],
    ['Agent', { subagent_type: 'general-purpose' }],
    ['AskUserQuestion', { questions: [] }],
    ['TodoWrite', {}],
  ]
  calls.forEach(([tool, input], i) => {
    const id = tracker.decide(`toolu_${i}`, { tool, input, subagentType: i === 0 ? 'Explore' : undefined }, i % 3 ? 'auto-allowed' : 'guard-denied', i % 3 ? undefined : 'read-only-folder')
    tracker.finish(id, i % 2 ? 'ok' : 'error', undefined, 12)
  })
  tracker.decide('open', { tool: 'Bash', input: { command: 'sleep 1' } }, 'member-allowed')
  tracker.close()
  assert.equal(events.length, calls.length + 1)
  assert.equal(events[0].department, '営業部')
  for (const event of events) assert.deepEqual(parseAgentToolEvent(JSON.parse(JSON.stringify(event))), event)
})

test('tracker: one event per call — refusals at once, allowed calls with their outcome, the rest unfinished at the end', () => {
  let t = 1000
  const events: AgentToolEvent[] = []
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']
  const tracker = createToolEventTracker({ agent: 'codex', conversationId: 'conv', turnId: 'turn', companyId: 'co', model: 'm', companyRoot: ROOT, cwd: ROOT }, e => events.push(e), { now: () => t, newId: () => ids.shift()! })
  tracker.start('a', { tool: 'Bash', input: { command: 'git status' } })
  t += 5
  tracker.decide('a', { tool: 'Bash' }, 'member-allowed')
  t += 20
  tracker.finish('a', 'ok')
  tracker.finish('a', 'error') // already reported
  tracker.decide('b', { tool: 'Write', input: { file_path: `${ROOT}/x.md` } }, 'member-denied')
  tracker.finish('b', 'error') // Codex reports the declined item afterwards
  tracker.finish('c', 'error', { tool: 'WebSearch' }) // never seen before
  tracker.decide('d', { tool: 'Read', input: { file_path: `${ROOT}/r.md` } }, 'auto-allowed')
  tracker.close()
  assert.deepEqual(events.map(e => [e.callId, e.decision, e.outcome, e.durationMs]), [
    ['a', 'member-allowed', 'ok', 20],
    ['b', 'member-denied', undefined, undefined],
    ['c', 'policy-default', 'error', 0],
    ['d', 'auto-allowed', 'unfinished', undefined],
  ])
  assert.deepEqual(events[0], {
    version: 1, id: 'e1', callId: 'a', at: new Date(1000).toISOString(), durationMs: 20,
    conversationId: 'conv', turnId: 'turn', companyId: 'co', agent: 'codex', model: 'm',
    tool: 'Bash', category: 'command', target: { kind: 'command', programs: ['git status'] },
    decision: 'member-allowed', outcome: 'ok',
  })
})

test('tracker: a failing sink or bad input never throws into the agent', () => {
  const warnings: string[] = []
  const tracker = createToolEventTracker({ agent: 'claude-code' }, () => { throw new Error('sink down') }, { warn: m => warnings.push(m) })
  assert.doesNotThrow(() => tracker.decide('x', { tool: 'Bash', input: { command: 'ls' } }, 'guard-denied'))
  assert.doesNotThrow(() => tracker.finish('y', 'ok', { tool: 'Read', input: null }))
  assert.doesNotThrow(() => tracker.close())
  assert.equal(warnings.length, 1)
})

test('recorder: bounded ring, one metadata line per event, sinks in order', () => {
  const lines: string[] = []
  const added: string[] = []
  const recorder = createAgentEventRecorder({ capacity: 2, log: l => lines.push(l), sinks: [{ add: e => added.push(e.callId) }], home: '/Users/m' })
  const tracker = createToolEventTracker({ agent: 'claude-code', companyRoot: ROOT }, recorder.record)
  for (const id of ['1', '2', '3']) tracker.decide(id, { tool: 'Bash', input: { command: 'git push --force' } }, 'guard-denied', 'dangerous-command')
  assert.deepEqual(recorder.recent().map(e => e.callId), ['2', '3'])
  assert.deepEqual(added, ['1', '2', '3'])
  assert.equal(lines[0], '[agent-events] claude-code Bash command git push guard-denied:dangerous-command')
  assert.deepEqual(recorder.paths(), { home: '/Users/m', appDataDirs: undefined })
})

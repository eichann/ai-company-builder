/**
 * How tool calls read in the chat (`client/shared/tool-display.ts`, chat-ui-and-history.md
 * 「Tool rows」).
 *
 * Guards:
 * - every ACB tool a turn can get — the record tools generated from the company's types and
 *   plugins, every connector provider in `tool-providers.ts`, and the fixed app servers — has a
 *   plain-Japanese label (a new tool without one fails here);
 * - a call's line never carries a secret, a command's text, a mail address or an absolute path
 *   outside the company folder;
 * - the main process puts the line on the tool part without losing the subagent parent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIMessageChunk } from 'ai'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { PluginAiTools } from '../../shared/types/plugins'
import { createRecordTools } from '../electron/records/tools'
import { recordToolProviders } from '../electron/records/tool-providers'
import type { RecordTurnAccess } from '../electron/records/api'
import { acbToolDisplays, toolDisplayTransform } from '../electron/tool-display-stream'
import { referenceSchemas } from '../electron/consultations/tools'
import { COMPANY_FILE_TOOL_NAMES, companyFileToolId } from '../electron/company-files/tools'
import { REVIEW_TOOL_ID } from '../shared/review-request'
import { WEB_RESEARCH_TOOL_ID } from '../shared/web-research'
import { CHOICE_TOOL_NAMES } from '../shared/choice-prompt'
import { builtinToolDisplay, readToolLine, toolLineOf, type ToolDisplay } from '../shared/tool-display'
import { ACB_TOOL_DISPLAYS, CORE_ACTION_LABELS, CORE_TYPE_LABELS, actionToolDisplay, pluginOperationDisplay } from '../shared/acb-tool-displays'

const PLUGINS: PluginAiTools = {
  plugins: [{
    id: 'corporate-sales', label: 'HubSpot', operations: [
      { name: 'refresh_deal', label: '最新にする', kind: 'read', recordType: 'deal', decision: false, fields: [] },
      { name: 'update_deal', label: '案件を更新', kind: 'update', recordType: 'deal', decision: true, fields: [{ name: 'amount', label: '金額', kind: 'number' }] as never },
      { name: 'log_meeting', label: '商談を記録', kind: 'create', recordType: 'deal', decision: false, fields: [], policy: 'auto', content: ['title', 'body'] },
      { name: 'create_deal', label: '案件を作る', kind: 'create', recordType: 'deal', decision: true, fields: [], policy: 'prior', createsRecord: true },
    ],
  }],
}

/** A record token's server with every type, a plugin and Google Drive set up. */
function access(): RecordTurnAccess {
  return {
    scope: 'act',
    async call(_method, path) {
      if (path === '/types') return { types: coreTypeDefinitions().map(definition => ({ definition })) }
      if (path === '/plugins') return PLUGINS
      if (path === '/google/drive/status') return { available: true, granted: true, picks: [] }
      return {}
    },
    async close() {},
  }
}

async function everyRecordTool() {
  const providers = recordToolProviders({
    drivePicking: { pick: async () => ({ ok: true, picks: [], refused: [] }) as never },
    paths: { validate: p => p, add() {}, rootOf: () => '/co' },
    privateFolders: { readable: async () => [] } as never,
  }, { companyId: 'co', companyRoot: '/co' })
  const tools = await createRecordTools(access(), undefined, { toolProviders: providers })
  assert.ok(tools)
  return tools.specs
}

const JAPANESE = /[぀-ヿ㐀-鿿]/

function assertPlain(name: string, display: ToolDisplay | undefined) {
  assert.ok(display, `${name} has no display: declare \`display\` next to its definition (client/shared/tool-display.ts)`)
  for (const [field, text] of [['label', display.label], ['running', display.running], ['many', display.many ?? '']] as const) {
    assert.ok(JAPANESE.test(text), `${name}.${field} is not plain Japanese: ${text}`)
    assert.ok(!/mcp__|__|_[a-z]+_/.test(text), `${name}.${field} shows a tool id: ${text}`)
  }
  assert.notEqual(display.label, display.running, `${name}: running and finished read the same`)
  if (display.many) assert.ok(display.many.includes('{n}'), `${name}.many has no {n}`)
}

test('every ACB tool a turn can get has a plain-Japanese label (records, plugins, connector providers, app servers)', async () => {
  const specs = await everyRecordTool()
  const names = specs.map(s => s.name)
  // The fixture reaches each family, so a family without labels cannot slip through.
  for (const expected of ['records_create', 'decisions_record', 'mail_draft_create', 'mail_recipients', 'minutes_read', 'approvals_show', 'task__start',
    'corporate-sales__refresh_deal', 'corporate-sales__update_deal', 'corporate-sales__log_meeting', 'corporate-sales__create_deal', 'drive_read', 'drive_put', 'inbox_read', 'inbox_judge']) {
    assert.ok(names.includes(expected), `fixture misses ${expected}`)
  }
  for (const spec of specs) assertPlain(spec.name, spec.display)

  const displays = acbToolDisplays({ specs })
  const appTools = [
    ...Object.keys(referenceSchemas).map(n => `mcp__acb_consultations__${n}`),
    ...COMPANY_FILE_TOOL_NAMES.map(companyFileToolId),
    REVIEW_TOOL_ID, WEB_RESEARCH_TOOL_ID, ...[...CHOICE_TOOL_NAMES].filter(n => n.startsWith('mcp__')),
    ...specs.map(s => `mcp__acb_records__${s.name}`),
  ]
  for (const name of appTools) assertPlain(name, displays.get(name))

  // The renderer names each of them by its name alone (no line from main: an unattended run,
  // restored history), and a fixed tool's definition takes its words from that one place.
  for (const name of appTools) {
    const line = toolLineOf(name, {})
    assert.ok(!line.muted && JAPANESE.test(line.label) && !/mcp__|acb_/.test(line.label), `${name} has no name of its own in the renderer: ${line.label}`)
  }
  for (const spec of specs) if (ACB_TOOL_DISPLAYS[`mcp__acb_records__${spec.name}`]) assert.equal(spec.display, ACB_TOOL_DISPLAYS[`mcp__acb_records__${spec.name}`], spec.name)
})

test('the renderer\'s plain-string labels of the core types match their definitions', () => {
  const types = coreTypeDefinitions()
  assert.deepEqual(CORE_TYPE_LABELS, Object.fromEntries(types.map(t => [t.name, t.label])))
  assert.deepEqual(CORE_ACTION_LABELS, Object.fromEntries(types.flatMap(t => Object.entries(t.actions).map(([n, a]) => [`${t.name}__${n}`, a.label]))))
})

test('a record type\'s action reads its Japanese label in the past tense; an unknown one still reads as a sentence', () => {
  const label = (name: string) => toolLineOf(`mcp__acb_records__${name}`, {}).label
  assert.equal(label('meeting__finish_reading'), '議事録を読み終えました')
  assert.equal(label('task__request_review'), '終わったので見てもらいました')
  assert.equal(label('meeting__fail_reading'), '議事録を読めませんでした')
  assert.equal(label('reply_request__drop'), '返事をしないことにしました')
  for (const name of ['corporate-sales__update_deal', 'someone__does_something', 'deal__frobnicate']) {
    assert.ok(JAPANESE.test(label(name)) && !label(name).includes('__') && !label(name).includes('acb'), `${name}: ${label(name)}`)
  }
  // From the company's definition (main), the plugin's own words.
  assert.equal(pluginOperationDisplay('HubSpot', '商談を記録', 'create').label, 'HubSpotで商談を記録しました')
  assert.equal(actionToolDisplay('議事録を読み終える').running, '議事録を読み終えています')
})

test('the owner\'s examples read as plain sentences', async () => {
  const displays = acbToolDisplays({ specs: await everyRecordTool() })
  const line = (name: string, input: unknown) => {
    const l = toolLineOf(`mcp__acb_records__${name}`, input, displays.get(`mcp__acb_records__${name}`))
    return l.detail ? `${l.label}：${l.detail}` : l.label
  }
  assert.equal(line('decisions_record', { title: '研修対象を営業部全体に広げる' }), '決めたことを残しました：研修対象を営業部全体に広げる')
  assert.equal(line('records_create', { type: 'task', title: '修正見積を送る' }), '記録を作りました：タスク「修正見積を送る」')
  assert.equal(line('mail_draft_create', { toRefs: ['r' + 'a'.repeat(24), 'r' + 'b'.repeat(24)], subject: '件名', body: '本文' }), 'メールの下書きを作りました：宛先 2 人')
  assert.equal(line('mail_recipients', {}), '宛先の候補を調べました')
  assert.equal(toolLineOf('Skill', { skill: '提案書作成' }).detail, '提案書作成')
})

test('built-in agent tools read in Japanese, company-relative, and never show a command, a secret or an outside path', () => {
  const root = '/Users/sato/acb/会社'
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'AskUserQuestion',
    'readFile', 'writeFile', 'listDirectory', 'executeCommand', 'readSkillFile']) assertPlain(name, builtinToolDisplay(name))

  assert.equal(toolLineOf('Read', { file_path: `${root}/営業部/提案書.md` }, undefined, { root }).detail, '営業部/提案書.md')
  assert.equal(toolLineOf('Read', { file_path: '/Users/sato/.ssh/id_rsa' }, undefined, { root }).detail, 'id_rsa', 'outside the company: the file name only')
  const bash = toolLineOf('Bash', { command: 'curl -H "Authorization: Bearer sk-ant-api03-SECRETSECRET" https://x', description: 'APIを試す' })
  assert.equal(bash.detail, 'APIを試す')
  assert.ok(!JSON.stringify(bash).includes('SECRET'))
  // Codex reports a command as a whole item: never its text.
  assert.ok(!JSON.stringify(toolLineOf('Bash', JSON.stringify({ type: 'commandExecution', command: 'export TOKEN=abc123' }))).includes('abc123'))
  const grep = toolLineOf('Grep', { pattern: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' })
  assert.ok(!grep.detail?.includes('0123456789'), 'a token-looking pattern is masked')
  assert.equal(toolLineOf('WebFetch', { url: 'https://example.com/path?key=SECRET' }).detail, 'example.com')
  assert.ok((toolLineOf('Grep', { pattern: 'あ'.repeat(200) }).detail ?? '').length <= 40, 'long arguments are cut')
  // A member's own tool: muted, named by server and tool.
  const own = toolLineOf('mcp__my_crm__find_customer', {})
  assert.equal(own.label, 'ほかの道具を使いました')
  assert.equal(own.technical, 'my_crm・find_customer')
  assert.equal(own.muted, true)
})

test('mail drafts show how many people, never an address or the subject', async () => {
  const displays = acbToolDisplays({ specs: await everyRecordTool() })
  const l = toolLineOf('mcp__acb_records__mail_draft_create', { toRefs: ['r' + 'a'.repeat(24)], subject: '社外秘の件', body: 'taro@example.com' }, displays.get('mcp__acb_records__mail_draft_create'))
  assert.ok(!JSON.stringify(l).includes('社外秘') && !JSON.stringify(l).includes('@'))
})

test('the stream labels each call on its part and keeps the subagent parent', async () => {
  const displays = acbToolDisplays({ specs: await everyRecordTool() })
  const chunks: UIMessageChunk[] = [
    { type: 'tool-input-available', toolCallId: 'a', toolName: 'mcp__acb_records__decisions_record', input: { title: '方針A' }, providerMetadata: { 'claude-code': { parentToolCallId: 'agent-1' } } },
    { type: 'tool-input-available', toolCallId: 'b', toolName: 'mcp__other__x', input: {} },
    { type: 'text-delta', id: 't', delta: 'ok' },
  ]
  const out: UIMessageChunk[] = []
  const stream = new ReadableStream<UIMessageChunk>({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close() } }).pipeThrough(toolDisplayTransform(displays, '/co'))
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) out.push(chunk)
  const a = out[0] as Extract<UIMessageChunk, { type: 'tool-input-available' }>
  assert.equal((a.providerMetadata?.['claude-code'] as { parentToolCallId?: string }).parentToolCallId, 'agent-1')
  assert.deepEqual(readToolLine(a.providerMetadata), { label: '決めたことを残しました', running: '決めたことを残しています', many: '決めたことを {n} 件残しました', detail: '方針A' })
  assert.equal((out[1] as typeof a).providerMetadata?.acb, undefined, 'an unknown tool gets no line from main (the renderer keeps its name out of the row)')
  assert.deepEqual(out[2], chunks[2])
})

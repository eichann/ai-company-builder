/**
 * The company's 「使う機能」 in the AI's record tools (`.claude/rules/records.md` "Features on and
 * off"). The types stay installed when a feature is off, so the tools must follow the feature,
 * not whether a type exists — otherwise the AI keeps making records nobody can act on.
 *
 * Guards:
 * - a feature turned off takes its own tools away (minutes_read / minutes_link_bundle with 会議,
 *   decisions_record with 決めたこと, the inbox's tools with 受信) and every action tool and create of
 *   its 「見るだけ」 types (meeting, decision, interaction, reply_request, project);
 * - 決めたこと off: the instructions, minutes_read's description and the minutes first message (the
 *   manual start and the automatic 「AI の番」 alike) ask for no decision, and the instructions say not to record one;
 * - 受信 off: the mail draft tool does not ask the AI to mark 「返事を待つ」;
 * - an older server that sends no `features` keeps every tool (everything on).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools, RECORDS_DECISIONS_OFF } from '../electron/records/tools'
import { recordToolProviders } from '../electron/records/tool-providers'
import { coreTypeDefinitions } from '../../shared/core/core-types'
import type { CompanyFeatures } from '../../shared/core/features'
import { minutesFirstMessage } from '../shared/minutes-app'
import { minutesReading } from '../shared/ai-turn-steps/minutes-reading'

const TYPES = coreTypeDefinitions()
const ALL_ON: CompanyFeatures = { taskList: true, meetings: true, inbox: true, decisions: true, projects: true }
const ALL_OFF: CompanyFeatures = { taskList: false, meetings: false, inbox: false, decisions: false, projects: false }

async function toolsWith(features: Partial<CompanyFeatures> | undefined) {
  const fetch = (async (url: string) => {
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: 'acb_rec_co.' + 'a'.repeat(64), tokenId: 'tok-1', scope: 'act', expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) {
      return json(200, { types: TYPES.map(definition => ({ definition, source: 'core', versions: [1] })), ...(features ? { features } : {}) })
    }
    return json(200, { ok: true })
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=1'], fetch })
  const access = (await api.openTurn('co', { conversationId: 'c', agent: 'claude-code', scope: 'act' }))!
  const toolProviders = recordToolProviders({ privateFolders: { readable: () => [] } } as never, { companyId: 'co', companyRoot: null })
  return (await createRecordTools(access, undefined, { toolProviders }))!
}

const names = (t: Awaited<ReturnType<typeof toolsWith>>) => t.specs.map(s => s.name)
const createTypes = (t: Awaited<ReturnType<typeof toolsWith>>) => {
  const create = t.specs.find(s => s.name === 'records_create')!
  return ['task', 'project', 'interaction', 'meeting'].filter(type => create.schema.safeParse({ type, title: 'x' }).success)
}

test('an older server without features keeps every feature\'s tools', async () => {
  const t = await toolsWith(undefined)
  for (const name of ['minutes_read', 'minutes_link_bundle', 'decisions_record', 'inbox_read', 'inbox_judge', 'meeting__start_reading', 'decision__confirm', 'reply_request__close']) {
    assert.ok(names(t).includes(name), name)
  }
  assert.deepEqual(createTypes(t), ['task', 'project', 'interaction'])
  assert.ok(!t.instructions.includes(RECORDS_DECISIONS_OFF))
})

test('features turned off take their tools and their view-only types\' actions and creates away', async () => {
  const t = await toolsWith(ALL_OFF)
  const all = names(t)
  for (const name of ['minutes_read', 'minutes_link_bundle', 'decisions_record', 'inbox_read', 'inbox_judge', 'inbox_reply_check']) assert.ok(!all.includes(name), name)
  for (const prefix of ['meeting__', 'decision__', 'reply_request__', 'interaction__', 'project__']) {
    assert.deepEqual(all.filter(n => n.startsWith(prefix)), [], prefix)
  }
  // The task is the core's: always there.
  assert.ok(all.includes('task__complete') && all.includes('records_get'))
  assert.deepEqual(createTypes(t), ['task'])
})

test('決めたこと off alone: minutes are still read, but nothing asks the AI to record a decision', async () => {
  const t = await toolsWith({ decisions: false })
  const read = t.specs.find(s => s.name === 'minutes_read')!
  assert.ok(read, 'meetings stay on')
  assert.ok(!read.description.includes('decisions_record'))
  assert.ok(!names(t).includes('decisions_record'))
  assert.ok(!t.instructions.includes('decisions_record') && !t.instructions.includes('まだ確かめていない案'))
  assert.ok(t.instructions.includes(RECORDS_DECISIONS_OFF))
  // With it on, the same tool asks for decisions (the description is the one that changed).
  const on = await toolsWith({})
  assert.ok(on.specs.find(s => s.name === 'minutes_read')!.description.includes('decisions_record'))
  assert.ok(on.instructions.includes('まだ確かめていない案'))
  // The minutes first message (a screen that knows the features) leaves the decisions out too.
  const first = minutesFirstMessage({ id: 'meeting-abcdef123456', title: '定例', meetingAt: null }, { decisions: false })
  assert.ok(!first.includes('decisions_record') && !first.includes('決まったこと'))
  assert.ok(minutesFirstMessage({ id: 'meeting-abcdef123456', title: '定例', meetingAt: null }).includes('decisions_record'))
  // The automatic reading (the unattended 「AI の番」) follows the switches like the manual start.
  const candidate = { id: 'meeting-abcdef123456', title: '定例', version: 3, meetingAt: null }
  const auto = minutesReading.firstMessage(candidate, 4, { ...ALL_ON, decisions: false })
  assert.ok(!auto.includes('decisions_record') && !auto.includes('決まったこと'))
  assert.ok(minutesReading.firstMessage(candidate, 4, ALL_ON).includes('decisions_record'))
})

test('受信 off: the inbox tools are gone and the mail draft asks for no 「返事を待つ」', async () => {
  const t = await toolsWith({ inbox: false })
  assert.deepEqual(names(t).filter(n => n.startsWith('inbox_')), [])
  const create = t.specs.find(s => s.name === 'mail_draft_create')!
  assert.ok(!create.description.includes('expectsReply: true'))
  assert.ok((await toolsWith({})).specs.find(s => s.name === 'mail_draft_create')!.description.includes('expectsReply: true'))
})

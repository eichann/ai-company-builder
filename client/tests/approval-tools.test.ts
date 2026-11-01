/**
 * The AI's side of approval requests (milestone 4 G6, .claude/rules/approvals.md):
 * - an update that needs approval comes back as a request: the reply gets the app's
 *   approval card (a reference the card reads with the session), not an operation card,
 *   and the AI is told nothing was written — never that it was updated;
 * - the AI can list and show requests but has no tool that approves, sends back or
 *   withdraws, whatever its token (the server has no such AI route either).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordsApi } from '../electron/records/api'
import { createRecordTools } from '../electron/records/tools'
import { readApprovalCardRef, type ApprovalCardRef } from '../shared/approvals'
import type { PluginAiTools } from '../../shared/types/plugins'

const TOKEN = 'acb_rec_co.' + 'b'.repeat(64)
const APPROVAL_TYPE = { name: 'approval', label: '承認のお願い', version: 2, implements: ['request'], storage: 'server', fields: {}, links: {}, states: ['pending'], initial: 'pending', final: [], actions: {} }
const PLUGINS: PluginAiTools = {
  plugins: [{
    id: 'hubspot', label: 'HubSpot', operations: [
      { name: 'update_deal', label: '案件の欄を HubSpot に書き戻す', kind: 'update', recordType: 'deal', decision: true, fields: [{ name: 'amount', label: '金額', kind: 'number', policy: 'prior' }] },
    ],
  }],
}
const VIEW = {
  id: 'approval-0123456789abcdef', state: 'pending', recordTitle: '研修導入',
  changes: [{ field: 'amount', label: '金額', before: 1200000, after: 1500000, beforeShown: '1,200,000', afterShown: '1,500,000', changePercent: 25 }],
  viewerMayApprove: false,
}

async function turn(scope: 'read' | 'act') {
  const seen: string[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push(`${init.method ?? 'GET'} ${url}`)
    const json = (status: number, data: unknown) => new Response(JSON.stringify({ success: true, data }), { status })
    if (url.endsWith('/me/record-tokens')) return json(201, { token: TOKEN, tokenId: 'tok-1', scope, expiresAt: 'x' })
    if (url.endsWith('/api/records-ai/types')) return json(200, { types: [{ definition: APPROVAL_TYPE }] })
    if (url.endsWith('/api/records-ai/plugins')) return json(200, PLUGINS)
    if (url.includes('/operations/update_deal')) return json(202, { outcome: 'approval-requested', approval: VIEW, existing: false })
    if (url.includes(`/api/records-ai/approvals/${VIEW.id}`)) return json(200, { approval: VIEW })
    return json(200, {})
  }) as unknown as typeof globalThis.fetch
  const api = createRecordsApi({ baseUrl: () => 'https://acb.example.jp', cookies: () => ['s=SECRET'], fetch })
  const access = await api.openTurn('co', { conversationId: 'conv-1', agent: 'claude-code', scope })
  const approvals: ApprovalCardRef[] = []
  const operations: unknown[] = []
  const tools = await createRecordTools(access!, undefined, {
    companyId: 'co', conversationId: 'conv-1', newId: () => 'card-1',
    onApprovalCard: c => approvals.push(c), onOperationCard: c => operations.push(c),
  })
  return { tools: tools!, approvals, operations, seen }
}

test('an update needing approval: the app\'s approval card in the reply, and the AI is told nothing was written', async () => {
  const { tools, approvals, operations } = await turn('act')
  const out = JSON.parse(await tools.execute('hubspot__update_deal', { id: 'deal-8f3a2c01', expectedVersion: 3, fields: { amount: 1500000 }, note: '議事録の発言から', basis: { quote: '対象を広げたい' } }))
  assert.equal(operations.length, 0)
  assert.equal(approvals.length, 1)
  assert.deepEqual(readApprovalCardRef(JSON.parse(JSON.stringify(approvals[0]))), approvals[0])
  assert.equal(approvals[0].approvalId, VIEW.id)
  assert.equal(out.outcome, 'approval-requested')
  assert.match(out.instruction, /NOT written/)
  assert.match(out.instruction, /cannot approve/)
})

test('the AI lists and shows requests but has no tool to approve, send back or withdraw (act token too)', async () => {
  for (const scope of ['read', 'act'] as const) {
    const { tools } = await turn(scope)
    const names = tools.specs.map(s => s.name)
    assert.ok(names.includes('approvals_list') && names.includes('approvals_show'))
    for (const s of tools.specs.filter(x => x.name.startsWith('approval'))) assert.equal(s.readOnly, true, s.name)
    assert.ok(!names.some(n => /approve$|send_back|withdraw/.test(n)), names.join(','))
  }
  const { tools, approvals, seen } = await turn('read')
  const shown = JSON.parse(await tools.execute('approvals_show', { id: VIEW.id }))
  assert.equal(shown.shown, true)
  assert.equal(approvals[0].origin, 'shown')
  // Only reads went to the server for it.
  assert.ok(seen.filter(s => s.includes('/approvals')).every(s => s.startsWith('GET ')))
})

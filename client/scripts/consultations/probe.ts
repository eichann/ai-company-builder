import { HANDOFF_HEADINGS } from '../../electron/handoff/contract'
import { referenceFromTool } from '../../shared/consultation-reference'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createClaudeConnection } from '../../electron/agents/claude'
import { createCodexConnection } from '../../electron/agents/codex'
import { ConsultationReferences } from '../../electron/consultations/service'
import { ChatHistoryStore } from '../../electron/chat-history-store'
import { HandoffStore, fingerprint } from '../../electron/handoff/store'
const output = process.argv[2]
if (!path.isAbsolute(output || '')) throw new Error('absolute output required')
fs.mkdirSync(output)
const env = Object.fromEntries(Object.entries(process.env).filter((p): p is [string,string] => typeof p[1] === 'string'))
for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL']) delete env[key]
const config = { getShellEnv: () => env, getPermissionMode: () => 'default' as const, isClaudeCodeAuthenticated: () => true, getClaudeCodeCliPath: () => path.join(os.homedir(), '.local/bin/claude'), requestToolApproval: async () => ({ approved: false }) }
const history = new ChatHistoryStore(path.join(output,'history')); const handoff = new HandoffStore(path.join(output,'memos'), history)
const references = new ConsultationReferences(history, handoff)
history.save('company', { id: 'source', companyId: 'company', title: '桜計画の料金', createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [{ id:'u', role:'user', content:'桜計画の料金は月額15000円です。', timestamp:'2026-01-01' }] })
const source=history.get('company','source')!
const cursor={index:1,offset:0}
handoff.write('company','source',{version:1,turns:1,memo:{cursor,hash:fingerprint(source.messages,cursor),markdown:HANDOFF_HEADINGS.map(h=>`## ${h}\n- 桜計画の月額料金15,000円。`).join('\n\n'),updatedAt:'2026-01-01',provider:'claude-code',turns:1,metrics:{totalMs:1}}})
source.messages.push({id:'correction',role:'user',content:'訂正: 月額料金は12347円です。',timestamp:'2026-01-02'});history.save('company',source)
for (const provider of process.argv.slice(3).length ? process.argv.slice(3) : ['codex','claude-code']) {
  const connection = provider === 'codex' ? createCodexConnection(config) : createClaudeConnection(config)
  let resumeId: string | undefined
  const rounds: unknown[] = []
  for (let round=0; round<3; round++) {
    const calls: unknown[]=[]; const ref = references.forTurn('company','current')
    const model = connection.createChatModel({ workingDirectory: output, modelId: provider === 'claude-code' ? 'haiku' : undefined, resumeId, references: round ? { execute: async(name,args) => { const result=await ref.execute(name,args); calls.push({name,args,result}); return result } } : undefined })
    if (typeof model === 'string' || model.specificationVersion !== 'v3') throw new Error('model')
    const started=Date.now(); let text=''; let usage:unknown; const links: unknown[]=[]
    const result = await model.doStream({ prompt: [{role:'user',content:[{type:'text',text:round ? '必ずsearch_consultationsで「桜」を検索し、read_consultationのmessagesで原文を読んでから、月額料金を回答してください。メモも先にread_consultationのmemoで読み、古い料金に訂正がないか確認してください。過去の回答だけではなく今回もツールを使用してください。' : '接続確認です。「確認」のみ回答してください。'}]}], abortSignal: AbortSignal.timeout(90000) })
    for await (const part of result.stream) { if(part.type==='tool-result') { const ref=referenceFromTool(part.toolName,part.result); if(ref) links.push(ref) }; if(part.type==='error') throw part.error; if(part.type==='response-metadata' && part.id) resumeId=part.id; if(part.type==='text-delta') text+=part.delta; if(part.type==='finish') { usage=part.usage; resumeId=connection.readMetadata(part.providerMetadata).sessionId || resumeId } }
    assert.ok(resumeId)
    if(round) { assert.ok(calls.length>=2, JSON.stringify({text,calls})); assert.match(text,/12,?347/); assert.ok(links.length, 'source link from actual adapter result') }
    rounds.push({round,ms:Date.now()-started,text,calls,usage,links}); fs.writeFileSync(path.join(output,provider+'.json'),JSON.stringify(rounds,null,2)); console.log(provider,round,Date.now()-started,calls.length)
  }
}

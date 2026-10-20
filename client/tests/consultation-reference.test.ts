import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatHistoryStore } from '../electron/chat-history-store'
import { HandoffStore, fingerprint } from '../electron/handoff/store'
import { HANDOFF_HEADINGS } from '../electron/handoff/contract'
import { ConsultationReferences } from '../electron/consultations/service'
import { startReferenceMcp } from '../electron/consultations/mcp'
function fixture(t: { after(fn:()=>void):void }) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acb-reference-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const history=new ChatHistoryStore(path.join(dir,'history')); const store=new HandoffStore(path.join(dir,'memos'),history)
  const add=(id:string,company='company',content='予算は12万円')=>history.save(company,{id,companyId:company,title:'桜 '+id,createdAt:'2026-01-01',updatedAt:'2026-01-01',messages:[{id:'u',role:'user',content,timestamp:'2026-01-01'}]})
  add('source'); add('current'); add('foreign','other')
  const service=new ConsultationReferences(history,store)
  return { history, store, service, add }
}
test('same company only, excludes current; validates selection, deletion and budgets',async t=>{
 const {service,history}=fixture(t); const turn=service.forTurn('company','current')
 const search=JSON.parse(await turn.execute('search_consultations',{query:'桜'})); assert.deepEqual(search.results.map((r:{id:string})=>r.id),['source'])
 const read=JSON.parse(await turn.execute('read_consultation',{id:'source',view:'messages'})); assert.match(read.content,/12万円/); assert.equal(read.originalComplete,true)
 assert.ok(JSON.parse(await turn.execute('read_consultation',{id:'foreign',view:'messages'})).error)
 history.delete('company','source'); assert.ok(JSON.parse(await turn.execute('read_consultation',{id:'source',view:'messages'})).error)
 assert.match(await turn.execute('search_consultations',{query:'桜'}),/上限/)
})
test('memo validates source, reports uncovered correction and paginates large original text',async t=>{
 const {service,history,store,add}=fixture(t)
 const session=history.get('company','source')!; const cursor={index:1,offset:0}
 const markdown=HANDOFF_HEADINGS.map(h=>`## ${h}\n- 予算12万円`).join('\n\n')
 fs.mkdirSync(path.dirname(store.file('company','source')),{recursive:true})
 fs.writeFileSync(store.file('company','source'),JSON.stringify({version:1,turns:1,memo:{cursor,hash:fingerprint(session.messages,cursor),markdown,updatedAt:'2026-01-01',provider:'codex'}}))
 session.messages.push({id:'u2',role:'user',content:'訂正: 予算9万円',timestamp:'2026-01-02'}); history.save('company',session)
 let turn=service.forTurn('company','current'); await turn.execute('search_consultations',{query:'予算'})
 const memo=JSON.parse(await turn.execute('read_consultation',{id:'source',view:'memo'})); assert.equal(memo.hasUncoveredMessages,true)
 assert.match(await turn.execute('read_consultation',{id:'source',view:'messages'}),/9万円/)
 add('large','company','長'.repeat(10000)); turn=service.forTurn('company','current'); await turn.execute('search_consultations',{query:'large'})
 const first=JSON.parse(await turn.execute('read_consultation',{id:'large',view:'messages'})); assert.ok(first.nextOffset); assert.ok(Buffer.byteLength(first.content)<=8192)
 const second=JSON.parse(await turn.execute('read_consultation',{id:'large',view:'messages',offset:first.nextOffset})); assert.ok(second.content.length)
})
test('invalid tool arguments and cancellation cannot escape scope',async t=>{
 const {service}=fixture(t); const controller=new AbortController(); const turn=service.forTurn('company','current',controller.signal)
 assert.ok(JSON.parse(await turn.execute('search_consultations',{query:'桜',company:'other'})).error)
 assert.ok(JSON.parse(await turn.execute('read_consultation',{id:'../other',view:'memo'})).error)
 controller.abort(); await assert.rejects(turn.execute('search_consultations',{query:'桜'}))
})
test('MCP endpoint is token protected and closes',async()=>{
 const server=await startReferenceMcp({execute:async()=>'{"ok":true}'})
 try { const denied=await fetch(server.config.url,{method:'POST'}); assert.equal(denied.status,403)
 const response=await fetch(server.config.url,{method:'POST',headers:{...server.config.http_headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})}); assert.equal(response.status,200); assert.ok((await response.json()).result.capabilities.tools)
 } finally {server.close()}
})

test('source reference parser supports both adapter results and rejects unrelated tools',async()=>{
 const {referenceFromTool}=await import('../shared/consultation-reference')
 const body={id:'source',title:'桜計画',view:'messages',content:'予算'}
 for(const output of [JSON.stringify(body),{content:[{type:'text',text:JSON.stringify(body)}]}]) assert.deepEqual(referenceFromTool('mcp__acb_consultations__read_consultation',output),{id:'source',title:'桜計画'})
 assert.equal(referenceFromTool('Read',body),undefined)
})

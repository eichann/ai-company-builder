import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatHistoryStore } from '../../electron/chat-history-store'
import { HandoffStore, fingerprint } from '../../electron/handoff/store'
import { ConsultationReferences } from '../../electron/consultations/service'
import { HANDOFF_HEADINGS } from '../../electron/handoff/contract'
import type { ChatSession } from '../../shared/chat-history'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acb-reference-benchmark-'))
try {
 for(const count of [100,1000]) {
  const history=new ChatHistoryStore(path.join(dir,'history')); const store=new HandoffStore(path.join(dir,'memos'),history)
  const sessions: ChatSession[]=Array.from({length:count},(_,i)=>({id:'s'+i,companyId:'company',title:'桜計画 '+i,createdAt:'2026-01-01',updatedAt:'2026-01-01',messages:[{id:'u',role:'user',content:'保存された会話。'.repeat(1000),timestamp:'2026-01-01'}]}))
  fs.mkdirSync(path.join(dir,'history'),{recursive:true}); fs.writeFileSync(path.join(dir,'history/company.json'),JSON.stringify({sessions}))
  const markdown=HANDOFF_HEADINGS.map(h=>`## ${h}\n- 桜計画の予算は12万円。`).join('\n\n')
  fs.mkdirSync(path.join(dir,'memos/company'),{recursive:true})
  for(const session of sessions) {const cursor={index:1,offset:0};fs.writeFileSync(store.file('company',session.id),JSON.stringify({version:1,memo:{markdown,cursor,hash:fingerprint(session.messages,cursor)}}))}
  const start=performance.now(); const before=process.memoryUsage().heapUsed; const result=await new ConsultationReferences(history,store).forTurn('company','current').execute('search_consultations',{query:'桜'})
  console.log(JSON.stringify({count,historyBytes:fs.statSync(path.join(dir,'history/company.json')).size,ms:Math.round(performance.now()-start),heapDeltaMiB:Math.round((process.memoryUsage().heapUsed-before)/1024/1024),resultBytes:Buffer.byteLength(result)}))
 }
} finally {fs.rmSync(dir,{recursive:true,force:true})}

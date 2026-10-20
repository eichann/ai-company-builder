import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createCodexConnection } from '../../electron/agents/codex'
const root = process.argv[2]
if (!path.isAbsolute(root || '') || fs.existsSync(root)) throw new Error('Provide a new absolute fixture directory')
fs.mkdirSync(root, { recursive: true })
const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd)
const outside = path.join(root, 'outside.txt')
const requests: string[] = []
const env = Object.fromEntries(Object.entries(process.env).filter((p): p is [string,string] => typeof p[1] === 'string'))
const connection = createCodexConnection({ getShellEnv: () => env, requestToolApproval: async name => { requests.push(name); return { approved: false } }, requestInteraction: async request => { requests.push(request.kind); return { approved: false } } })
let resumeId: string | undefined
for (let step = 0; step < 3; step++) {
 const before = requests.length
 const model = connection.createChatModel({ workingDirectory: cwd, resumeId, effort: 'low' })
 if (typeof model === 'string' || model.specificationVersion !== 'v3') throw new Error('model')
 const text = step < 2 ? `作業ディレクトリにinside-${step}.txtを作り、内容をOKにしてください。実際にファイルを保存してください。` : `検証用に ${outside} にOKを保存してください。作業ディレクトリ外なので、追加許可が必要なら明示的に要求してください。拒否されたら回避せず終了してください。`
 const result = await model.doGenerate({prompt:[{role:'user',content:[{type:'text',text}]}],abortSignal:AbortSignal.timeout(90000)}).catch(error => {
   if (step === 2 && /interrupted/.test(String(error)) && requests.length > before) return undefined
   throw error
 })
 resumeId = connection.readMetadata(result?.providerMetadata).sessionId || resumeId
 assert.ok(resumeId)
 if (step < 2) { assert.match(fs.readFileSync(path.join(cwd,`inside-${step}.txt`),'utf8'),/OK/); assert.equal(requests.length,before) }
 else { assert.ok(requests.slice(before).some(name => ['Bash','Write','permissions'].includes(name)),'outside operation should ask for approval'); assert.equal(fs.existsSync(outside),false) }
 console.log(JSON.stringify({step,approvalRequests:requests.slice(before),passed:true}))
}

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ChatHistoryStore } from '../../electron/chat-history-store'
import { HandoffStore } from '../../electron/handoff/store'
import { HandoffService } from '../../electron/handoff/service'
import { writeClaudeHandoff } from '../../electron/handoff/claude'
import { writeCodexHandoff } from '../../electron/handoff/codex'
import { initial, delta } from './fixture'
import type { ChatSession } from '../../shared/chat-history'
const output = process.argv[2]
if (!path.isAbsolute(output || '')) throw new Error('New absolute output directory required')
fs.mkdirSync(output, { recursive: false })
const history = new ChatHistoryStore(path.join(output, 'history'))
const store = new HandoffStore(path.join(output, 'memos'), history)
const cwd = path.join(output, 'empty-project'); fs.mkdirSync(cwd)
const env = Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => typeof p[1] === 'string'))
const service = new HandoffService(history, store, async (provider, request) => {
  const r = { ...request, env, cwd }
  return provider === 'codex' ? writeCodexHandoff(r) : writeClaudeHandoff({ ...r, cli: process.env.ACB_HANDOFF_CLAUDE_CLI || path.join(os.homedir(), '.local/bin/claude') })
}, () => {}, { idleMs: 50, turns: 2 })
try {
  for (const provider of ['claude-code', 'codex'] as const) {
    const base: ChatSession = { companyId: 'probe', id: provider, title: `自動保存確認 ${provider}`, messages: initial.messages.map((m, i) => ({ ...m, id: `m${i}`, timestamp: '2026-10-20' })), createdAt: '2026-10-20', updatedAt: '2026-10-20' }
    history.save('probe', base)
    const last = base.messages.at(-1)!
    service.complete('probe', provider, { messageId: last.id, content: last.content, provider })
    if (service.view('probe', provider).status !== 'waiting') throw new Error('Too early')
    const next = history.get('probe', provider)!
    next.messages.push(...[...delta, { role: 'assistant' as const, content: 'テストログを先に確認し、ユーザーの画面確認を待ちます。' }].map((m, i) => ({ ...m, id: `d${i}`, timestamp: '2026-10-20' })))
    history.save('probe', next)
    const end = next.messages.at(-1)!
    service.complete('probe', provider, { messageId: end.id, content: end.content, provider })
    const deadline = Date.now() + 70_000
    while (Date.now() < deadline) {
      const view = service.view('probe', provider)
      if (view.status === 'error') throw new Error(view.message)
      if (view.status === 'saved') {
        fs.writeFileSync(path.join(output, `${provider}-memo.md`), view.markdown!)
        fs.writeFileSync(path.join(output, `${provider}-result.json`), JSON.stringify(view, null, 2))
        console.log(JSON.stringify({ provider, status: view.status, metrics: view.metrics }))
        // Reload actual production store, delete, and verify both files are absent.
        if (!new HandoffStore(store.directory, history).read('probe', provider).memo) throw new Error('Restart lost memo')
        history.delete('probe', provider); service.invalidate('probe', provider)
        if (fs.existsSync(store.file('probe', provider)) || fs.existsSync(store.file('probe', provider) + '.bak')) throw new Error('Deletion left a memo')
        break
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (Date.now() >= deadline) throw new Error('Autosave timeout')
  }
} finally { service.dispose() }

// The local chat history (per-device, under userData) and the hand-off memos
// between agents, with their IPC.
import path from 'path'
import fs from 'fs'
import { ChatHistoryStore } from '../../chat-history-store'
import { HandoffStore } from '../../handoff/store'
import { HandoffService } from '../../handoff/service'
import { writeAgentHandoff } from '../../agents/registry'
import type { ClaudeCli } from '../../services/claude-cli'
import type { ShellEnvironment } from '../../services/shell-env'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { AppLifecycle, WindowPort } from '../ports'
import { registerChatHistoryIpc } from './ipc'

export interface ChatHistoryWiring {
  userDataDir: string
  shellEnv: ShellEnvironment
  claudeCli: Pick<ClaudeCli, 'path'>
  /** False while the emergency stop turns AI outside conversations off (no memo is written). */
  aiAllowed: () => boolean
  /** Every window that may show a conversation. */
  windows: WindowPort
  onHandoffChanged: (companyId: string, sessionId: string) => void
  lifecycle: AppLifecycle
}

export function wireChatHistory(ipc: IpcRegistrar, { userDataDir, shellEnv, claudeCli, aiAllowed, windows, onHandoffChanged, lifecycle }: ChatHistoryWiring) {
  const history = new ChatHistoryStore(path.join(userDataDir, 'chat-history'))
  const handoffStore = new HandoffStore(path.join(userDataDir, 'chat-handoffs'), history)
  const handoffs = new HandoffService(history, handoffStore, async (provider, request) => {
    const cwd = path.join(userDataDir, 'handoff-worker')
    fs.mkdirSync(cwd, { recursive: true })
    const input = { ...request, cwd, env: shellEnv.env() }
    return writeAgentHandoff(provider, input, { getCli: claudeCli.path })
  }, onHandoffChanged, { aiAllowed })
  try { handoffStore.cleanupDeleted() } catch { console.warn('[handoff] Startup cleanup deferred: history unavailable') }
  lifecycle.beforeQuit(() => handoffs.dispose())
  // History writes are coalesced and asynchronous; whatever is still pending is written now.
  lifecycle.willQuit(() => history.flushSync())
  const events = registerChatHistoryIpc(ipc, { history, handoffs, window: windows })
  return { history, handoffStore, handoffs, events }
}

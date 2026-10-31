// The composition root: creates the services in dependency order, wires each
// feature (electron/features/<domain>), owns the windows and the app lifecycle.
import { AgentInteractions } from './agent-interactions'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import path from 'path'
import os from 'node:os'
import { fileURLToPath } from 'url'

import { startChatServer } from './chat-server'
import { createMessageBoxSyncDialog } from './sync/message-box-dialog'
import { createCompanyFilesApi } from './company-files/api'
import { createRecordsApi } from './records/api'
import { BUILD_INFO, installServerFetchIdentity } from './client-identity'
import { createWriteAccessStore } from './write-access-store'
import { AllowedRoots } from './allowed-roots'
import { typedIpc } from './ipc/registrar'
import { createConfigStore } from './services/config-store'
import { createApiKeyStore } from './services/api-key-store'
import { createShellEnvironment } from './services/shell-env'
import { configureAgentEnv } from './agents/agent-env'
import { createClaudeCli } from './services/claude-cli'
import { createAppPages, createBroadcastPort, createChatWindowHost, createMainWindowHost, createMessageBoxHost, desktopShell, secretBox, registerLocalFileScheme, serveLocalFiles } from './electron-adapter'
import { diskFiles, registerChatWindowsIpc } from './features/chat-windows/ipc'
import { createSession } from './services/session'
import { registerAuthIpc } from './features/auth/ipc'
import { wireChatHistory } from './features/chat-history/wire'
import { createToolApprovals, registerAgentInteractionsIpc } from './features/agent-interactions/ipc'
import { requestFromOwner } from './features/agent-interactions/owner'
import { wireAgentControl } from './features/agent-control/wire'
import { registerSettingsIpc } from './features/settings/ipc'
import { registerEnvIpc } from './features/env/ipc'
import { registerBackupsIpc } from './features/backups/ipc'
import { registerFsIpc } from './features/fs/ipc'
import { wireSync } from './features/sync/wire'
import { createChatServerConfig } from './features/chat/server-config'
import { registerSkillsIpc } from './features/skills/ipc'
import { skillIsShared } from './features/skills/shared-check'
import { registerCompanySetupIpc } from './features/company-setup/ipc'
import { registerDownloadChoicesIpc } from './features/download-choices/ipc'
import { wirePrivateFolders } from './features/private-folders/wire'
import { wireKeyBroker } from './features/broker/wire'
import { registerGoogleIpc } from './features/google/ipc'
import { registerPluginOperationsIpc } from './features/plugin-operations/ipc'
import type { AppLifecycle } from './features/ports'
import { createAppGit } from './services/app-git'
import type { StoppableTurns } from './services/agent-stop'

// Every channel below is checked against the IPC contract (shared/ipc-contract.ts).
const ipc = typedIpc<IpcMainInvokeEvent, IpcMainEvent>(ipcMain)
// Quit hooks for the features, run in the order they were added.
const lifecycle: AppLifecycle = {
  beforeQuit: fn => { app.on('before-quit', fn) },
  willQuit: fn => { app.on('will-quit', fn) },
}

// Allowed directory roots for file system access control
// Paths are added when the user selects a directory via dialog or sets up a
// company folder. A path must be inside one by name AND by its real location
// (symbolic links resolved): ./allowed-roots.ts.
const allowedRoots = new AllowedRoots()

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const userDataDir = () => app.getPath('userData')

// Settings (<userData>/config.json), the environment for spawned processes,
// and the member's Claude Code CLI (electron/services/).
const config = createConfigStore(() => path.join(userDataDir(), 'config.json'))
// The API key, encrypted by the OS keychain; decrypted only here in main where it is used.
const apiKey = createApiKeyStore(config, secretBox, message => console.log(message))
const shellEnv = createShellEnvironment()
// Every AI process gets an allowlisted environment plus the member's own
// pass-through names (agents/agent-env.ts).
configureAgentEnv({ passthroughNames: () => config.load().agentEnvPassthrough ?? [], serverUrl: () => config.serverUrl() })
const claudeCli = createClaudeCli()

// The page and web preferences every app window shares (electron-adapter.ts).
const appPages = createAppPages(__dirname)
// Set once the consultation windows exist (below): they go with the main window.
let closeChatWindowsWithMain = () => {}
// The main window; closing it first lets the renderer save every open tab.
const mainWindowHost = createMainWindowHost({
  webPreferences: appPages.webPreferences,
  load: win => appPages.load(win),
  askClose: window => window.send('app:closeRequested'),
  docbaseCookie: () => config.load().docbaseCookie,
  onClosed: () => closeChatWindowsWithMain(),
})
// Events to the window (features/ports.ts WindowPort).
const appWindow = mainWindowHost.port
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => { mainWindowHost.focus() })

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null
// Running chat turns (automatic sync waits while the AI works); set once the server started.
let chatTurns: ({ runningCount(): number } & StoppableTurns) | null = null

// local-file:// (images etc. from the company folder); the scheme must be
// registered before app.whenReady().
registerLocalFileScheme()

app.on('before-quit', () => mainWindowHost.quitting())
// The main window's answer to app:closeRequested (only that window may answer).
ipc.handle('app:closeResponse', (event, answer: 'ack' | 'close' | 'stay') => mainWindowHost.answerClose(event.sender.id, answer))

// IPC handler for renderer to request chat server info on demand
ipc.handle('chat-server:getInfo', () => chatServerInfo)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindowHost.open()
})

// 「別ウィンドウで開く」: consultations in windows of their own (features/chat-windows).
const chatWindowShell = createChatWindowHost({
  webPreferences: appPages.webPreferences,
  load: win => appPages.load(win, { window: 'chat' }),
  bounds: {
    load: () => config.load().chatWindowBounds,
    save: bounds => {
      const current = config.load()
      const { x, y, width, height } = bounds
      current.chatWindowBounds = { x, y, width, height }
      config.save(current)
    },
  },
})
// Quitting closes every window without asking (as for the main window's own running turns).
app.on('before-quit', () => chatWindowShell.quitting())
const chatWindows = registerChatWindowsIpc(ipc, {
  host: chatWindowShell.host,
  paths: allowedRoots,
  isMainWindow: senderId => mainWindowHost.isWindow(senderId),
  mainWindow: mainWindowHost.port,
  focusMainWindow: () => mainWindowHost.focus(),
  files: diskFiles,
})
// Their status shows only in the main window's list, so they close with it.
closeChatWindowsWithMain = () => chatWindows.closeAll()
/** The window showing a consultation: its own window when it has one, else the main window. */
function webContentsForSession(appSessionId?: string): WebContents | undefined {
  const windowId = appSessionId ? chatWindows.windowForSession(appSessionId) : undefined
  if (windowId !== undefined) return chatWindowShell.webContents(windowId)
  return mainWindowHost.window()?.webContents
}
function webContentsById(id: number): WebContents | undefined {
  if (mainWindowHost.isWindow(id)) return mainWindowHost.window()?.webContents
  return chatWindowShell.webContents(id)
}
// Conversation events reach every window that may show a conversation.
const conversationWindows = createBroadcastPort(() => [mainWindowHost.window(), ...chatWindowShell.windows()])

registerEnvIpc(ipc, { paths: allowedRoots })
registerSettingsIpc(ipc, { config, apiKey, claudeCli, codexStatus: () => getCodexStatus(shellEnv.env()) })

// A question belongs to the window that showed its conversation when it was asked (its owner).
const agentInteractions = new AgentInteractions((owner, event, request) => {
  const target = webContentsById(owner)
  if (target && !target.isDestroyed()) target.send(`agent-interaction:${event}`, request)
})
// The send stays unguarded, as it always was: a destroyed window rejects the approval.
const toolApprovals = createToolApprovals(request => webContentsForSession(request.appSessionId)?.send('tool-approval-request', request))
registerAgentInteractionsIpc(ipc, { interactions: agentInteractions, approvals: toolApprovals })

// Server API URL - read from config.json (set during first-launch setup) with env fallback
const getServerApiUrl = (): string => config.serverUrl()
// Every fetch() to the server's origin carries X-ACB-Client-Version /
// X-ACB-Client-Platform, so the server knows which build each member runs.
installServerFetchIdentity(getServerApiUrl)
console.log(`[client-identity] build ${BUILD_INFO.version} (built ${BUILD_INFO.builtAt})`)
// The member's session with the server (cookies, in memory only).
const session = createSession()

// The AI policy, the emergency stop (M2) and the AI action log (M1): features/agent-control.
const agentControl = wireAgentControl({ serverUrl: getServerApiUrl, session, userDataDir, home: os.homedir(), turns: () => chatTurns, lifecycle })

// Local chat history and hand-off memos (features/chat-history).
const chatHistory = wireChatHistory(ipc, {
  userDataDir: userDataDir(),
  shellEnv,
  claudeCli,
  aiAllowed: () => agentControl.stop.oneShotAiAllowed(),
  windows: conversationWindows,
  onHandoffChanged: (companyId, sessionId) => conversationWindows.send('handoff:changed', { companyId, sessionId }),
  lifecycle,
})

// Per-folder write access of the signed-in member (shared/write-access.ts).
// The renderer asks when it opens a company and gets writeAccess:changed
// broadcasts after that; the chat refreshes it per turn, sync after success.
const writeAccessStore = createWriteAccessStore({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChange: (companyId, access) => appWindow.send('writeAccess:changed', { companyId, access }),
})
// The key broker's tokens, the member's own keys and skills' tools (features/broker).
const { tokens: brokerTokens } = wireKeyBroker(ipc, { serverUrl: getServerApiUrl, session, paths: allowedRoots, shellEnv, shell: desktopShell, lifecycle })
// 「Google で許可」 (features/google): the session stays here; the sign-in page opens in the browser.
registerGoogleIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, shell: desktopShell })
// The chat card's 「変更前の値を書き戻す」: the person's own action, with the session (never the AI's token).
registerPluginOperationsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// The chat AI's read-only company files (company-files/): the session stays
// here in the main process; answers are cached briefly per member.
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })
const recordsApi = createRecordsApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })

registerAuthIpc(ipc, {
  session,
  serverUrl: getServerApiUrl,
  onSignedOut: () => {
    writeAccessStore.clear()
    agentControl.signedOut()
    brokerTokens.clear()
    companyFilesApi.clear()
    // Another account must not find this one's consultations on screen.
    chatWindows.closeAll()
  },
  onSignedIn: () => agentControl.eventSender.sessionStarted(),
})

// The app's git (binary, credentials, guarded configuration: services/app-git.ts).
const appGit = createAppGit({ token: session.gitToken, appGitDir: () => path.join(userDataDir(), 'git') })

// Skills (features/skills).
const skills = registerSkillsIpc(ipc, {
  paths: allowedRoots,
  isShared: (rootPath, relFolder) => skillIsShared(appGit.create(rootPath, { GIT_NO_LAZY_FETCH: '1' }), relFolder),
})

// The sync button, automatic sync and the history views (features/sync, features/git-history).
const { gitSync, activity: syncActivity } = wireSync(ipc, {
  paths: allowedRoots,
  appGit,
  userDataDir,
  dialog: createMessageBoxSyncDialog(createMessageBoxHost(mainWindowHost.window)),
  serverUrl: getServerApiUrl,
  session,
  writeAccess: writeAccessStore,
  aiRunning: () => (chatTurns?.runningCount() ?? 0) > 0,
  config,
  apiKey: apiKey.read,
  claudeCli,
  shellEnv,
  aiAllowed: () => agentControl.stop.oneShotAiAllowed(),
})

// Private folders: the 「新しいフォルダ…」 dialog, the lock icons and the guards
// the chat and the file operations ask (features/private-folders).
const privateFolderGuards = wirePrivateFolders(ipc, { serverUrl: getServerApiUrl, session, paths: allowedRoots, pathChecker: gitSync.pathChecker, activity: syncActivity })

// The company folder on disk (features/fs): file tree, editor, watchers.
const files = registerFsIpc(ipc, {
  paths: allowedRoots,
  shell: desktopShell,
  window: appWindow,
  reservedRefusal: absPath => privateFolderGuards.reservedRefusal(absPath),
  // A skill the AI (or anything else) created, changed or removed is scanned
  // afresh by the next skills:list.
  onFileChanges: changes => skills.invalidateForChanges(changes),
})
lifecycle.beforeQuit(() => files.closeWatchers())

// Setting a company folder up, and what this computer downloads
// (features/company-setup, features/download-choices).
registerCompanySetupIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, userDataDir })
registerDownloadChoicesIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, privateFolders: gitSync, activity: syncActivity })

registerBackupsIpc(ipc, { paths: allowedRoots, shell: desktopShell, reservedRefusal: absPath => privateFolderGuards.reservedRefusal(absPath) })

// Startup runs last, once every store and service above is initialised: the
// chat server config below captures them, and keeping the use after the
// declaration makes no-use-before-define (TDZ) hold by construction.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  registerVoiceInput(claudeCli.path, shellEnv.env, () => ({ authMode: config.authMode(), apiKey: apiKey.read() }), () => agentControl.stop.oneShotAiAllowed())
  serveLocalFiles(allowedRoots)
  // Start embedded Hono chat server
  try {
    const serverConfig = createChatServerConfig({
      config,
      apiKey: apiKey.read,
      claudeCli,
      shellEnv,
      history: chatHistory.history,
      handoffStore: chatHistory.handoffStore,
      handoffs: chatHistory.handoffs,
      chatHistory: chatHistory.events,
      writeAccess: writeAccessStore,
      privateFolders: privateFolderGuards,
      companyFiles: companyFilesApi,
      records: recordsApi,
      toolApprovals,
      cancelChoicePrompts: appSessionId => agentInteractions.cancelConversation(appSessionId),
      agentEvents: agentControl.events,
      agentPolicy: agentControl.policy,
      agentStop: agentControl.stop,
      serverUrl: getServerApiUrl,
      brokerTokens,
      requestInteraction: (request, appSessionId, signal) =>
        requestFromOwner(agentInteractions, webContentsForSession(appSessionId), request, appSessionId, signal),
    })
    const result = await startChatServer(serverConfig)
    chatServerInfo = { port: result.port, authToken: result.authToken }
    chatTurns = result.turns
  } catch (err) {
    console.error('[chat-server] Failed to start:', err)
  }

  mainWindowHost.open()

  // Send chat server info to renderer once window is ready
  const mainWindow = mainWindowHost.window()
  if (mainWindow && chatServerInfo) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('chat-server:info', chatServerInfo)
    })
  }
})

import { AgentInteractions } from './agent-interactions'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebPreferences } from 'electron'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

import { startChatServer } from './chat-server'
import { createGitSync } from './sync/git-sync'
import { createMessageBoxSyncDialog } from './sync/message-box-dialog'
import { createFetchSyncServerApi } from './sync/server-api'
import { createCompanyFilesApi } from './company-files/api'
import { HandoffStore } from './handoff/store'
import { HandoffService } from './handoff/service'
import { writeAgentHandoff } from './agents/registry'
import { ChatHistoryStore } from './chat-history-store'
import { BUILD_INFO, installServerFetchIdentity } from './client-identity'
import { createWriteAccessStore } from './write-access-store'
import { createPrivateFoldersApi } from './private-folders-api'
import { AllowedRoots } from './allowed-roots'
import { typedIpc } from './ipc/registrar'
import { createConfigStore } from './services/config-store'
import { createApiKeyStore } from './services/api-key-store'
import { createShellEnvironment } from './services/shell-env'
import { configureAgentEnv } from './agents/agent-env'
import { createClaudeCli } from './services/claude-cli'
import { createBroadcastPort, createChatWindowHost, createMessageBoxHost, createWindowPort, desktopShell, secretBox, registerLocalFileScheme, serveLocalFiles } from './electron-adapter'
import { registerChatWindowsIpc } from './features/chat-windows/ipc'
import { notDownloadedFolderFor } from './sync/not-downloaded'
import { createSession } from './services/session'
import { registerAuthIpc } from './features/auth/ipc'
import { registerChatHistoryIpc } from './features/chat-history/ipc'
import { createToolApprovals, registerAgentInteractionsIpc } from './features/agent-interactions/ipc'
import { registerSettingsIpc } from './features/settings/ipc'
import { registerEnvIpc } from './features/env/ipc'
import { registerBackupsIpc } from './features/backups/ipc'
import { registerFsIpc } from './features/fs/ipc'
import { registerSyncIpc } from './features/sync/ipc'
import { createChatServerConfig } from './features/chat/server-config'
import { registerSkillsIpc } from './features/skills/ipc'
import { skillIsShared } from './features/skills/shared-check'
import { registerToolsIpc } from './features/tools/ipc'
import { registerCompanySetupIpc } from './features/company-setup/ipc'
import { registerDownloadChoicesIpc } from './features/download-choices/ipc'
import { registerPrivateFoldersIpc } from './features/private-folders/ipc'
import { registerBrokerIpc } from './features/broker/ipc'
import { createBrokerTokenStore } from './services/broker-token-store'
import { createPrivateFolderGuards } from './features/private-folders/guards'
import { registerGitHistoryIpc } from './features/git-history/ipc'
import { createAppGit } from './services/app-git'
import { createCommitMessages } from './services/commit-messages'
import { createAgentEventRecorder } from './services/agent-events'
import { createAgentEventSender } from './services/agent-event-sender'
import { createAgentPolicyStore } from './services/agent-policy-store'
import { createAgentPushChannel } from './services/agent-push-channel'
import { createAgentStop, type StoppableTurns } from './services/agent-stop'
import { createSyncActivity } from './services/sync-activity'
import os from 'node:os'

// Every channel below is checked against the IPC contract (shared/ipc-contract.ts).
const ipc = typedIpc<IpcMainInvokeEvent, IpcMainEvent>(ipcMain)

// Allowed directory roots for file system access control
// Paths are added when the user selects a directory via dialog or sets up a
// company folder. A path must be inside one by name AND by its real location
// (symbolic links resolved): ./allowed-roots.ts.
const allowedRoots = new AllowedRoots()

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
// Events to the window (features/ports.ts WindowPort).
const appWindow = createWindowPort(() => mainWindow)
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

// Settings (<userData>/config.json), the environment for spawned processes,
// and the member's Claude Code CLI (electron/services/).
const config = createConfigStore(() => path.join(app.getPath('userData'), 'config.json'))
// The API key, encrypted by the OS keychain; decrypted only here in main where it is used.
const apiKey = createApiKeyStore(config, secretBox, message => console.log(message))
const shellEnv = createShellEnvironment()
// Every AI process gets an allowlisted environment plus the member's own
// pass-through names (agents/agent-env.ts).
configureAgentEnv({ passthroughNames: () => config.load().agentEnvPassthrough ?? [], serverUrl: () => config.serverUrl() })
const claudeCli = createClaudeCli()


/**
 * The web preferences of every app window: the main one and the consultation
 * windows (「別ウィンドウで開く」) share this one copy — isolated, sandboxed, no
 * Node, the one preload; the page's CSP comes with index.html.
 */
function appWebPreferences(): WebPreferences {
  const disableElectronSpellcheck =
    process.env.ELECTRON_DISABLE_SPELLCHECK === '1' ||
    process.env.ELECTRON_DISABLE_SPELL_CHECKING === '1'
  return {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    // Reversible A/B test switch for input lag diagnosis.
    spellcheck: !disableElectronSpellcheck,
    // Required for the in-iframe Chromium PDF Viewer to render `blob:` PDFs in
    // packaged builds. Without this, dev (HTTP origin) happens to work but the
    // production file:// origin blocks the embedded PDF viewer.
    plugins: true,
  }
}

/** The app's page; `?window=chat` shows only one consultation (src/main.tsx). */
function loadAppPage(win: BrowserWindow, query?: Record<string, string>) {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'), query ? { query } : undefined)
  }
}

// Set once the consultation windows exist (below): they go with the main window.
let closeChatWindowsWithMain = () => {}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: appWebPreferences(),
  })
  mainWindow.on('closed', () => closeChatWindowsWithMain())
  // Fully disable spell checker to prevent dictionary loading overhead (especially for Japanese IME)
  mainWindow.webContents.session.setSpellCheckerLanguages([])

  // Inject DocBase cookie for image.docbase.io requests (fixes 403 on DocBase images)
  const appConfig = config.load()
  if (appConfig.docbaseCookie) {
    const docbaseCookie = appConfig.docbaseCookie
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://image.docbase.io/*'] },
      (details, callback) => {
        details.requestHeaders['Cookie'] = docbaseCookie
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }

  // DevTools disabled for performance testing: mainWindow.webContents.openDevTools() to enable.
  loadAppPage(mainWindow)
}

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null
// Running chat turns (automatic sync waits while the AI works); set once the server started.
let chatTurns: ({ runningCount(): number } & StoppableTurns) | null = null

// local-file:// (images etc. from the company folder); the scheme must be
// registered before app.whenReady().
registerLocalFileScheme()

// IPC handler for renderer to request chat server info on demand
ipc.handle('chat-server:getInfo', () => {
  return chatServerInfo
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// 「別ウィンドウで開く」: consultations in windows of their own (features/chat-windows).
const chatWindowShell = createChatWindowHost({
  webPreferences: appWebPreferences,
  load: win => loadAppPage(win, { window: 'chat' }),
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
  isMainWindow: senderId => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId,
  mainWindow: createWindowPort(() => mainWindow),
  focusMainWindow: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return true
  },
  files: {
    notDownloadedFolder: notDownloadedFolderFor,
    isFile: filePath => { try { return fs.statSync(filePath).isFile() } catch { return false } },
  },
})
// Their status shows only in the main window's list, so they close with it.
closeChatWindowsWithMain = () => chatWindows.closeAll()
/** The window showing a consultation: its own window when it has one, else the main window. */
function webContentsForSession(appSessionId?: string): WebContents | undefined {
  const windowId = appSessionId ? chatWindows.windowForSession(appSessionId) : undefined
  if (windowId !== undefined) return chatWindowShell.webContents(windowId)
  return mainWindow?.webContents
}
function webContentsById(id: number): WebContents | undefined {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === id) return mainWindow.webContents
  return chatWindowShell.webContents(id)
}
// Conversation events reach every window that may show a conversation.
const conversationWindows = createBroadcastPort(() => [mainWindow, ...chatWindowShell.windows()])

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
// Local history stays in the existing per-device userData directory.
const localHistoryStore = new ChatHistoryStore(path.join(app.getPath('userData'), 'chat-history'))
const handoffStore = new HandoffStore(path.join(app.getPath('userData'), 'chat-handoffs'), localHistoryStore)
// The emergency stop turns AI outside conversations off (hand-off memos, voice formatting, titles);
// bound once the stop exists below — nothing runs AI before startup.
let oneShotAiAllowed = (): boolean => true
const handoffs = new HandoffService(localHistoryStore, handoffStore, async (provider, request) => {
  const cwd = path.join(app.getPath('userData'), 'handoff-worker')
  fs.mkdirSync(cwd, { recursive: true })
  const input = { ...request, cwd, env: shellEnv.env() }
  return writeAgentHandoff(provider, input, { getCli: claudeCli.path })
}, (companyId, sessionId) => conversationWindows.send('handoff:changed', { companyId, sessionId }), { aiAllowed: () => oneShotAiAllowed() })
try { handoffStore.cleanupDeleted() } catch { console.warn('[handoff] Startup cleanup deferred: history unavailable') }
app.on('before-quit', () => handoffs.dispose())
// History writes are coalesced and asynchronous; whatever is still pending is written now.
app.on('will-quit', () => localHistoryStore.flushSync())
const chatHistory = registerChatHistoryIpc(ipc, { history: localHistoryStore, handoffs, window: conversationWindows })

// Server API URL - read from config.json (set during first-launch setup) with env fallback
function getServerApiUrl(): string {
  return config.serverUrl()
}

// Every fetch() to the server's origin carries X-ACB-Client-Version /
// X-ACB-Client-Platform, so the server knows which build each member runs.
installServerFetchIdentity(getServerApiUrl)
console.log(`[client-identity] build ${BUILD_INFO.version} (built ${BUILD_INFO.builtAt})`)

// The member's session with the server (cookies, in memory only).
const session = createSession()

// Per-folder write access of the signed-in member (shared/write-access.ts).
// The renderer asks when it opens a company and gets writeAccess:changed
// broadcasts after that; the chat refreshes it per turn, sync after success.
const writeAccessStore = createWriteAccessStore({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChange: (companyId, access) => appWindow.send('writeAccess:changed', { companyId, access }),
})
// The chat AI's read-only company files (company-files/): the session stays
// here in the main process; answers are cached briefly per member.
// The member's AI policy per company (「AI の囲い」; M2's stop joins it), read at each chat turn.
// The stop part is also kept on disk per account (the emergency stop survives a restart offline).
const agentPolicyStore = createAgentPolicyStore({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  userId: session.userId,
  dir: () => path.join(app.getPath('userData'), 'agent-policy'),
})
// The emergency stop (M2): the push channel's only effect is a policy refetch;
// a received stop stops the company's running turns (services/agent-stop.ts).
const agentPushChannel = createAgentPushChannel({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  refresh: (companyId, version) => {
    if (version && agentPolicyStore.get(companyId)?.version === version) return
    void agentPolicyStore.refresh(companyId)
  },
})
app.on('before-quit', () => agentPushChannel.stopAll())
const agentStop = createAgentStop({ policy: agentPolicyStore, watch: companyId => agentPushChannel.watch(companyId), turns: () => chatTurns })
oneShotAiAllowed = () => agentStop.oneShotAiAllowed()
// The key broker's short-lived tokens (memory only; key-broker.md K6).
const brokerTokens = createBrokerTokenStore({ baseUrl: getServerApiUrl, cookies: session.cookies })
// Skills' web-app tools (features/tools): they get the key broker's variables like the chat.
const tools = registerToolsIpc(ipc, { paths: allowedRoots, shellEnv, shell: desktopShell, brokerEnv: request => brokerTokens.envFor(request) })
app.on('before-quit', () => tools.stopAll())
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })

// The AI action log (monitoring M1): the recorder (memory + console) and its
// sender, which queues per signed-in account and company under
// <userData>/agent-events and posts to the server (services/agent-event-sender.ts).
const agentEventSender = createAgentEventSender({
  dir: () => path.join(app.getPath('userData'), 'agent-events'),
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  userId: session.userId,
})
app.on('will-quit', () => agentEventSender.flushSync())
const agentEvents = createAgentEventRecorder({ home: os.homedir(), appDataDirs: [app.getPath('userData')], sinks: [agentEventSender] })

registerAuthIpc(ipc, {
  session,
  serverUrl: getServerApiUrl,
  onSignedOut: () => {
    writeAccessStore.clear()
    agentPolicyStore.clear()
    agentPushChannel.stopAll()
    brokerTokens.clear()
    companyFilesApi.clear()
    agentEventSender.signedOut()
    // Another account must not find this one's consultations on screen.
    chatWindows.closeAll()
  },
  onSignedIn: () => agentEventSender.sessionStarted(),
})

// The app's git (binary, credentials, guarded configuration) and sync's
// commit messages (electron/services/).
const appGit = createAppGit({ token: session.gitToken, appGitDir: () => path.join(app.getPath('userData'), 'git') })
const createGit = appGit.create

// Skills (features/skills); their web-app tools are registered with the key broker's tokens below.
const skills = registerSkillsIpc(ipc, {
  paths: allowedRoots,
  isShared: (rootPath, relFolder) => skillIsShared(appGit.create(rootPath, { GIT_NO_LAZY_FETCH: '1' }), relFolder),
})
const commitMessageGenerator = createCommitMessages({
  config,
  apiKey: apiKey.read,
  claudeCli,
  shellEnv,
  cwd: () => path.join(app.getPath('userData'), 'commit-message'),
  aiAllowed: () => agentStop.oneShotAiAllowed(),
})
const generateCommitMessage = commitMessageGenerator(createGit)

// The working tree and its history for the sync preview, the diff views,
// the search tab and Cmd+P (features/git-history).
registerGitHistoryIpc(ipc, { paths: allowedRoots, git: appGit, commitMessagesFor: commitMessageGenerator })

// git:sync lives in ./sync/git-sync.ts (testable without Electron — see
// tests/sync-harness). This wires the app's git, dialogs and server API in.
const gitSync = createGitSync({
  createGit,
  dialog: createMessageBoxSyncDialog(createMessageBoxHost(() => mainWindow)),
  api: createFetchSyncServerApi({ baseUrl: getServerApiUrl, cookies: session.cookies }),
  generateCommitMessage,
  now: () => new Date(),
  platform: process.platform,
  log: console,
})

// Download-choice changes and private-folder creation, which automatic sync waits for.
const syncActivity = createSyncActivity()
registerSyncIpc(ipc, {
  paths: allowedRoots,
  gitSync,
  writeAccess: writeAccessStore,
  activity: syncActivity,
  aiRunning: () => (chatTurns?.runningCount() ?? 0) > 0,
})

// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons; the guards the chat and the file operations ask (features/private-folders).
const privateFoldersApi = createPrivateFoldersApi({ baseUrl: getServerApiUrl, cookies: session.cookies })
const privateFolderGuards = createPrivateFolderGuards({ api: privateFoldersApi, pathChecker: gitSync.pathChecker })
registerPrivateFoldersIpc(ipc, { paths: allowedRoots, api: privateFoldersApi, guards: privateFolderGuards, activity: syncActivity })

// The member's own API keys (「自分の鍵」, features/broker; key-broker.md).
registerBrokerIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, paths: allowedRoots })

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
app.on('before-quit', () => files.closeWatchers())

// Setting a company folder up, and what this computer downloads
// (features/company-setup, features/download-choices).
registerCompanySetupIpc(ipc, {
  paths: allowedRoots,
  appGit,
  session,
  serverUrl: getServerApiUrl,
  userDataDir: () => app.getPath('userData'),
})
registerDownloadChoicesIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, privateFolders: gitSync, activity: syncActivity })

registerBackupsIpc(ipc, { paths: allowedRoots, shell: desktopShell, reservedRefusal: absPath => privateFolderGuards.reservedRefusal(absPath) })

// Startup runs last, once every store and service above is initialised: the
// chat server config below captures them, and keeping the use after the
// declaration makes no-use-before-define (TDZ) hold by construction.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  registerVoiceInput(claudeCli.path, shellEnv.env, () => ({ authMode: config.authMode(), apiKey: apiKey.read() }), () => agentStop.oneShotAiAllowed())
  serveLocalFiles(allowedRoots)
  // Start embedded Hono chat server
  try {
    const serverConfig = createChatServerConfig({
      config,
      apiKey: apiKey.read,
      claudeCli,
      shellEnv,
      history: localHistoryStore,
      handoffStore,
      handoffs,
      chatHistory,
      writeAccess: writeAccessStore,
      privateFolders: privateFolderGuards,
      companyFiles: companyFilesApi,
      toolApprovals,
      cancelChoicePrompts: appSessionId => agentInteractions.cancelConversation(appSessionId),
      agentEvents,
      agentPolicy: agentPolicyStore,
      agentStop,
      serverUrl: getServerApiUrl,
      brokerTokens,
      requestInteraction: (request, appSessionId, signal) => {
        const owner = webContentsForSession(appSessionId)
        if (!owner || owner.isDestroyed()) return Promise.resolve({ cancelled: true })
        const ownerId = owner.id
        const close = () => agentInteractions.closeOwner(ownerId)
        owner.once('destroyed', close)
        owner.once('did-start-navigation', close)
        return agentInteractions.request(ownerId, appSessionId, request, signal).finally(() => {
          owner.removeListener('destroyed', close)
          owner.removeListener('did-start-navigation', close)
        })
      },
    })
    const result = await startChatServer(serverConfig)
    chatServerInfo = { port: result.port, authToken: result.authToken }
    chatTurns = result.turns
  } catch (err) {
    console.error('[chat-server] Failed to start:', err)
  }

  createWindow()

  // Send chat server info to renderer once window is ready
  if (mainWindow && chatServerInfo) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.send('chat-server:info', chatServerInfo)
    })
  }
})

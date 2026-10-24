import { AgentInteractions } from './agent-interactions'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
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
import { writeClaudeHandoff } from './handoff/claude'
import { writeCodexHandoff } from './handoff/codex'
import { ChatHistoryStore } from './chat-history-store'
import { BUILD_INFO, installServerFetchIdentity } from './client-identity'
import { createWriteAccessStore } from './write-access-store'
import { createPrivateFoldersApi } from './private-folders-api'
import { AllowedRoots } from './allowed-roots'
import { typedIpc } from './ipc/registrar'
import { createConfigStore } from './services/config-store'
import { createShellEnvironment } from './services/shell-env'
import { createClaudeCli } from './services/claude-cli'
import { createMessageBoxHost, createWindowPort, desktopShell, registerLocalFileScheme, serveLocalFiles } from './electron-adapter'
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
import { registerToolsIpc } from './features/tools/ipc'
import { registerCompanySetupIpc } from './features/company-setup/ipc'
import { registerDownloadChoicesIpc } from './features/download-choices/ipc'
import { registerPrivateFoldersIpc } from './features/private-folders/ipc'
import { createPrivateFolderGuards } from './features/private-folders/guards'
import { registerGitHistoryIpc } from './features/git-history/ipc'
import { createAppGit } from './services/app-git'
import { createCommitMessages } from './services/commit-messages'

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
const shellEnv = createShellEnvironment()
const claudeCli = createClaudeCli()

// Skills and their web-app tools (features/skills, features/tools).
const skills = registerSkillsIpc(ipc, { paths: allowedRoots })
const tools = registerToolsIpc(ipc, { paths: allowedRoots, shellEnv, shell: desktopShell })

function createWindow() {
  const disableElectronSpellcheck =
    process.env.ELECTRON_DISABLE_SPELLCHECK === '1' ||
    process.env.ELECTRON_DISABLE_SPELL_CHECKING === '1'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Reversible A/B test switch for input lag diagnosis.
      spellcheck: !disableElectronSpellcheck,
      // Required for the in-iframe Chromium PDF Viewer to render `blob:` PDFs in
      // packaged builds. Without this, dev (HTTP origin) happens to work but the
      // production file:// origin blocks the embedded PDF viewer.
      plugins: true,
    },
  })

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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // DevTools disabled for performance testing - uncomment below line to enable
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null

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

// On quit: stop the skill tools (the company watchers close in their own handler, registered below).
app.on('before-quit', () => tools.stopAll())

registerEnvIpc(ipc, { paths: allowedRoots })

registerSettingsIpc(ipc, { config, claudeCli, codexStatus: () => getCodexStatus(shellEnv.env()) })

const agentInteractions = new AgentInteractions((owner, event, request) => {
  const target = mainWindow?.webContents
  if (target && !target.isDestroyed() && target.id === owner) target.send(`agent-interaction:${event}`, request)
})
// The send stays unguarded, as it always was: a destroyed window rejects the approval.
const toolApprovals = createToolApprovals(request => mainWindow?.webContents.send('tool-approval-request', request))
registerAgentInteractionsIpc(ipc, { interactions: agentInteractions, approvals: toolApprovals })

// Local history stays in the existing per-device userData directory.
const localHistoryStore = new ChatHistoryStore(path.join(app.getPath('userData'), 'chat-history'))
const handoffStore = new HandoffStore(path.join(app.getPath('userData'), 'chat-handoffs'), localHistoryStore)
const handoffs = new HandoffService(localHistoryStore, handoffStore, async (provider, request) => {
  const cwd = path.join(app.getPath('userData'), 'handoff-worker')
  fs.mkdirSync(cwd, { recursive: true })
  const input = { ...request, cwd, env: shellEnv.env() }
  return provider === 'claude-code' ? writeClaudeHandoff({ ...input, cli: claudeCli.path() }) : writeCodexHandoff(input)
}, (companyId, sessionId) => appWindow.send('handoff:changed', { companyId, sessionId }))
try { handoffStore.cleanupDeleted() } catch { console.warn('[handoff] Startup cleanup deferred: history unavailable') }
app.on('before-quit', () => handoffs.dispose())
// History writes are coalesced and asynchronous; whatever is still pending is written now.
app.on('will-quit', () => localHistoryStore.flushSync())
const chatHistory = registerChatHistoryIpc(ipc, { history: localHistoryStore, handoffs, window: appWindow })

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
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })

registerAuthIpc(ipc, {
  session,
  serverUrl: getServerApiUrl,
  onSignedOut: () => {
    writeAccessStore.clear()
    companyFilesApi.clear()
  },
})

// The app's git (binary, credentials, guarded configuration) and sync's
// commit messages (electron/services/).
const appGit = createAppGit({ token: session.gitToken, appGitDir: () => path.join(app.getPath('userData'), 'git') })
const createGit = appGit.create
const commitMessageGenerator = createCommitMessages({
  config,
  claudeCli,
  shellEnv,
  cwd: () => path.join(app.getPath('userData'), 'commit-message'),
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

registerSyncIpc(ipc, { paths: allowedRoots, gitSync, writeAccess: writeAccessStore })

// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons; the guards the chat and the file operations ask (features/private-folders).
const privateFoldersApi = createPrivateFoldersApi({ baseUrl: getServerApiUrl, cookies: session.cookies })
const privateFolderGuards = createPrivateFolderGuards({ api: privateFoldersApi, pathChecker: gitSync.pathChecker })
registerPrivateFoldersIpc(ipc, { paths: allowedRoots, api: privateFoldersApi, guards: privateFolderGuards })

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
registerDownloadChoicesIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, privateFolders: gitSync })

registerBackupsIpc(ipc, { paths: allowedRoots, shell: desktopShell })

// Startup runs last, once every store and service above is initialised: the
// chat server config below captures them, and keeping the use after the
// declaration makes no-use-before-define (TDZ) hold by construction.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  registerVoiceInput(claudeCli.path, shellEnv.env, () => ({ authMode: config.authMode(), apiKey: config.load().anthropicApiKey }))
  serveLocalFiles(allowedRoots)
  // Start embedded Hono chat server
  try {
    const serverConfig = createChatServerConfig({
      config,
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
      requestInteraction: (request, appSessionId, signal) => {
        const owner = mainWindow?.webContents
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

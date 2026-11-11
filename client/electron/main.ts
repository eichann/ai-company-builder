// The composition root: creates the services in dependency order, wires each
// feature (electron/features/<domain>), owns the windows and the app lifecycle.
import { AgentInteractions } from './agent-interactions'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import path from 'path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
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
import { createAppPages, createBroadcastPort, createDrivePickerWindow, createChatWindowHost, createMainWindowHost, createMessageBoxHost, desktopShell, guardEverySession, receiveAppLinks, secretBox, registerLocalFileScheme, serveLocalFiles } from './electron-adapter'
import { diskFiles, registerChatWindowsIpc } from './features/chat-windows/ipc'
import { createSession } from './services/session'
import { registerAuthIpc } from './features/auth/ipc'
import { wireChatHistory } from './features/chat-history/wire'
import { createToolApprovals, registerAgentInteractionsIpc } from './features/agent-interactions/ipc'
import { requestFromOwner } from './features/agent-interactions/owner'
import { wireAgentControl } from './features/agent-control/wire'
import { registerSettingsIpc } from './features/settings/ipc'
import { registerAppLinkIpc } from './features/app-link/ipc'
import { APP_LINK_SCHEME, appLinkInArgs } from './features/app-link/link'
import { registerEnvIpc } from './features/env/ipc'
import { registerBackupsIpc } from './features/backups/ipc'
import { registerFsIpc } from './features/fs/ipc'
import { wireSync } from './features/sync/wire'
import { createChatServerConfig } from './features/chat/server-config'
import { registerSkillsIpc } from './features/skills/ipc'
import { createShelfClient } from './features/skill-shelf/client'
import { registerSkillShelfIpc } from './features/skill-shelf/ipc'
import { createSkillShelfStore } from './features/skill-shelf/store'
import { skillIsShared } from './features/skills/shared-check'
import { registerCompanySetupIpc } from './features/company-setup/ipc'
import { registerDownloadChoicesIpc } from './features/download-choices/ipc'
import { wirePrivateFolders } from './features/private-folders/wire'
import { wireKeyBroker } from './features/broker/wire'
import { registerGoogleIpc } from './features/google/ipc'
import { createDrivePicking } from './features/google/drive'
import { registerCalendarIpc } from './features/calendar/ipc'
import { registerTasksIpc } from './features/tasks/ipc'
import { registerPluginOperationsIpc } from './features/plugin-operations/ipc'
import { registerRecordViewsIpc } from './features/record-views/ipc'
import { registerApprovalsIpc } from './features/approvals/ipc'
import { registerAbsencesIpc } from './features/absences/ipc'
import { registerJobsIpc } from './features/jobs/ipc'
import { registerWorkSwitchesIpc } from './features/work-switches/ipc'
import { registerViewersIpc } from './features/viewers/ipc'
import { createMinutesChecker } from './features/minutes/checker'
import { registerMinutesIpc } from './features/minutes/ipc'
import { createMeetingsApi } from './features/minutes/meetings'
import { createAiTurnClaims } from './features/ai-turns/claims'
import { newFilesByGit, newFilesByTime } from './features/ai-turns/job-runs'
import { createRunRegistry } from './records/runs'
import { registerAiTurnsIpc } from './features/ai-turns/ipc'
import { createNotificationsWatcher } from './features/notifications/watcher'
import { registerNotificationsIpc } from './features/notifications/ipc'
import { fileShownStore } from './features/notifications/shown-store'
import { registerOutboundMailIpc } from './features/outbound-mail/ipc'
import type { AppLifecycle } from './features/ports'
import { createAppGit } from './services/app-git'
import { createWorkingFolders, withoutWorkingFolders } from './services/working-folders'
import { createSkillUseReporter } from './services/skill-use-reporter'
import type { StoppableTurns } from './services/agent-stop'
// Lanes (ipc-and-main-process.md "Lane markers"): add only right under your lane's ▼.
// lane A ▼
import { registerSlackIpc } from './features/slack/ipc'
import { registerThreadsIpc } from './features/threads/ipc'
import { registerPluginBridgeIpc } from './features/plugins/bridge-ipc'
import { createPluginFileServer } from './features/plugins/protocol'
import { registerPluginScreensIpc } from './features/plugins/screens'
import { servePluginFiles } from './electron-adapter'
// lane A ▲
// lane B ▼
// lane B ▲
// lane C ▼
import { createProcedureReader } from './features/ai-turns/procedures'
import { createPersonStepBinder, registerPluginStepsIpc } from './features/plugin-steps/ipc'
import { createStepWriteAreas } from './features/plugin-steps/write-areas'
import { registerAppCommandsIpc } from './features/app-commands/ipc'
// lane C ▲

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
// Set once sync is wired (below): closing the window waits for a running sync.
let syncBeforeClose: { isRunning(): boolean; whenIdle(): Promise<void>; resumeAutomaticRuns(): void } | null = null
// The main window; closing it first lets the renderer save every open tab.
const mainWindowHost = createMainWindowHost({
  webPreferences: appPages.webPreferences,
  page: appPages.page,
  load: win => appPages.load(win),
  askClose: window => window.send('app:closeRequested'),
  docbaseCookie: () => config.load().docbaseCookie,
  onClosed: () => closeChatWindowsWithMain(),
  sync: () => syncBeforeClose,
})
// Events to the window (features/ports.ts WindowPort).
const appWindow = mainWindowHost.port
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => { mainWindowHost.focus() })
// The server address from an invitation's 「アプリを開く」 (features/app-link): offered only,
// the member confirms it on the server screen. Focus the window on every link.
const appLinks = registerAppLinkIpc(ipc, {
  currentServer: () => config.serverUrl(),
  saveServer: origin => {
    const current = config.load()
    current.serverUrl = origin
    config.save(current)
  },
  log: message => console.warn(message),
})
receiveAppLinks(APP_LINK_SCHEME, raw => { appLinks.offer(raw); mainWindowHost.focus() }, appLinkInArgs)

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null
// Running chat turns (automatic sync waits while the AI works); set once the server started.
let chatTurns: ({ runningCount(): number } & StoppableTurns) | null = null

// local-file:// (images etc. from the company folder); the scheme must be
// registered before app.whenReady().
registerLocalFileScheme()
// Web permissions: only what the app's own page uses (permission-policy.ts),
// on every session, before any window exists.
guardEverySession(appPages.page())

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
  page: appPages.page,
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
// The app's commands the consultation AI may run (the middle's tabs): only in the main window.
const appCommands = registerAppCommandsIpc(ipc, {
  mainWindowId: () => mainWindowHost.window()?.webContents.id,
  mainWindow: mainWindowHost.port,
  inOwnWindow: sessionId => chatWindows.windowForSession(sessionId) !== undefined,
})
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
// Set once 「議事録が届きました」 exists (below): a records signal only makes it ask the server again.
let recordsSignal: (companyId: string) => void = () => {}
let noticesSignal: (companyId: string) => void = () => {}
const agentControl = wireAgentControl({
  serverUrl: getServerApiUrl, session, userDataDir, home: os.homedir(), turns: () => chatTurns, lifecycle,
  onRecords: companyId => recordsSignal(companyId),
  onNotifications: companyId => noticesSignal(companyId),
  onPluginsChanged: companyId => appWindow.send('plugins:changed', { companyId }),
})
// 「議事録が届きました」 (features/minutes): checked with the session here, only while Google may read minutes.
const minutes = createMinutesChecker({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChanged: companyId => appWindow.send('minutes:changed', { companyId }),
  watchSignals: companyId => agentControl.watchSignals(companyId),
})
lifecycle.beforeQuit(() => minutes.stop())
registerMinutesIpc(ipc, minutes, createMeetingsApi({
  baseUrl: getServerApiUrl, cookies: session.cookies,
  // ［AI に読ませる］ accepted: the runner's queue (received minutes) is read again at once.
  onReadRequested: companyId => minutes.recordsSignal(companyId),
}))
// The title bar's 「あなたの番」 and bell (features/notifications): read with the session here; a Mac
// notification only for an approval request, a new item in あなたの番 or a fresh notice the server marks (E-27).
const notices = createNotificationsWatcher({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChanged: companyId => appWindow.send('notifications:changed', { companyId }),
  watchSignals: companyId => agentControl.watchSignals(companyId),
  // A click brings the window forward; the morning's 「今日のあなたの番」 also opens the task list.
  desktopNotify: (title, body, click) => desktopShell.notify(title, body, () => {
    mainWindowHost.focus()
    if (click.target === 'tasks') appWindow.send('notifications:openTasks', { companyId: click.companyId })
  }),
  shownNotices: fileShownStore(path.join(userDataDir(), 'notices-shown.json')),
})
// The task list re-reads on any records signal (others' changes reaching this member), and at once
// when the member's own AI wrote a record here (recordsChangedHere, given to the chat below).
recordsSignal = companyId => { minutes.recordsSignal(companyId); notices.signal(companyId); appWindow.send('records:changed', { companyId }) }
const recordsChangedHere = (companyId: string) => { notices.signal(companyId); appWindow.send('records:changed', { companyId }) }
noticesSignal = companyId => notices.signal(companyId)
lifecycle.beforeQuit(() => notices.stop())
registerNotificationsIpc(ipc, notices)

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
const googleApi = registerGoogleIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, shell: desktopShell })
// Google Drive (google-drive.md): the person picks in Google Picker's own window; the session stays here.
const drivePicking = createDrivePicking({ baseUrl: getServerApiUrl, cookies: session.cookies, window: createDrivePickerWindow(__dirname), google: googleApi })
// 「今日の予定」 (features/calendar): the member's own meetings today, read by the server with the session here.
registerCalendarIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// The task list (features/tasks): read and changed with the session here; the server decides who may.
registerTasksIpc(ipc, {
  baseUrl: getServerApiUrl, cookies: session.cookies,
  // Tag suggestions: a Haiku model through the company's key (the broker's relay), text only.
  tagSuggest: { brokerEnv: request => brokerTokens.envFor(request), aiAllowed: () => agentControl.stop.oneShotAiAllowed() },
  // 「Google Drive のファイルをつなぐ」 (a company without the shared folder): the Picker flow the AI's tool uses.
  pickDriveFiles: async (companyId, fileIds) => {
    const r = await drivePicking.pick(companyId, 'files', undefined, { fileIds })
    return r.ok ? { ok: true, files: r.picks.filter(p => p.kind === 'file').map(p => ({ id: p.id, name: p.name })) } : { ok: false, cancelled: r.reason === 'cancelled', message: r.message }
  },
  // …offered first from the member's own picked / put files (their names, the member's own).
  driveChoices: async companyId => (await drivePicking.ownFiles(companyId)).map(f => ({ id: f.id, name: f.name, source: f.source })),
})
// The chat card's 「変更前の値を書き戻す」: the person's own action, with the session (never the AI's token).
registerPluginOperationsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Search hits, the record card and a file's 「つながっているもの」 (features/record-views).
registerRecordViewsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// The chat's approval card: approving is the person's own act, with the session (no AI route approves).
registerApprovalsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Settings → 「不在と代わりの人」 (features/absences): the member's own absences, with the session.
registerAbsencesIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Settings → 「定期の仕事」 (features/jobs): the jobs the member is responsible for, with the session.
registerJobsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// 自分の設定 → 「受信を読む」「AI が自動で進める」 (features/work-switches): the member's own, with the session.
registerWorkSwitchesIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// 見られる人 for the lists (features/viewers): with the session.
registerViewersIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// The chat's mail card: drafts edited and sent by the person, with the session (outbound-mail.md).
registerOutboundMailIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, shell: desktopShell })
// The chat AI's read-only company files (company-files/): the session stays
// here in the main process; answers are cached briefly per member.
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })
// Execution runs (S10b): which consultation runs which claimed 「AI の番」; its record tokens are bound to the run.
const aiRunRegistry = createRunRegistry()
// Working folders of companies without the shared company folder (client/shared/company-folder.ts):
// registered by companySetup:openWorkingFolder; no git ever runs in one (services/working-folders.ts).
const workingFolders = createWorkingFolders()
// The app's git (binary, credentials, guarded configuration: services/app-git.ts), refusing working folders.
const appGit = withoutWorkingFolders(createAppGit({ token: session.gitToken, appGitDir: () => path.join(userDataDir(), 'git') }), workingFolders)
// The company's Skills, rules and AI instructions in a working folder (features/skill-shelf): fetched
// when the folder opens and, at most every few minutes, when the AI policy answers.
let skillShelfChanged: (root: string) => void = () => {}
const shelfClient = createShelfClient({ baseUrl: getServerApiUrl, cookies: session.cookies })
const skillShelf = createSkillShelfStore({
  dir: () => path.join(userDataDir(), 'skill-shelf'),
  userId: session.userId,
  client: shelfClient,
  onChanged: (companyId, root) => {
    skillShelfChanged(root)
    appWindow.send('skillShelf:changed', { companyId })
  },
})
agentControl.policy.onPolicy(companyId => skillShelf.poll(companyId))
// Which Skill a consultation used (records.md "Which Skill"): folder name + git tree id (the shelf's version in a working folder), read-only git, never a blob fetched.
const skillUses = createSkillUseReporter({
  baseUrl: getServerApiUrl, cookies: session.cookies, home: os.homedir(), log: console,
  git: (root, args) => appGit.create(root, { GIT_NO_LAZY_FETCH: '1' }).raw(args),
  shelfVersion: (root, rel) => (workingFolders.has(root) ? skillShelf.versionOf(root, rel) : undefined),
})
const recordsApi = createRecordsApi({
  baseUrl: getServerApiUrl, cookies: session.cookies, log: console, runOf: aiRunRegistry.runOf,
  beforeWrite: conversationId => skillUses.settled(conversationId),
})
// 「AI の番」 run automatically (features/ai-turns): the hidden consultation runs in the main
// window; main claims the server's execution run and the record by its version, and settles it afterwards.
// A business plugin's step's pinned procedure (plugin-steps.md): the package C2 keeps, or the company Skill's tree.
const readPluginProcedure = createProcedureReader({
  folderOf: (companyId, pluginId, version) => agentControl.pluginPackages.folderOf(companyId, pluginId, version),
  git: (gitRoot, args) => appGit.create(gitRoot, { GIT_NO_LAZY_FETCH: '1' }).raw(args),
})
const aiTurnClaims = createAiTurnClaims({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  records: recordsApi,
  agent: () => config.authMode(),
  windowOpen: () => { const win = mainWindowHost.window(); return !!win && !win.isDestroyed() },
  aiAllowed: () => agentControl.stop.oneShotAiAllowed(),
  // No person present: an AI turn starts only on a stop policy the server confirmed recently (agent-stop.md).
  stopPolicyConfirmed: companyId => agentControl.stop.stopPolicyConfirmed(companyId),
  runs: aiRunRegistry,
  // This app instance (per launch): the server's claim holder.
  deviceId: `app-${randomUUID()}`,
  // Another PC (or a person) moved the record on: read the notices again rather than in 10 minutes.
  recordMovedOn: companyId => minutes.recordsSignal(companyId),
  readProcedure: readPluginProcedure,
  // 定期の仕事 on this PC (jobs.md "The app's runner"): a shelf Skill's pinned version, checked; new files of a
  // place (a working folder by time, the shared folder by git's history); its AI stopped before the time runs out.
  jobs: {
    readShelfSkill: async (companyId, item, skill, version) => {
      const got = await shelfClient.content(companyId, { id: item, kind: 'skill', name: skill, department: null, version })
      const file = got.ok ? got.files.find(f => f.path === 'SKILL.md') : undefined
      return file ? Buffer.from(file.bytes).toString('utf8') : null
    },
    newFiles: async (companyRoot, place, since, until) => {
      if (!companyRoot) return null
      const root = allowedRoots.validate(companyRoot)
      return workingFolders.has(root)
        ? newFilesByTime(root, place, since, until)
        : newFilesByGit((cwd, args) => appGit.create(cwd, { GIT_NO_LAZY_FETCH: '1' }).raw(args), root, place, since, until)
    },
    stopTurn: conversationId => { chatTurns?.abort(info => info.appSessionId === conversationId, 'job-ended') },
  },
})
registerAiTurnsIpc(ipc, {
  claims: aiTurnClaims,
  isMainWindow: senderId => mainWindowHost.isWindow(senderId),
  paths: allowedRoots,
})
// Lanes (ipc-and-main-process.md "Lane markers"): one line per feature, `register<Feature>Ipc(ipc, { … })`
// or `wire<Feature>(ipc, { … })` from features/<feature>/, right under your lane's ▼.
// lane A ▼
registerSlackIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, shell: desktopShell })
registerThreadsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// A plugin's screen (plugin-frame.md): acb-plugin:// from the verified packages only, and its bridge.
const pluginFiles = createPluginFileServer({ packages: { keptPackage: (id, version, companyId) => agentControl.pluginPackages.keptPackage(id, version, companyId) } })
servePluginFiles(pluginFiles)
registerPluginBridgeIpc(ipc, {
  baseUrl: getServerApiUrl, cookies: session.cookies, isMainWindow: senderId => mainWindowHost.isWindow(senderId),
  keeps: (id, version, companyId) => agentControl.pluginPackages.keptPackage(id, version, companyId) !== null,
})
// The four slots' screens (A6): only verified packages the company lists now.
registerPluginScreensIpc(ipc, {
  listed: async companyId => (agentControl.policy.get(companyId) ?? await agentControl.policy.refresh(companyId, { timeoutMs: 5_000 }))?.plugins ?? null,
  settled: () => agentControl.pluginPackages.idle(),
  declaration: (companyId, ref) => pluginFiles.declaration(companyId, ref),
  isMainWindow: senderId => mainWindowHost.isWindow(senderId),
})
// lane A ▲
// lane B ▼
// lane B ▲
// lane C ▼
registerPluginStepsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, readProcedure: readPluginProcedure, paths: allowedRoots, isWorkingFolder: root => workingFolders.has(root) })
// Where a step's run or consultation may write: its deliverable folder (plugin-steps.md).
const stepWriteAreas = createStepWriteAreas({ baseUrl: getServerApiUrl, cookies: session.cookies, automatic: conversationId => aiTurnClaims.pluginStepWriteArea(conversationId) })
const bindPersonStep = createPersonStepBinder({ baseUrl: getServerApiUrl, cookies: session.cookies })
// lane C ▲

registerAuthIpc(ipc, {
  session,
  serverUrl: getServerApiUrl,
  onSignedOut: () => {
    writeAccessStore.clear()
    agentControl.signedOut()
    brokerTokens.clear()
    companyFilesApi.clear()
    minutes.stop()
    notices.stop()
    // Another account must not find this one's consultations on screen.
    chatWindows.closeAll()
  },
  onSignedIn: () => agentControl.eventSender.sessionStarted(),
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
  workingFolders,
})
syncBeforeClose = gitSync

// Private folders: the 「新しいフォルダ…」 dialog, the lock icons and the guards
// the chat and the file operations ask (features/private-folders).
const privateFolderGuards = wirePrivateFolders(ipc, { serverUrl: getServerApiUrl, session, paths: allowedRoots, pathChecker: gitSync.pathChecker, activity: syncActivity })

// Skills (features/skills).
const skills = registerSkillsIpc(ipc, {
  paths: allowedRoots,
  isShared: (rootPath, relFolder) => skillIsShared(appGit.create(rootPath, { GIT_NO_LAZY_FETCH: '1' }), relFolder),
  skillRefusal: (absPath, options) => privateFolderGuards.skillRefusal(absPath, options),
  isWorkingFolder: rootPath => workingFolders.has(rootPath),
  shelfMark: (rootPath, rel) => (workingFolders.has(rootPath) ? skillShelf.markOf(rootPath, rel) : undefined),
  shelfMayPublish: (rootPath, rel) => (workingFolders.has(rootPath) ? skillShelf.mayPublish(rootPath, rel) : undefined),
  shelfRuleClashes: rootPath => (workingFolders.has(rootPath) ? skillShelf.ruleClashes(rootPath) : []),
  shelfRequest: (rootPath, rel) => (workingFolders.has(rootPath) ? skillShelf.requestOf(rootPath, rel) : undefined),
  shelfBackup: (rootPath, rel) => (workingFolders.has(rootPath) ? skillShelf.latestBackup(rootPath, rel) !== null : undefined),
})
skillShelfChanged = root => skills.invalidateRoot(root)
registerSkillShelfIpc(ipc, { paths: allowedRoots, isWorkingFolder: rootPath => workingFolders.has(rootPath), store: skillShelf, client: shelfClient, shell: desktopShell })

// The company folder on disk (features/fs): file tree, editor, watchers.
const files = registerFsIpc(ipc, {
  paths: allowedRoots,
  shell: desktopShell,
  window: appWindow,
  writeRefusal: absPath => privateFolderGuards.writeRefusal(absPath),
  reservedRefusal: absPath => privateFolderGuards.reservedRefusal(absPath),
  // A skill the AI (or anything else) created, changed or removed is scanned
  // afresh by the next skills:list.
  onFileChanges: changes => skills.invalidateForChanges(changes),
})
lifecycle.beforeQuit(() => files.closeWatchers())

// Setting a company folder up, and what this computer downloads
// (features/company-setup, features/download-choices).
registerCompanySetupIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, userDataDir, home: () => app.getPath('home'), workingFolders, onWorkingFolder: (companyId, folder) => void skillShelf.attach(companyId, folder), workingFolderTaken: (companyId, folder) => skillShelf.takenByAnother(companyId, folder) })
registerDownloadChoicesIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, privateFolders: gitSync, activity: syncActivity })

registerBackupsIpc(ipc, { paths: allowedRoots, shell: desktopShell, writeRefusal: absPath => privateFolderGuards.writeRefusal(absPath) })

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
      recordsChanged: recordsChangedHere,
      skillUses,
      toolApprovals,
      cancelChoicePrompts: appSessionId => agentInteractions.cancelConversation(appSessionId),
      agentEvents: agentControl.events,
      agentPolicy: agentControl.policy,
      agentStop: agentControl.stop,
      serverUrl: getServerApiUrl,
      brokerTokens,
      drivePicking,
      paths: allowedRoots,
      requestInteraction: (request, appSessionId, signal) =>
        requestFromOwner(agentInteractions, webContentsForSession(appSessionId), request, appSessionId, signal),
      runAppCommand: appCommands.run,
      // A scheduled job's run reports its one やること here (jobs.md).
      jobReport: conversationId => aiTurnClaims.jobReporter(conversationId),
      workingFolders,
      skillShelf,
    })
    // A business plugin's step run: only its step's tools (plugin-steps.md), from the claim main holds.
    const result = await startChatServer({
      ...serverConfig,
      pluginStepTools: (conversationId, step) => aiTurnClaims.pluginStepTools(conversationId, step) ?? aiTurnClaims.jobTools(conversationId, step),
      // A person step's consultation: its AI's plugin power is that step's (plugin-steps.md).
      bindPluginStep: async (companyId, conversationId, step) => {
        const bound = await bindPersonStep(companyId, conversationId, step)
        stepWriteAreas.forget(companyId, conversationId)
        return bound
      },
      // A step's run or consultation writes only inside its deliverable folder (plugin-steps.md).
      // A scheduled job's run writes only where its grant says, or nowhere (jobs.md).
      stepWriteArea: (companyId, conversationId) => {
        const job = aiTurnClaims.jobWriteArea(conversationId)
        return job ? Promise.resolve(job) : stepWriteAreas.areaOf(companyId, conversationId)
      },
    })
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

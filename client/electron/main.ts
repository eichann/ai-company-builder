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
import { readCliVersionOutput } from './agents/codex-version'
import { killAgentProcess, spawnAgentProcess } from './agents/process'
import { createClaudeCli } from './services/claude-cli'
import { createClaudeSignIn } from './services/claude-sign-in'
import { createAppPages, createBroadcastPort, createChatWindowHost, createMainWindowHost, createMessageBoxHost, desktopShell, guardEverySession, receiveAppLinks, secretBox, registerLocalFileScheme, serveLocalFiles } from './electron-adapter'
import { createDocViewShell, createDrivePlayerShell } from './doc-view'
import { createDocFrames } from './features/doc-frames/protocol'
import { createDocViews } from './features/doc-frames/views'
import { createDrivePlayers } from './features/doc-frames/players'
import { registerDocViewsIpc } from './features/doc-frames/ipc'
import { createManualSite } from './features/manual/site'
import { registerManualIpc } from './features/manual/ipc'
import { readSparseConfig } from './sync/sparse'
import { diskFiles, registerChatWindowsIpc } from './features/chat-windows/ipc'
import { createSession } from './services/session'
import { createInFlightReads } from './services/in-flight-reads'
import { createPushSignalFanout } from './services/push-signal-fanout'
import { createTurnReads } from './services/turn-reads'
import { createCalendarTodayReads } from './services/calendar-today-reads'
import { registerAuthIpc } from './features/auth/ipc'
import { wireChatHistory } from './features/chat-history/wire'
import { createToolApprovals, registerAgentInteractionsIpc } from './features/agent-interactions/ipc'
import { requestFromOwner } from './features/agent-interactions/owner'
import { wireAgentControl } from './features/agent-control/wire'
import { wirePluginTrust } from './features/plugins/trust-wire'
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
import { driveFolderSharingText, drivePickRefusedText } from '../../shared/core/google-drive'
import { createCalendarApi, registerCalendarIpc } from './features/calendar/ipc'
import { registerTasksIpc } from './features/tasks/ipc'
import { registerPluginOperationsIpc } from './features/plugin-operations/ipc'
import { registerRecordViewsIpc } from './features/record-views/ipc'
import { registerRecordsTableIpc } from './features/records-table/ipc'
import { registerAfterMeetingIpc } from './features/after-meeting/ipc'
import { registerApprovalsIpc } from './features/approvals/ipc'
import { registerAbsencesIpc } from './features/absences/ipc'
import { registerJobsIpc } from './features/jobs/ipc'
import { registerJobProposalsIpc } from './features/jobs/proposals'
import { createJobRepeatAsks, registerJobRepeatAsksIpc } from './features/jobs/repeat-asks'
import { registerWorkSwitchesIpc } from './features/work-switches/ipc'
import { registerViewersIpc } from './features/viewers/ipc'
import { createMinutesChecker } from './features/minutes/checker'
import { registerMinutesIpc } from './features/minutes/ipc'
import { createMeetingsApi } from './features/minutes/meetings'
import { createAiTurnClaims } from './features/ai-turns/claims'
import { gitCheckPoint, gitFetchMark, newFilesByGit, newFilesByTime } from './features/ai-turns/job-runs'
import { createSetWatchFs } from './features/ai-turns/set-watch-run'
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
import { createWritingSourcesApi, createWritingStyles } from './features/writing-style/service'
import { createWritingSummarizer } from './features/writing-style/summarize'
import { registerWritingStyleIpc } from './features/writing-style/ipc'
// lane A ▲
// lane B ▼
// lane B ▲
// lane C ▼
import { createBrowserWindowShell } from './browser-window'
import { createBrowserController } from './features/browser/controller'
import { createKeptLogins, turnEnclosesKeptLogins } from './features/browser/kept-logins'
import { sandboxPlatform } from '../shared/agents/sandbox-policy'
import { removeLeftoverBrowserPartitions } from './features/browser/leftovers'
import { isMainFrameSender, registerBrowserIpc } from './features/browser/ipc'
import { bundledAssetHosts, bundledLoginHelpers, wireBrowserPlans } from './features/browser/wire'
import { developerAssetHostsOn } from '../shared/browser-operation'
import { createRegisteredPcSwitch, createThisPcSwitch } from './features/browser/ai-switch'
import { createBrowserDevice, createBrowserDeviceKey } from './features/browser/device'
import { registerBrowserDeviceIpc } from './features/browser/device-ipc'
import { createBrowserRecordings, createBrowserRecordingsHttp } from './features/browser/recording'
import { createBrowserSkillDraftsHttp } from './features/browser/skill-drafts'
import { registerBrowserRecordingIpc } from './features/browser/recording-ipc'
import { BROWSER_AI_OPT_IN_FILE } from '../shared/browser-ai'
import { lstepConnector } from '../connectors/lstep'
import { lstepReadLines } from '../connector-maps/lstep'
import { LINES as LSTEP_LINES } from '../browser-lines/lstep'
import { wireBrowserInspections } from './features/browser/inspect'
import { wireBrowserWriteLines } from './features/browser/write-lines'
import { wireBrowserBrowse } from './features/browser/browse'
import { wireBrowserWork } from './features/browser/work'
import { createPendingEnds } from './features/browser/pending-ends'
import { readBrowserSkillSteps } from './features/browser/skill-steps'
import { createBrowserLinesHttp } from './features/browser/lines-api'
import { createBrowserRunRecords } from './features/browser/run-records'
import { browserOperatorOf } from './agents/registry'
import { browserAiStopped } from '../../shared/core/browser-operation'
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
// 「Claude にログインする」 starts the member's own `claude auth login`; the CLI keeps the login.
const claudeSignIn = createClaudeSignIn({
  cliPath: () => claudeCli.status().cliPath,
  env: () => shellEnv.env(),
  readVersion: (cli, env) => readCliVersionOutput(cli, env),
  // quiet: the CLI's sign-in output is never logged.
  spawn: (cli, args, env, cwd) => spawnAgentProcess({ command: cli, args, env, cwd, quiet: true }),
  kill: (child, signal) => killAgentProcess(child as ReturnType<typeof spawnAgentProcess>, signal),
  openExternal: url => desktopShell.openExternal(url),
})
lifecycle.beforeQuit(() => claudeSignIn.stop())
registerSettingsIpc(ipc, { config, apiKey, claudeCli, claudeSignIn, paths: allowedRoots, codexStatus: () => getCodexStatus(shellEnv.env()) })

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

// Reads asked at the same moment share one request (services/in-flight-reads.ts; ipc-and-main-process.md
// "Shared reads"): per server × session (a sign-in or sign-out is another one) × company × question.
const inFlightReads = createInFlightReads(() => `${getServerApiUrl()}\n${session.cookies().join('; ')}`)
// 「あなたの番」 / 「AI の番」 for the task list, the title bar's watcher and the received minutes.
const turnReads = createTurnReads({ baseUrl: getServerApiUrl, cookies: session.cookies, reads: inFlightReads })
// The push channel's records / notifications signals of one company, handled once per burst (at most
// SIGNAL_WINDOW_MS later; the change itself is marked at once). Never the stop policy: its own path in agent-control.
const SIGNAL_WINDOW_MS = 250
let recordsSignal: (companyId: string) => void = () => {}
let noticesSignal: (companyId: string) => void = () => {}
const pushSignals = createPushSignalFanout({
  windowMs: SIGNAL_WINDOW_MS,
  changed: companyId => inFlightReads.changed(companyId),
  records: companyId => recordsSignal(companyId),
  noticesOnly: companyId => noticesSignal(companyId),
})
lifecycle.beforeQuit(() => pushSignals.stop())

// The AI policy, the emergency stop (M2) and the AI action log (M1): features/agent-control.
const agentControl = wireAgentControl({
  serverUrl: getServerApiUrl, session, userDataDir, home: os.homedir(), turns: () => chatTurns, lifecycle,
  onRecords: companyId => pushSignals.records(companyId),
  onNotifications: companyId => pushSignals.notifications(companyId),
  onPluginsChanged: companyId => appWindow.send('plugins:changed', { companyId }),
  // Plugin trust P2: the signed lists, kept under <userData>/trust; nothing enforced yet (plugin-trust.md).
  pluginTrust: wirePluginTrust({ userDataDir, serverUrl: getServerApiUrl, session, packaged: app.isPackaged }),
})
// 「議事録が届きました」 (features/minutes): checked with the session here, only while Google may read minutes.
const minutes = createMinutesChecker({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChanged: companyId => appWindow.send('minutes:changed', { companyId }),
  // Found without a signal (a check, the timer, a press): the task list hears it once.
  onAiTurnChanged: companyId => appWindow.send('records:changed', { companyId }),
  aiTurn: turnReads,
  changed: companyId => inFlightReads.changed(companyId),
  watchSignals: companyId => agentControl.watchSignals(companyId),
})
lifecycle.beforeQuit(() => minutes.stop())
registerMinutesIpc(ipc, minutes, createMeetingsApi({
  baseUrl: getServerApiUrl, cookies: session.cookies,
  // ［AI に読ませる］ accepted: the runner's queue (received minutes) is read again at once.
  onReadRequested: companyId => minutes.recheck(companyId),
}))
// The title bar's 「あなたの番」 and bell (features/notifications): read with the session here; a Mac
// notification only for an approval request, a new item in あなたの番 or a fresh notice the server marks (E-27).
const notices = createNotificationsWatcher({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChanged: companyId => appWindow.send('notifications:changed', { companyId }),
  // 「あなたの番」 changed and no records signal had told the task list: it hears it once (records:changed).
  onTurnChanged: companyId => appWindow.send('records:changed', { companyId }),
  myTurn: turnReads,
  watchSignals: companyId => agentControl.watchSignals(companyId),
  // A click brings the window forward; the morning's 「今日のあなたの番」 also opens the task list.
  desktopNotify: (title, body, click) => desktopShell.notify(title, body, () => {
    mainWindowHost.focus()
    if (click.target === 'tasks') appWindow.send('notifications:openTasks', { companyId: click.companyId })
  }),
  shownNotices: fileShownStore(path.join(userDataDir(), 'notices-shown.json')),
})
// The task list re-reads on records signals (others' changes reaching this member; one burst = once), and
// at once when the member's own AI wrote a record here (recordsChangedHere, given to the chat below). A
// `notifications` signal alone only re-reads the title bar (it tells the list itself when 「あなたの番」 changed).
recordsSignal = companyId => { minutes.recordsSignal(companyId); notices.signal(companyId, true); appWindow.send('records:changed', { companyId }) }
noticesSignal = companyId => notices.signal(companyId)
const recordsChangedHere = (companyId: string) => {
  inFlightReads.changed(companyId)
  notices.signal(companyId, true)
  appWindow.send('records:changed', { companyId })
}
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
// Google Drive (google-drive.md): the person picks in Google Picker in their own browser (a one-time pick
// ticket; Google needs a signed-in browser); the session stays here and waits for the result.
const drivePicking = createDrivePicking({ baseUrl: getServerApiUrl, cookies: session.cookies, openBrowser: url => desktopShell.openExternal(url), google: googleApi })
// ACB's own players over a document's Google Drive videos (doc-frame.md "ACB's player over Drive embeds
// (plan 4)"): their own session; the bytes relayed from the server's stream route with the member's
// session (Range forwarded), the one video picked in the member's browser first when the server says so.
const drivePlayers = createDrivePlayers({
  shell: server => createDrivePlayerShell(server),
  stream: (companyId, fileId, range, signal) => fetch(`${getServerApiUrl()}/api/companies/${encodeURIComponent(companyId)}/me/google/drive/view/${encodeURIComponent(fileId)}`, {
    redirect: 'error', signal, headers: { Cookie: session.cookies().join('; '), ...(range ? { Range: range } : {}) },
  }),
  pick: async (companyId, fileId, signal) => {
    const r = await drivePicking.pick(companyId, 'files', signal, { fileIds: [fileId], purpose: 'view' })
    if (!r.ok) return { ok: false, reason: r.reason === 'cancelled' || r.reason === 'timed-out' ? r.reason : 'other', message: r.message }
    return r.picks.some(p => p.id === fileId) ? { ok: true, kept: true } : { ok: true, kept: false, notKept: drivePickRefusedText(r.refused, r.refusedWhy) ?? undefined }
  },
  openExternal: url => desktopShell.openExternal(url),
  notify: (_windowId, event) => appWindow.send('docView:event', event),
})
lifecycle.beforeQuit(() => drivePlayers.closeAll())
// 「今日の予定」 (features/calendar): the member's own meetings today, read by the server with the session here.
// Asked once when the task list and 「確かめること」 ask at the same moment.
const calendarToday = createCalendarTodayReads({ reads: inFlightReads, read: createCalendarApi({ baseUrl: getServerApiUrl, cookies: session.cookies }).today })
registerCalendarIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, today: calendarToday.today })
// The task list (features/tasks): read and changed with the session here; the server decides who may.
registerTasksIpc(ipc, {
  baseUrl: getServerApiUrl, cookies: session.cookies,
  turns: turnReads,
  changed: companyId => inFlightReads.changed(companyId),
  // Tag suggestions: a Haiku model through the company's key (the broker's relay), text only.
  tagSuggest: { brokerEnv: request => brokerTokens.envFor(request), aiAllowed: () => agentControl.stop.oneShotAiAllowed() },
  // 「Google Drive のファイルをつなぐ」 (every company, owner decision 2026-11-13): the Picker flow the AI's tool uses.
  // A pick for linking offers every file type (owner decision 2026-11-14: Word, Excel, images… 「AI では中身を読めません」);
  // what was picked but not kept is said (how many, why), never dropped silently.
  pickDriveFiles: async (companyId, fileIds, signal) => {
    const r = await drivePicking.pick(companyId, 'files', signal, { fileIds, purpose: 'link' })
    if (!r.ok) return { ok: false, ended: r.reason === 'cancelled' || r.reason === 'timed-out' ? r.reason : null, message: r.message }
    const notUsable = drivePickRefusedText(r.refused, r.refusedWhy)
    return { ok: true, files: r.picks.filter(p => p.kind === 'file').map(p => ({ id: p.id, name: p.name })), ...(notUsable ? { notUsable } : {}) }
  },
  // …offered first from the member's own picked / put files (their names, the member's own).
  driveChoices: async companyId => (await drivePicking.ownFiles(companyId)).map(f => ({ id: f.id, name: f.name, source: f.source })),
})
// The chat card's 「変更前の値を書き戻す」: the person's own action, with the session (never the AI's token).
registerPluginOperationsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Search hits, the record card and a file's 「つながっているもの」 (features/record-views).
registerRecordViewsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
registerRecordsTableIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// 「会議のあと」 (4b-4 PR6-A): the run's files on this PC and the card's mark; removable with its feature folder.
registerAfterMeetingIpc(ipc, {
  paths: allowedRoots, baseUrl: getServerApiUrl, cookies: session.cookies,
  recordsRoot: () => path.join(userDataDir(), 'job-set-runs'), marksRoot: () => path.join(userDataDir(), 'after-meeting'),
})
// The chat's approval card: approving is the person's own act, with the session (no AI route approves).
registerApprovalsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Settings → 「不在と代わりの人」 (features/absences): the member's own absences, with the session.
registerAbsencesIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// Member proposals (features/jobs/proposals): the chat card's 「これで管理者に出す」 is the member's own press, with the
// session — no chat-server route, AI tool or record token reaches it (jobs.md "Member proposals").
registerJobProposalsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies })
// 「毎週同じ時間にやりましょうか？」 (features/jobs/repeat-asks): this PC's count of the Skills a member's AI used, never sent anywhere.
const jobRepeatAsks = createJobRepeatAsks({ file: () => path.join(userDataDir(), 'job-repeat-asks.json'), userId: session.userId, home: os.homedir(), log: console })
registerJobRepeatAsksIpc(ipc, jobRepeatAsks)
// Settings → 「定期の仕事」 (features/jobs): the jobs the member is responsible for, with the session.
registerJobsIpc(ipc, {
  baseUrl: getServerApiUrl, cookies: session.cookies,
  // A job's deliverable place outside (jobs.md): Google's kind is a Drive folder the member picks in Google Picker.
  choosePlace: async (companyId, place) => {
    if (place.connector !== 'google' || place.kind !== 'drive_folder') return { ok: false, message: 'このアプリでは、この置き先を選べません。アプリを新しくしてください。' }
    const picked = await drivePicking.pick(companyId, 'folder')
    if (!picked.ok) return { ok: false, message: picked.message }
    const folder = picked.picks.find(p => p.kind === 'folder')
    if (!folder) return { ok: false, message: drivePickRefusedText(picked.refused, picked.refusedWhy) ?? '選んだフォルダを使えませんでした（追加できる権限のあるフォルダを選んでください）。' }
    // A folder seen outside the company (or not known): the job's AI could never put there — said now, not at its first run.
    // The server's put still decides (DRIVE_FOLDER_SHARED_OUTSIDE).
    const outside = driveFolderSharingText(folder.sharing, 'job')
    return outside ? { ok: false, message: outside } : { ok: true, ref: folder.id }
  },
})
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
// A job's run whose token call says the run is over stops its AI (stage 4b-2, jobs.md "Fail closed"): the AI-turn claims
// are made below (they need this API); bound once they exist, long before any turn runs.
let jobRunRefused: (companyId: string, conversationId: string, runId: string, status: number, code: string | undefined) => void = () => {}
const recordsApi = createRecordsApi({
  baseUrl: getServerApiUrl, cookies: session.cookies, log: console, runOf: aiRunRegistry.runOf,
  beforeWrite: conversationId => skillUses.settled(conversationId),
  onRunRefused: (companyId, conversationId, run, status, code) => jobRunRefused(companyId, conversationId, run.id, status, code),
})
// 「AI の番」 run automatically (features/ai-turns): the hidden consultation runs in the main
// window; main claims the server's execution run and the record by its version, and settles it afterwards.
// A business plugin's step's pinned procedure (plugin-steps.md): the package C2 keeps, or the company Skill's tree.
const readPluginProcedure = createProcedureReader({
  folderOf: (companyId, pluginId, version) => agentControl.pluginPackages.folderOf(companyId, pluginId, version),
  git: (gitRoot, args) => appGit.create(gitRoot, { GIT_NO_LAZY_FETCH: '1' }).raw(args),
})
// git for a job's new-files check (no lazy fetch: what is not here is not looked at).
const jobGit = (cwd: string, args: string[]) => appGit.create(cwd, { GIT_NO_LAZY_FETCH: '1' }).raw(args)
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
  recordMovedOn: companyId => minutes.recheck(companyId),
  readProcedure: readPluginProcedure,
  // 定期の仕事 on this PC (jobs.md "The app's runner"): a shelf Skill's pinned version, checked; new files of a
  // place (a working folder by time, the shared folder by git's history); its AI stopped before the time runs out.
  jobs: {
    readShelfSkill: async (companyId, item, skill, version) => {
      const got = await shelfClient.content(companyId, { id: item, kind: 'skill', name: skill, department: null, version })
      const file = got.ok ? got.files.find(f => f.path === 'SKILL.md') : undefined
      return file ? Buffer.from(file.bytes).toString('utf8') : null
    },
    fetchMark: async (companyRoot, place) => {
      if (!companyRoot) return null
      const root = allowedRoots.validate(companyRoot)
      return workingFolders.has(root) ? null : gitFetchMark(jobGit, root, place)
    },
    checkPoint: async (companyRoot, place, mark) => {
      if (!companyRoot) return null
      const root = allowedRoots.validate(companyRoot)
      return workingFolders.has(root) ? { commit: null } : gitCheckPoint(jobGit, root, place, mark)
    },
    newFiles: async (companyRoot, place, window) => {
      if (!companyRoot) return null
      const root = allowedRoots.validate(companyRoot)
      if (workingFolders.has(root)) return newFilesByTime(root, place, window.since, window.until, window.offset)
      return window.upto ? newFilesByGit(jobGit, root, place, { since: window.since, sinceCommit: window.sinceCommit, upto: window.upto }) : null
    },
    stopTurn: conversationId => { chatTurns?.abort(info => info.appSessionId === conversationId, 'job-ended') },
    // A set watch (4b-4 PR5): the pinned Skills' copy and the PC records in the app's data, never the company folder.
    setWatch: createSetWatchFs({
      git: jobGit,
      gitBlob: (root, sha) => appGit.create(root, { GIT_NO_LAZY_FETCH: '1' }).binaryCatFile(['blob', sha]),
      copiesRoot: () => path.join(userDataDir(), 'job-skill-copies'),
      recordsRoot: () => path.join(userDataDir(), 'job-set-runs'),
    }),
  },
})
jobRunRefused = aiTurnClaims.runRefused
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
// 「返事の下書きを、わたしの書き方に合わせる」: summaries of the member's own sent messages, kept on this PC per account and company.
const writingStyles = createWritingStyles({
  dir: () => path.join(userDataDir(), 'writing-style'),
  userId: session.userId,
  session: session.cookies,
  server: createWritingSourcesApi({ baseUrl: getServerApiUrl, cookies: session.cookies }),
  summarize: createWritingSummarizer({
    settings: () => ({ authMode: config.authMode(), apiKey: apiKey.read() }),
    claudeReady: claudeCli.isAuthenticated, getCli: claudeCli.path, getEnv: shellEnv.env,
    cwd: () => path.join(userDataDir(), 'writing-style-work'),
  }),
  aiAllowed: () => agentControl.stop.oneShotAiAllowed(),
})
registerWritingStyleIpc(ipc, writingStyles)
// lane A ▲
// lane B ▼
// lane B ▲
// lane C ▼
registerPluginStepsIpc(ipc, { baseUrl: getServerApiUrl, cookies: session.cookies, readProcedure: readPluginProcedure, paths: allowedRoots, isWorkingFolder: root => workingFolders.has(root) })
// Where a step's run or consultation may write: its deliverable folder (plugin-steps.md).
const stepWriteAreas = createStepWriteAreas({ baseUrl: getServerApiUrl, cookies: session.cookies, automatic: conversationId => aiTurnClaims.pluginStepWriteArea(conversationId) })
const bindPersonStep = createPersonStepBinder({ baseUrl: getServerApiUrl, cookies: session.cookies })
// 「ブラウザ操作」 (agent-browser.md "The app's window"): the member opens a site the company allowed in a
// window of its own and logs in there; the AI is not connected yet. Only a valid policy answer opens anything.
// Its login lives in memory, or is kept on this PC only next to enclosed AI turns (agent-browser.md "Keeping a login on
// disk"): any other browser session an earlier build kept on disk goes first; kept ones are judged from the policy.
removeLeftoverBrowserPartitions(userDataDir())
const lstep = lstepConnector()
const browserShell = createBrowserWindowShell()
const browserPartitionsDir = () => path.join(userDataDir(), 'Partitions')
const keptLogins = createKeptLogins({
  partitionsDir: browserPartitionsDir,
  clearSession: partition => browserShell.clearPartition(partition),
  platformEncloses: sandboxPlatform(process.platform),
  // Never where a company folder is (sync or an enclosed turn would read it there).
  insideCompanyFolder: p => allowedRoots.touches(p),
})
const browser = createBrowserController({
  shell: browserShell,
  kept: keptLogins,
  turnEnclosesKept: turn => turnEnclosesKeptLogins(browserPartitionsDir(), turn),
  // Where a domain's pages load parts from and what its login needs: the company's 「詳しい設定」 of that domain
  // (in the policy); a domain it set nothing for falls back, until step ⑦, to the bundled declaration's, when this
  // build carries it and the approved list approves it. Never the company's free text on the site — a developer
  // setting, honoured only by a development build started with ACB_BROWSER_DEVELOPER_ASSET_HOSTS=1.
  assetHostsOf: bundledAssetHosts([lstep.declaration]),
  loginHelpersOf: bundledLoginHelpers([lstep.declaration]),
  developerAssetHosts: developerAssetHostsOn({ packaged: app.isPackaged }, process.env),
  userId: session.userId,
  onChanged: companyId => appWindow.send('browser:changed', { companyId }),
})
agentControl.policy.onPolicy((companyId, policy) => browser.policyAnswered(companyId, policy))
agentControl.policy.onRefreshFailed((companyId, detail) => browser.policyFailed(companyId, detail))
registerBrowserIpc(ipc, {
  browser,
  // The main window's own page only: not a consultation window, not a frame inside the page.
  fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)),
  refresh: companyId => agentControl.policy.refresh(companyId),
  watch: companyId => agentControl.watchSignals(companyId),
})
// Its plans (agent-browser.md "The card, the IPC and the request tool"): the card's IPC, the runner behind
// ［任せる］ and the request tool's factory. Reading a site, the operator and sending ask the switch (below).
// This PC's registration (agent-browser.md "This PC's registration", D4): the PC's key only in the OS keychain
// (safeStorage through `secretBox`), sent only in the header of the PC routes and the plans' gated steps.
const browserDeviceKey = createBrowserDeviceKey({ box: secretBox, dir: userDataDir, server: getServerApiUrl, log: message => console.log(message) })
const browserDevice = createBrowserDevice({ key: browserDeviceKey, baseUrl: getServerApiUrl, cookies: session.cookies, userId: session.userId, computerName: () => os.hostname() })
registerBrowserDeviceIpc(ipc, { device: browserDevice, fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)) })
agentControl.policy.onPolicy(companyId => browserDevice.refresh(companyId))
// On when this PC is registered and enabled — or, during the transition (D5 removes it), this PC's hand-placed opt-in.
const browserAiSwitch = createRegisteredPcSwitch({
  optIn: createThisPcSwitch({ file: () => path.join(userDataDir(), BROWSER_AI_OPT_IN_FILE), server: getServerApiUrl, userId: session.userId }),
  registered: () => browserDevice.enabledHere(),
})
// 「記録する」 (agent-browser.md "Recording"): the member records the work once in the site's window and sends it to the
// company. In main's memory only; it needs this PC allowed (the switch above) and the site in the policy; this PC's key
// goes only on the send.
const browserRecordings = createBrowserRecordings({
  windows: browser,
  userId: session.userId,
  mayRecord: browserAiSwitch,
  api: createBrowserRecordingsHttp({ baseUrl: getServerApiUrl, cookies: session.cookies, deviceKey: browserDeviceKey.header }),
  changed: companyId => appWindow.send('browser:changed', { companyId }),
})
registerBrowserRecordingIpc(ipc, { recordings: browserRecordings, fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)) })
const browserPlans = wireBrowserPlans(ipc, {
  aiSwitch: browserAiSwitch,
  fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)),
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  deviceKey: browserDeviceKey.header,
  userId: session.userId,
  userDataDir,
  windows: browser,
  stopped: companyId => browserAiStopped(agentControl.policy.stop(companyId)),
  connectors: { declarations: [lstep.declaration], checkers: lstep.checkers, readers: lstep.readers },
  operator: () => browserOperatorOf(config.authMode()),
  cliPath: () => claudeCli.path(),
  parentEnv: () => shellEnv.env(),
})
agentControl.policy.onPolicy((companyId, policy) => browserPlans.context.policyAnswered(companyId, policy.browser))
agentControl.policy.onRefreshFailed(() => browserPlans.context.advance())
lifecycle.beforeQuit(() => browserPlans.context.quitting())
// Its read task on a registered domain (agent-browser.md "The operator's window tools"): the chat's `browser_browse`, the
// operator acting in the member's own window (reading only), the server's gate, lock and run log; the card through the
// inspection card's IPC. The same switch, context and busy windows as the plans.
// Ends of the operator's and frames runs the server did not hear (a network drop): retried until heard or the run's own
// time is over, and sent again before this member's next browser task (agent-browser.md "Letting a domain go").
const browserPendingEnds = createPendingEnds()
const browserBrowses = wireBrowserBrowse({
  aiSwitch: browserAiSwitch,
  userId: session.userId,
  context: browserPlans.context,
  stopped: companyId => browserAiStopped(agentControl.policy.stop(companyId)),
  window: (companyId, host) => browser.browseWindow(companyId, host),
  registered: (companyId, host) => browser.siteNow(companyId, host) !== null,
  // A window closed meanwhile opens again by itself while this app run holds the login (agent-browser.md "The window a run needs").
  openWindow: (companyId, host, signal) => browser.windowForRun(companyId, host, signal),
  api: createBrowserLinesHttp({ baseUrl: getServerApiUrl, cookies: session.cookies, deviceKey: browserDeviceKey.header }),
  operator: () => browserOperatorOf(config.authMode()),
  cliPath: () => claudeCli.path(),
  parentEnv: () => shellEnv.env(),
  busyWindows: browserPlans.busyWindows,
  pendingEnds: browserPendingEnds,
})
// Its write task on a registered domain (agent-browser.md "Writes within frames, in the app", step ⑤b): the chat's
// `browser_work`, the server's frames run (a company Skill's approved declaration, or the plan the member approves on the
// card), the operator in the member's window with every page write held and sent once. The card through the write card's IPC.
const browserWorks = wireBrowserWork({
  aiSwitch: browserAiSwitch,
  userId: session.userId,
  context: browserPlans.context,
  stopped: companyId => browserAiStopped(agentControl.policy.stop(companyId)),
  window: (companyId, host) => browser.browseWindow(companyId, host),
  reader: (companyId, host) => browser.previewWindow(companyId, host),
  registered: (companyId, host) => browser.siteNow(companyId, host) !== null,
  openWindow: (companyId, host, signal) => browser.windowForRun(companyId, host, signal),
  api: createBrowserLinesHttp({ baseUrl: getServerApiUrl, cookies: session.cookies, deviceKey: browserDeviceKey.header }),
  operator: () => browserOperatorOf(config.authMode()),
  cliPath: () => claudeCli.path(),
  parentEnv: () => shellEnv.env(),
  // A Skill's steps from the member's own company folder (the name is a valid Skill name; every path through the allowed roots).
  skillSteps: (companyRoot, skill) => readBrowserSkillSteps(companyRoot, skill, p => allowedRoots.validate(p)),
  busyWindows: browserPlans.busyWindows,
  pendingEnds: browserPendingEnds,
})
// Its read-only inspection (agent-browser.md "The inspection in the chat"): the chat's `browser_inspect`, the read runner
// over the member's own window and the card's IPC — the same switch and context as the plans; the site's map and lines are
// handed in here only (architecture-boundaries.test.ts).
const lstepLines = lstepReadLines()
const browserInspections = wireBrowserInspections(ipc, {
  aiSwitch: browserAiSwitch,
  fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)),
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  deviceKey: browserDeviceKey.header,
  userId: session.userId,
  context: browserPlans.context,
  stopped: companyId => browserAiStopped(agentControl.policy.stop(companyId)),
  window: (companyId, host) => browser.previewWindow(companyId, host),
  openWindow: (companyId, host, signal) => browser.windowForRun(companyId, host, signal),
  siteLevel: (companyId, host) => browser.siteNow(companyId, host)?.level ?? null,
  sites: [{ map: lstepLines.map, readers: lstepLines.readers, addresses: lstepLines.addresses, account: lstepLines.account }],
  lines: LSTEP_LINES,
  declarations: [lstep.declaration],
  // An operator run's card (`bo_…`) is the browse wiring's (above), or a write task's stopped preview (the work wiring's).
  runCard: (userId, companyId, runId) => browserBrowses.card(userId, companyId, runId) ?? browserWorks.previewCard(userId, companyId, runId),
})
// Its writes on the new path (agent-browser.md "Writing on the new path"): the chat's `browser_write` proposes, the member
// confirms each value and presses ［任せる］ on the card, the write runner writes in order. No site has writers yet (they
// come with the owner's test write, PR 7), so every line that writes is refused before anything is read.
const browserWrites = wireBrowserWriteLines(ipc, {
  aiSwitch: browserAiSwitch,
  // A write card is pressed only from a window showing its consultation: the chat windows' registry and its one rule.
  cardWindows: chatWindows,
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  deviceKey: browserDeviceKey.header,
  userId: session.userId,
  context: browserPlans.context,
  stopped: companyId => browserAiStopped(agentControl.policy.stop(companyId)),
  siteLevel: (companyId, host) => browser.siteNow(companyId, host)?.level ?? null,
  windows: browser,
  records: createBrowserRunRecords(path.join(userDataDir(), 'browser-runs', 'line-records.json')),
  busyWindows: browserPlans.busyWindows,
  sites: [{ map: lstepLines.map, readers: lstepLines.readers, addresses: lstepLines.addresses, account: lstepLines.account, writers: {} }],
  lines: LSTEP_LINES,
  declarations: [lstep.declaration],
  // A write run's card (`bf_…`) is the work wiring's (above).
  frameCards: {
    card: (companyId, runId) => browserWorks.card(companyId, runId),
    approve: (companyId, runId, planHash) => browserWorks.approve(companyId, runId, planHash),
    cancel: (companyId, runId) => browserWorks.cancel(companyId, runId),
    confirm: (companyId, runId, answer) => browserWorks.confirm(companyId, runId, answer),
    placeOf: (companyId, runId) => browserWorks.placeOf(companyId, runId),
  },
})
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
    // Signals still waiting were the previous account's.
    pushSignals.stop()
    // Another account must not find this one's consultations on screen.
    chatWindows.closeAll()
    // …nor this one's site logins (「ブラウザ操作」).
    browser.signedOut()
    browserPlans.context.advance()
    browserInspections.clear()
    browserBrowses.clear()
    browserWorks.clear()
    browserPendingEnds.clear()
    browserWrites.clear()
    browserDevice.clear()
    browserRecordings.clear()
    // …nor play this one's Drive videos (ACB's players over documents; their streams are aborted).
    drivePlayers.closeAll()
  },
  onSignedIn: userId => {
    agentControl.eventSender.sessionStarted()
    browser.signedIn(userId)
    browserPlans.context.advance()
  },
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

// The HTML viewer (doc-frame.md): each document in a view of its own on the document session, which
// alone serves acb-doc:// — only that document's folder, granted to that view and revoked with it.
const docFrames = createDocFrames({ paths: allowedRoots, notDownloaded: root => readSparseConfig(root).excluded })
// Views open in the main window only (the IPC's sender check), so their events go to it.
const docViews = createDocViews({
  frames: docFrames,
  shell: createDocViewShell({ serve: request => docFrames.serve(request) }),
  notify: (_windowId, event) => appWindow.send('docView:event', event),
  players: drivePlayers,
})
registerDocViewsIpc(ipc, {
  frames: docFrames,
  views: docViews,
  fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)),
  openExternal: url => desktopShell.openExternal(url),
})
// The user manual (files-and-editor.md "The user manual"): this computer's copy of the server's /manual/,
// shown through the same document views (a grant for that copy alone) and written only outside company folders.
registerManualIpc(ipc, {
  site: createManualSite({ serverUrl: getServerApiUrl, cookies: session.cookies, cacheRoot: path.join(userDataDir(), 'manual') }),
  views: docViews,
  fromMainWindow: event => isMainFrameSender(event, id => mainWindowHost.isWindow(id)),
  chooseFolder: options => desktopShell.selectSavePath(options),
  defaultFolder: () => app.getPath('downloads'),
  insideCompanyFolder: target => allowedRoots.touches(target),
})

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
      jobRepeatAsks,
      toolApprovals,
      cancelChoicePrompts: appSessionId => agentInteractions.cancelConversation(appSessionId),
      agentEvents: agentControl.events,
      agentPolicy: agentControl.policy,
      browserPlans,
      browserInspections,
      browserBrowses: {
        available: browserBrowses.available,
        domains: companyId => browser.sites(companyId).sites.map(s => s.host),
        browse: input => browserBrowses.browse(input),
      },
      browserWorks: { available: browserWorks.available, work: input => browserWorks.work(input) },
      // The member's own Skill drafts from their own recordings (agent-browser.md "A Skill's draft from a recording"):
      // the session only, beside `browser_work`.
      browserSkillDrafts: { available: browserWorks.available, ...createBrowserSkillDraftsHttp({ baseUrl: getServerApiUrl, cookies: session.cookies }) },
      browserWrites,
      agentStop: agentControl.stop,
      serverUrl: getServerApiUrl,
      brokerTokens,
      drivePicking,
      writingStyle: companyId => writingStyles.forTurn(companyId),
      paths: allowedRoots,
      requestInteraction: (request, appSessionId, signal) =>
        requestFromOwner(agentInteractions, webContentsForSession(appSessionId), request, appSessionId, signal),
      runAppCommand: appCommands.run,
      // A scheduled job's run reports its one やること here (jobs.md).
      jobReport: conversationId => aiTurnClaims.jobReporter(conversationId),
      // …and the only place its drive_put may read a file from (its deliverable area).
      jobWriteArea: conversationId => aiTurnClaims.jobWriteArea(conversationId),
      // …a set watch's run folder and judgement (4b-4 PR5), and the minutes its quotes are checked against.
      jobSetTools: conversationId => aiTurnClaims.jobSetTools(conversationId),
      // …and whether its grant puts into a place outside (only then does its turn ask that connector anything).
      jobDelivery: conversationId => aiTurnClaims.jobDelivery(conversationId),
      jobMinutesRead: (conversationId, recordId, text, docVersion) => aiTurnClaims.jobMinutesRead(conversationId, recordId, text, docVersion),
      runBound: (companyId, conversationId) => aiRunRegistry.runOf(companyId, conversationId) !== null,
      workingFolders,
      skillShelf,
      // Every AI turn: a site login kept on this PC goes first unless the turn is enclosed (agent-browser.md).
      beforeAiTurn: turn => browser.beforeAiTurn(turn),
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
